import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { readProcessIdentity } from "@openclaw/proc-safe/identity";
import { z } from "zod";
import { resolveStateDir } from "../config/state-dir.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import {
  GatewayProcessNamespaceSchema,
  readGatewayLockProcessNamespace,
} from "../infra/gateway-lock-payload.js";
import {
  captureGatewayStateOwner,
  tryBorrowGatewayStateOwner,
} from "../infra/gateway-state-owner.js";
import { mergeProcessEnv } from "../infra/process-env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { runExec, runUtf8CommandWithTimeout } from "../process/exec.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { parseMcpDockerCommand } from "./mcp-docker-command.js";

const log = createSubsystemLogger("mcp/docker");

const STATE = "openclaw.mcp.state";
const GATEWAY = "openclaw.mcp.gateway";
const LAUNCH = "openclaw.mcp.launch";
const containerIdPattern = /^[a-f0-9]{64}$/u;
const ownerSchema = z.object({
  instance: z.string().min(1),
  namespace: GatewayProcessNamespaceSchema,
  process: z.object({
    pid: z.number().int().positive(),
    startTimeMicros: z.number().finite(),
    startTimeSinceBootMicros: z.number().finite().optional(),
  }),
  daemon: z.string().min(1),
});
type Owner = z.infer<typeof ownerSchema>;
type Engine = {
  command: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  daemon: string;
  assertCurrent: () => void;
};
const containerSchema = z.object({
  Id: z.string().regex(containerIdPattern),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
});
type Container = z.infer<typeof containerSchema>;

function custodyContext() {
  const owner = captureGatewayStateOwner(resolveOpenClawStateSqlitePath());
  if (!owner?.ownerId) {
    throw new Error("Docker MCP custody requires exclusive OpenClaw state ownership");
  }
  const namespace = readGatewayLockProcessNamespace();
  const identity = readProcessIdentity(process.pid);
  if (!namespace || !identity || identity.exited) {
    throw new Error("Docker MCP custody could not establish the current Gateway process identity");
  }
  return {
    instance: owner.ownerId,
    namespace,
    process: identity,
    assertCurrent: owner.assertCurrent,
  };
}

async function stateNamespace(): Promise<string> {
  return createHash("sha256")
    .update(await fs.realpath(resolveStateDir()))
    .digest("hex");
}

async function command(
  engine: Pick<Engine, "command" | "env" | "cwd">,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await runExec(engine.command, args, {
    baseEnv: engine.env,
    cwd: engine.cwd,
    timeoutMs: 10_000,
    logOutput: false,
    signal,
  });
  return result.stdout.trim();
}

async function engineFor(
  binary: string,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
  cwd?: string,
): Promise<Engine> {
  const executable = resolveExecutablePath(binary, { env, cwd });
  if (!executable) {
    throw new Error("Docker MCP executable is unavailable");
  }
  const initial = { command: executable, env, cwd };
  // Keep a named context so Docker preserves its TLS credentials as well as
  // its endpoint. A later `docker context use` must not redirect this launch.
  const pinnedEnv = { ...env };
  if (!env.DOCKER_CONTEXT && !env.DOCKER_HOST) {
    pinnedEnv.DOCKER_CONTEXT = await command(initial, [
      "context",
      "inspect",
      "--format",
      "{{.Name}}",
    ]);
    if (!pinnedEnv.DOCKER_CONTEXT) {
      throw new Error("Docker MCP daemon context is unknown");
    }
  }
  const pinned = { command: executable, env: pinnedEnv, cwd };
  const daemon = await command(pinned, ["info", "--format", "{{.ID}}"]);
  if (!daemon || daemon === "<no value>") {
    throw new Error("Docker MCP daemon identity is unknown");
  }
  assertCurrent();
  return { ...pinned, daemon, assertCurrent };
}

async function assertDaemon(engine: Engine): Promise<void> {
  if ((await command(engine, ["info", "--format", "{{.ID}}"])) !== engine.daemon) {
    throw new Error("Docker MCP daemon identity changed; container cleanup was refused");
  }
  engine.assertCurrent();
}

function isMissingContainer(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    /no such (?:object|container)/iu.test(error.stderr),
  );
}

async function inspect(engine: Engine, id: string): Promise<Container | undefined> {
  try {
    const value = containerSchema.parse(
      JSON.parse(
        await command(engine, ["inspect", "--type", "container", "--format", "{{json .}}", id]),
      ),
    );
    if (value.Id !== id) {
      throw new Error("Docker MCP returned invalid container identity");
    }
    return value;
  } catch (error) {
    // Docker reports a missing exact ID as an ordinary command failure.
    if (isMissingContainer(error)) {
      return undefined;
    }
    throw error;
  }
}

async function confirmAbsent(engine: Engine, id: string): Promise<boolean> {
  await assertDaemon(engine);
  return (await inspect(engine, id)) === undefined;
}

