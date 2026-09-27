// Crabbox owns provider admission and execution; the shared remote-shell backend
// owns workspace seeding, skills, workdir validation, and file operations.
import { runCommandWithTimeout, type SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import {
  createRemoteShellSandboxBackend,
  createRemoteShellSandboxSession,
  getSandboxBackendWorkdirResolver,
  SandboxRuntimeRetiredError,
  type CreateSandboxBackendParams,
  type ReservedSandboxBackendFactoryV1,
  type SandboxBackendManager,
} from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCrabboxBinary } from "./crabbox-binary.js";
import type { ResolvedCrabboxSandboxConfig } from "./crabbox-sandbox-config.js";
import { CRABBOX_SANDBOX_LEASE_ID_PATTERN } from "./crabbox-sandbox-lease.js";

export const CRABBOX_SANDBOX_BACKEND_ID = "crabbox";
const CRABBOX_SANDBOX_SLUG = "openclaw-sandbox";
const READY_STATES = new Set(["started", "running", "ready"]);

type CrabboxSandboxCommandRunner = (
  argv: string[],
  options: {
    cwd?: string;
    killProcessTree: boolean;
    maxOutputBytes: number;
    timeoutMs: number;
  },
) => Promise<SpawnResult>;

export type CrabboxSandboxBackendDependencies = {
  openclawRoot: string;
  pluginConfig: ResolvedCrabboxSandboxConfig;
  runCommand?: CrabboxSandboxCommandRunner;
};

type CrabboxSandboxClient = {
  binary: string;
  pluginConfig: ResolvedCrabboxSandboxConfig;
  runCommand: CrabboxSandboxCommandRunner;
  execSupport?: Promise<void>;
};

function configLabel(config: ResolvedCrabboxSandboxConfig): string {
  return `${config.provider ?? "configured"}/${config.class ?? "default"}`;
}

function createClient(dependencies: CrabboxSandboxBackendDependencies): CrabboxSandboxClient {
  return {
    binary: resolveCrabboxBinary({
      explicit: dependencies.pluginConfig.binary,
      openclawRoot: dependencies.openclawRoot,
    }),
    pluginConfig: dependencies.pluginConfig,
    runCommand: dependencies.runCommand ?? runCommandWithTimeout,
  };
}

async function runCrabbox(
  client: CrabboxSandboxClient,
  action: string,
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
): Promise<SpawnResult> {
  let result: SpawnResult;
  try {
    result = await client.runCommand([client.binary, ...args], {
      ...(cwd ? { cwd } : {}),
      killProcessTree: true,
      maxOutputBytes: 64 * 1024,
      timeoutMs,
    });
  } catch (error) {
    throw new Error(
      `Crabbox sandbox ${action} could not start: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (result.code !== 0) {
    // Warmup can print token-bearing SSH commands even when a later step fails.
    const detail =
      action === "warmup"
        ? `exit ${String(result.code)}`
        : result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
    throw new Error(`Crabbox sandbox ${action} failed: ${detail}`);
  }
  return result;
}

async function requireExecSupport(client: CrabboxSandboxClient, cwd: string): Promise<void> {
  client.execSupport ??= runCrabbox(
    client,
    "exec capability",
    [
      "exec",
      "--check",
      ...(client.pluginConfig.provider ? ["--provider", client.pluginConfig.provider] : []),
    ],
    cwd,
    10_000,
  )
    .then((result) => {
      const capability: unknown = JSON.parse(result.stdout);
      if (
        !isRecord(capability) ||
        capability.execution !== true ||
        capability.currentRepoStop !== true
      ) {
        throw new Error("The configured provider lacks repository-owned execution or cleanup.");
      }
    })
    .catch((error: unknown) => {
      client.execSupport = undefined;
      throw new Error(
        "Crabbox sandbox requires a build with claim-owned `crabbox exec` and repository-scoped cleanup for the configured provider. Upgrade Crabbox or select a supported provider before provisioning.",
        { cause: error },
      );
    });
  await client.execSupport;
}

async function inspectLease(client: CrabboxSandboxClient, leaseId: string, cwd?: string) {
  const result = await runCrabbox(
    client,
    "inspect",
    ["inspect", "--id", leaseId, "--json"],
    cwd,
    60_000,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Crabbox sandbox inspect returned invalid JSON for ${leaseId}`);
  }
  if (!isRecord(parsed) || parsed.id !== leaseId) {
    throw new Error(`Crabbox sandbox inspect did not return the requested lease ${leaseId}`);
  }
  const state = typeof parsed.state === "string" ? parsed.state : "";
  return { state, ready: parsed.ready === true || READY_STATES.has(state) };
}