async function settleRemovalError(engine: Engine, id: string, error: unknown): Promise<boolean> {
  if (isMissingContainer(error) || (await confirmAbsent(engine, id))) {
    return true;
  }
  if (
    !error ||
    typeof error !== "object" ||
    !("stderr" in error) ||
    typeof error.stderr !== "string" ||
    !error.stderr.includes(`removal of container ${id} is already in progress`)
  ) {
    return false;
  }

  // --rm can still be deleting the container after stop returns. Join that
  // daemon operation; neither its error nor a still-present inspect proves removal.
  const stop = new AbortController();
  let output = "";
  let destroyed = false;
  const result = await runUtf8CommandWithTimeout(
    [
      engine.command,
      "events",
      "--since",
      "0",
      "--filter",
      `container=${id}`,
      "--filter",
      "event=destroy",
      "--format",
      "{{.Actor.ID}}",
    ],
    {
      baseEnv: engine.env,
      cwd: engine.cwd,
      input: "",
      timeoutMs: 10_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      signal: stop.signal,
      onOutputChunk(chunk, stream) {
        if (stream === "stdout") {
          output += chunk.toString("utf8");
          if (output.split(/\r?\n/u).includes(id)) {
            destroyed = true;
            stop.abort();
          }
        }
      },
    },
  );
  if (result.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  if (
    !destroyed ||
    (result.termination !== "signal" && !(result.termination === "exit" && result.code === 0))
  ) {
    throw new Error(`Docker MCP removal could not be confirmed: ${result.stderr.trim()}`);
  }
  return await confirmAbsent(engine, id);
}

async function remove(
  engine: Engine,
  id: string,
  expected: Record<string, string>,
  forceSignal?: AbortSignal,
): Promise<void> {
  await assertDaemon(engine);
  const container = await inspect(engine, id);
  if (!container) {
    return;
  }
  if (Object.entries(expected).some(([key, value]) => container.Config.Labels[key] !== value)) {
    throw new Error("Docker MCP container labels changed; cleanup was refused");
  }
  engine.assertCurrent();
  if (!forceSignal?.aborted) {
    try {
      // Match stdio's grace with the container's stop signal. Force escalation
      // can interrupt the wait without restarting the disposal deadline.
      await command(engine, ["stop", "-t", "2", id], forceSignal);
    } catch (error) {
      if (isMissingContainer(error)) {
        return;
      }
      if (!forceSignal?.aborted) {
        if (await settleRemovalError(engine, id, error)) {
          return;
        }
        throw error;
      }
    }
  }
  await assertDaemon(engine);
  try {
    await command(engine, ["rm", "--force", id]);
  } catch (error) {
    if (!(await settleRemovalError(engine, id, error))) {
      throw error;
    }
  }
}

async function list(engine: Engine, labels: Record<string, string>): Promise<string[]> {
  const output = await command(engine, [
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    ...Object.entries(labels).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`]),
  ]);
  const ids = output ? output.split(/\s+/u) : [];
  if (ids.some((id) => !containerIdPattern.test(id))) {
    throw new Error("Docker MCP returned invalid container IDs");
  }
  return ids;
}

function ownerIsDead(owner: Owner, current: ReturnType<typeof custodyContext>): boolean {
  const previous = owner.namespace;
  const next = current.namespace;
  if (previous.host !== next.host || previous.platform !== next.platform) {
    return false;
  }
  if (previous.identity !== next.identity) {
    return true;
  }
  if (
    previous.platform === "linux" &&
    next.platform === "linux" &&
    previous.pidNsInode !== next.pidNsInode
  ) {
    return false;
  }
  const identity = readProcessIdentity(owner.process.pid);
  if (!identity || identity.exited) {
    return true;
  }
  return owner.process.startTimeSinceBootMicros !== undefined
    ? identity.startTimeSinceBootMicros !== owner.process.startTimeSinceBootMicros
    : identity.startTimeMicros !== owner.process.startTimeMicros;
}

function decodeOwner(value: string | undefined): Owner | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return ownerSchema.safeParse(JSON.parse(value)).data;
  } catch {
    return undefined;
  }
}

/** Recovery only inspects the configured daemon and never treats unknown owners as dead. */
export async function recoverMcpDockerContainers(
  binary: string,
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<void> {
  try {
    const current = custodyContext();
    const engine = await engineFor(
      binary,
      mergeProcessEnv([getDefaultEnvironment(), env]),
      current.assertCurrent,
      cwd,
    );
    const state = await stateNamespace();
    for (const id of await list(engine, { [STATE]: state })) {
      try {
        const container = await inspect(engine, id);
        if (!container) {
          continue;
        }
        const labels = container.Config.Labels;
        const owner = decodeOwner(labels[GATEWAY]);
        if (!owner || !labels[LAUNCH] || owner.daemon !== engine.daemon) {
          log.warn(
            `Docker MCP recovery retained ${id}: ownership or daemon identity could not be verified`,
          );
          continue;
        }
        if (owner.instance === current.instance) {
          continue;
        }
        if (!ownerIsDead(owner, current)) {
          log.warn(
            `Docker MCP recovery retained ${id}: the previous process is alive or cannot be verified`,
          );
          continue;
        }
        await remove(engine, id, {
          [STATE]: state,
          [GATEWAY]: labels[GATEWAY]!,
          [LAUNCH]: labels[LAUNCH]!,
        });
      } catch {
        log.warn(
          `Docker MCP recovery could not reclaim ${id}; inspect the Docker daemon and process owner`,
        );
      }
    }
  } catch {
    log.warn(
      "Docker MCP recovery could not verify the daemon or process owner; containers were retained",
    );
  }
}

/** The CID file is Docker's external-tool contract; persistent custody lives in labels. */
export async function prepareMcpDockerLaunch(
  parsed: Extract<ReturnType<typeof parseMcpDockerCommand>, { kind: "docker" }>,
  env: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const current = custodyContext();
  const retained = tryBorrowGatewayStateOwner(resolveOpenClawStateSqlitePath());
  if (!retained) {
    throw new Error("Docker MCP custody could not retain state ownership");
  }
  try {
    const engine = await engineFor(parsed.command, env, retained.assertCurrent, cwd);
    const state = await stateNamespace();
    const launch = randomUUID();
    const labels = {
      [STATE]: state,
      [GATEWAY]: JSON.stringify({
        instance: current.instance,
        namespace: current.namespace,
        process: {
          pid: current.process.pid,
          startTimeMicros: current.process.startTimeMicros,
          startTimeSinceBootMicros: current.process.startTimeSinceBootMicros,
        },
        daemon: engine.daemon,
      }),
      [LAUNCH]: launch,
    };
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-docker-"));
    const cidfile = path.join(directory, "container.cid");
    let id: string | undefined;
    let closing: Promise<void> | undefined;
    let confirmed = false;
    let onChange: (() => void) | undefined;
    const force = new AbortController();
    return {
      assertCurrent: current.assertCurrent,
      command: engine.command,
      env: engine.env,
      args: [
        "run",
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        "--cidfile",
        cidfile,
        ...(parsed.hasName ? [] : ["--name", `openclaw-mcp-${launch}`]),
        ...parsed.args.slice(1),
      ],
      force() {
        if (confirmed || force.signal.aborted) {
          return;
        }
        force.abort();
        onChange?.();
      },
      close(exited?: Promise<unknown>) {
        return (closing ??= (async () => {
          const changed = () => onChange?.();
          let watcher: FSWatcher | undefined;
          let cidWatcher: FSWatcher | undefined;
          let watchError: Error | undefined;
          let pendingWarning = false;

          let ended = false;
          if (exited) {
            void exited.then(
              () => {
                ended = true;
                changed();
              },
              // Lost exit identity is unknown; keep watching for a late CID.
              changed,
            );
          }
          try {
            watcher = watch(directory, changed);
            watcher.on("error", (error) => {
              watchError = error;
              changed();
            });
            while (!id) {
              const event = new Promise<void>((resolve) => {
                onChange = resolve;
              });
              if (watchError) {
                throw watchError;
              }
              if (!cidWatcher) {
                try {
                  // Docker creates an empty CID file before pulling. macOS does
                  // not report its later content write through a directory watch.
                  cidWatcher = watch(cidfile, changed);
                  cidWatcher.on("error", (error) => {
                    watchError = error;
                    changed();
                  });
                } catch (error) {
                  if (extractErrorCode(error) !== "ENOENT") {
                    throw error;
                  }
                }
              }
              const bytes = await fs.readFile(cidfile, "utf8").catch((error: unknown) => {
                if (extractErrorCode(error) === "ENOENT") {
                  return "";
                }
                throw error;
              });
              if (containerIdPattern.test(bytes.trim())) {
                id = bytes.trim();
                break;
              }
              if (ended) {
                break;
              }
              // The MCP deadline bounds reporting, not resource custody. Killing
              // this client before creation settles can orphan a later container.
              if (force.signal.aborted && !pendingWarning) {
                pendingWarning = true;
                log.warn(
                  `Docker MCP launch ${launch} has not published its container ID; retaining its client and exclusive state ownership until Docker settles. Inspect the Docker daemon if cleanup remains pending.`,
                );
              }
              await event;
            }
            const ids = id ? [id] : await list(engine, labels);
            for (const containerId of ids) {
              await remove(engine, containerId, labels, force.signal);
            }
            confirmed = true;
          } catch (error) {
            log.warn(
              `Docker MCP launch ${launch} cleanup is unconfirmed; exclusive state ownership is retained: ${formatErrorMessage(error)}. Inspect Docker and restart this OpenClaw process before retrying.`,
            );
            throw error;
          } finally {
            cidWatcher?.close();
            watcher?.close();
            if (confirmed) {
              try {
                await fs.rm(directory, { recursive: true, force: true });
              } finally {
                retained.release();
              }
            }
          }
        })());
      },
    };
  } catch (error) {
    retained.release();
    throw error;
  }
}