async function ensureLease(client: CrabboxSandboxClient, leaseId: string, cwd: string) {
  await requireExecSupport(client, cwd);
  const config = client.pluginConfig;
  await runCrabbox(
    client,
    "warmup",
    [
      "warmup",
      ...(config.provider ? ["--provider", config.provider] : []),
      ...(config.class ? ["--class", config.class] : []),
      "--lease-id",
      leaseId,
      "--slug",
      CRABBOX_SANDBOX_SLUG,
      "--keep",
      ...(config.ttl ? ["--ttl", config.ttl] : []),
      ...(config.idleTimeout ? ["--idle-timeout", config.idleTimeout] : []),
    ],
    cwd,
    10 * 60_000,
  );
  const lease = await inspectLease(client, leaseId, cwd);
  if (!lease.ready) {
    throw new Error(`Crabbox lease ${leaseId} is not ready (state=${lease.state || "unknown"})`);
  }
}

async function stopLease(client: CrabboxSandboxClient, leaseId: string, cwd?: string) {
  await runCrabbox(client, "stop", ["stop", "--current-repo", "--id", leaseId], cwd, 5 * 60_000);
}

export function createCrabboxSandboxBackendFactory(
  dependencies: CrabboxSandboxBackendDependencies,
): ReservedSandboxBackendFactoryV1 {
  const client = createClient(dependencies);
  return async (params) => {
    if ((params.cfg.docker.binds?.length ?? 0) > 0) {
      throw new Error("Crabbox sandbox backend does not support sandbox.docker.binds.");
    }
    const { runtimeId, assertRuntimeCurrent, workspaceDir } = params;
    if (!CRABBOX_SANDBOX_LEASE_ID_PATTERN.test(runtimeId)) {
      throw new Error("Crabbox sandbox requires a fixed lease runtime ID.");
    }
    assertRuntimeCurrent();
    await requireExecSupport(client, workspaceDir);
    assertRuntimeCurrent();
    try {
      await ensureLease(client, runtimeId, workspaceDir);
    } catch (error) {
      const lease = await inspectLease(client, runtimeId, workspaceDir).catch(() => undefined);
      if (lease?.state === "released") {
        throw new SandboxRuntimeRetiredError(runtimeId);
      }
      throw error;
    }
    assertRuntimeCurrent();
    return createRemoteShellSandboxBackend(params, {
      backendId: CRABBOX_SANDBOX_BACKEND_ID,
      runtimeId,
      configLabel: configLabel(client.pluginConfig),
      configLabelKind: "Lease",
      createSession: async () =>
        createRemoteShellSandboxSession({
          assertCurrent: assertRuntimeCurrent,
          buildCommand: ({ remoteCommand, tty }) => ({
            argv: [
              client.binary,
              "exec",
              "--id",
              runtimeId,
              ...(tty ? ["--pty"] : []),
              "--",
              "/bin/sh",
              "-c",
              remoteCommand,
            ],
            // Credentials belong to the local provider owner. Remote command
            // environment is staged separately by the shared shell backend.
            env: process.env,
            cwd: workspaceDir,
          }),
        }),
    });
  };
}

export function createCrabboxSandboxBackendManager(
  dependencies: CrabboxSandboxBackendDependencies,
): SandboxBackendManager {
  const client = createClient(dependencies);
  const label = configLabel(client.pluginConfig);
  return {
    async describeRuntime({ entry }) {
      if (!CRABBOX_SANDBOX_LEASE_ID_PATTERN.test(entry.containerName)) {
        return { running: false, configLabelMatch: false };
      }
      try {
        const lease = await inspectLease(client, entry.containerName, entry.workspaceDir);
        return {
          running: lease.ready,
          actualConfigLabel: entry.image,
          configLabelMatch: entry.image === label,
        };
      } catch {
        return { running: false, actualConfigLabel: entry.image, configLabelMatch: false };
      }
    },
    async removeRuntime({ entry }) {
      if (!CRABBOX_SANDBOX_LEASE_ID_PATTERN.test(entry.containerName)) {
        throw new Error(`Crabbox sandbox runtime ${entry.containerName} is not a fixed lease id`);
      }
      try {
        await stopLease(client, entry.containerName, entry.workspaceDir);
      } catch (error) {
        if (entry.runtimeState !== "removing-pending" || !entry.workspaceDir) {
          throw error;
        }
        await ensureLease(client, entry.containerName, entry.workspaceDir);
        await stopLease(client, entry.containerName, entry.workspaceDir);
      }
    },
  };
}

export function resolveCrabboxSandboxWorkdir(params: CreateSandboxBackendParams): string {
  const resolver = getSandboxBackendWorkdirResolver("ssh");
  if (!resolver) {
    throw new Error("Crabbox sandbox backend requires the shared remote workspace layout");
  }
  return resolver({ ...params, cfg: { ...params.cfg, backend: "ssh" } });
}
