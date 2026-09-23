import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { execContainerRaw, type ExecContainerRawOptions } from "./container-engine.js";
import {
  removeSandboxContainerRuntime,
  withSandboxContainerLifecycle,
} from "./container-lifecycle.js";
import { createDockerSandboxBackend } from "./docker-backend.js";
import { DOCKER_SANDBOX_ENGINE, ensureSandboxContainer } from "./docker.js";

type Container = { id: string; name: string; hash: string; running: boolean };
const fixture = vi.hoisted(() => ({
  containers: new Map<string, Container>(),
  calls: [] as string[][],
  serial: 0,
  removalFails: false,
  terminalState: "stopped" as "stopped" | "paused" | "unreachable",
  setup: undefined as undefined | ((signal: AbortSignal | undefined) => Promise<void>),
  inspectState: undefined as
    | undefined
    | ((
        container: Container,
        format: string,
      ) => Promise<{ code: number; stdout: string; stderr: string }>),
  logError: vi.fn(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: fixture.logError }),
}));
vi.mock("./registry.js", () => ({
  readRegistryEntry: vi.fn(async () => null),
  updateRegistry: vi.fn(async () => {}),
  removeRegistryEntry: vi.fn(async () => {}),
}));
vi.mock("./mount-plan.js", () => ({
  prepareSandboxMountPlan: vi.fn(async () => ({ binds: [], skippedBinds: [] })),
  sandboxMountPlanMatchesContainer: vi.fn(async () => true),
  resolveSandboxContainerOnlyMounts: vi.fn(async () => []),
}));
vi.mock("./container-engine.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  PODMAN_SANDBOX_ENGINE: { id: "podman", command: "podman", displayName: "Podman" },
  execContainerRaw: vi.fn(),
  execContainer: vi.fn(async (_engine: unknown, args: string[], opts?: ExecContainerRawOptions) => {
    fixture.calls.push(args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "image") {
      return ok();
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1];
      const id = (++fixture.serial).toString(16).padStart(64, "0");
      const hash = args
        .find((arg) => arg.startsWith("openclaw.configHash="))
        ?.slice("openclaw.configHash=".length);
      if (!name || !hash) {
        throw new Error("Container fixture requires its name and config hash");
      }
      fixture.containers.set(name, { id, name, hash, running: false });
      return ok(id);
    }
    const target = args[0] === "exec" ? args[2] : args.at(-1);
    const container = [...fixture.containers.values()].find(
      (entry) => entry.name === target || entry.id === target,
    );
    if (!container) {
      return { code: 1, stdout: "", stderr: `No such container: ${target}` };
    }
    if (args[0] === "inspect") {
      if (fixture.inspectState && args.at(-1) === container.id) {
        return fixture.inspectState(container, args[2] ?? "");
      }
      if (args[2] === "{{.Id}}") {
        return ok(container.id);
      }
      if (args[2] === "{{.State.Running}}") {
        return ok(String(container.running));
      }
      if (args[2] === "{{json .State}}") {
        if (fixture.terminalState === "unreachable") {
          return { code: 125, stdout: "", stderr: "engine connection refused" };
        }
        return ok(
          JSON.stringify({
            Running: container.running,
            Paused: fixture.terminalState === "paused",
            Pid: container.running || fixture.terminalState === "paused" ? 123 : 0,
          }),
        );
      }
      return ok(container.hash);
    }
    if (args[0] === "start") {
      container.running = true;
    } else if (args[0] === "kill") {
      container.running = false;
    } else if (args[0] === "exec") {
      await fixture.setup?.(opts?.signal);
    } else if (args[0] === "rm") {
      if (fixture.removalFails) {
        return { code: 1, stdout: "", stderr: "permission denied" };
      }
      fixture.containers.delete(container.name);
    }
    return ok();
  }),
}));

function source(params?: {
  source?: object;
  grantId?: string;
  grantSignal?: AbortSignal;
  retain?: boolean;
  signal?: boolean;
}) {
  const controller = new AbortController();
  const signal = params?.grantSignal
    ? AbortSignal.any([controller.signal, params.grantSignal])
    : controller.signal;
  let references = 1;
  const release = vi.fn(() => references--);
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (references === 0) {
      throw new Error("source released");
    }
  };
  const authority = createAdmittedRunOperatorAuthority({
    profileId: "guest",
    scopes: ["operator.write"],
    gatewayAccessGrant: { pluginId: "fixture-access", grantId: params?.grantId ?? "original" },
    source: params?.source ?? {},
    signal: params?.signal === false ? undefined : signal,
    assertCurrent,
    retain:
      params?.retain === false
        ? undefined
        : () => {
            assertCurrent();
            references++;
            return release;
          },
  });
  return { authority, controller, release, closeForeground: () => references-- };
}

function provision(owner: ReturnType<typeof source> | undefined, scopeKey = "guest") {
  return {
    operatorAuthority: owner?.authority,
    scopeKey,
    workspaceDir: "/workspace",
    agentWorkspaceDir: "/workspace",
    cfg: resolveSandboxConfigForAgent({
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
            docker: { setupCommand: "setup" },
          },
        },
      },
    }),
  };
}

beforeEach(() => {
  fixture.calls.length = 0;
  fixture.terminalState = "stopped";
  fixture.setup = undefined;
  fixture.inspectState = undefined;
  vi.mocked(execContainerRaw).mockReset();
  fixture.removalFails = false;
  fixture.logError.mockClear();
});

afterEach(async () => {
  fixture.removalFails = false;
  fixture.terminalState = "stopped";
  fixture.setup = undefined;
  fixture.inspectState = undefined;
  for (const name of fixture.containers.keys()) {
    await removeSandboxContainerRuntime(DOCKER_SANDBOX_ENGINE, name);
  }
});

it("retains original access after foreground close and stops only its private generation", async () => {
  const owner = source();
  const independent = source({ grantId: "independent" });
  const params = provision(owner);
  const { containerName: name } = await ensureSandboxContainer(params);
  const { containerName: otherName } = await ensureSandboxContainer(
    provision(independent, "independent"),
  );
  const id = fixture.containers.get(name)!.id;
  owner.closeForeground();
  await ensureSandboxContainer(params);
  expect(fixture.calls.filter(([operation]) => operation === "create")).toHaveLength(2);
  expect(fixture.containers.get(name)?.running).toBe(true);

  owner.controller.abort(new Error("original access revoked"));
  const replacement = source({ grantId: "replacement" });
  await ensureSandboxContainer(provision(replacement));
  expect(fixture.calls.filter(([operation]) => operation === "kill")).toEqual([["kill", id]]);
  expect(fixture.calls.filter(([operation]) => operation === "wait")).toEqual([["wait", id]]);
  expect(fixture.calls.some(([operation]) => operation === "rm")).toBe(false);
  expect(fixture.containers.get(name)).toMatchObject({ id, running: true });
  expect(fixture.containers.get(otherName)?.running).toBe(true);
  await expect(ensureSandboxContainer(params)).rejects.toThrow("original access revoked");
  expect(owner.release).toHaveBeenCalledTimes(2);
  replacement.closeForeground();
  expect(() => replacement.authority.assertCurrent()).not.toThrow();
  replacement.controller.abort();
  await withSandboxContainerLifecycle(name, undefined, async () => {});
  expect(fixture.containers.get(name)?.running).toBe(false);
  expect(fixture.calls.filter(([operation]) => operation === "kill")).toEqual([
    ["kill", id],
    ["kill", id],
  ]);
});

it("preserves a valid same-grant source after device loss, then stops on full grant revocation", async () => {
  const grant = new AbortController();
  const first = source({ grantSignal: grant.signal });
  const second = source({ grantSignal: grant.signal });
  const { containerName, containerId } = await ensureSandboxContainer(provision(first));
  await ensureSandboxContainer(provision(second));
  first.closeForeground();
  second.closeForeground();

  first.controller.abort(new Error("first device revoked"));
  await ensureSandboxContainer(provision(second));
  expect(fixture.containers.get(containerName)?.running).toBe(true);
  expect(fixture.calls.some(([operation]) => operation === "kill")).toBe(false);
  expect(first.release).toHaveBeenCalledOnce();

  grant.abort(new Error("original invitation revoked"));
  await ensureSandboxContainer(provision(source({ grantId: "replacement" })));
  expect(fixture.calls.filter(([operation]) => operation === "kill")).toEqual([
    ["kill", containerId],
  ]);
  expect(fixture.calls.some(([operation]) => operation === "rm")).toBe(false);
  await expect(ensureSandboxContainer(provision(second))).rejects.toThrow(
    "original invitation revoked",
  );
});

it("does not let a revoked queued caller discard another grant's private custody", async () => {
  const first = source();
  const started = createDeferred();
  const setup = createDeferred();
  fixture.setup = () => {
    started.resolve();
    return setup.promise;
  };
  const creating = ensureSandboxContainer(provision(first));
  await started.promise;
  const other = source({ grantId: "other" });
  const queued = ensureSandboxContainer(provision(other));
  const rejected = expect(queued).rejects.toThrow("queued access revoked");
  other.controller.abort(new Error("queued access revoked"));
  setup.resolve();
  const { containerId } = await creating;
  await rejected;
  first.controller.abort();
  await ensureSandboxContainer(provision(source({ grantId: "replacement" })));
  expect(fixture.calls.filter(([operation]) => operation === "kill")).toEqual([
    ["kill", containerId],
  ]);
});

it("retains a same-grant new source through cold replacement of the old generation", async () => {
  const first = source();
  const { containerName, containerId: oldId } = await ensureSandboxContainer(provision(first));
  fixture.containers.get(containerName)!.running = false;
  const second = source();
  const params = provision(second);
  params.cfg.docker.image = "replacement:image";
  const { containerId } = await ensureSandboxContainer(params);
  expect(containerId).not.toBe(oldId);
  second.closeForeground();
  await ensureSandboxContainer(params);
  second.controller.abort();
  await ensureSandboxContainer({
    ...params,
    operatorAuthority: source({ grantId: "replacement" }).authority,
  });
  expect(fixture.calls.filter(([operation]) => operation === "kill")).toEqual([
    ["kill", containerId],
  ]);
});

it.each(["staff", "different-grant", "unclassified"] as const)(
  "permanently protects a generation reused by %s",
  async (kind) => {
    const owner = source();
    const params = provision(owner);
    const { containerName: name } = await ensureSandboxContainer(params);
    const other =
      kind === "unclassified"
        ? undefined
        : source({
            grantId: kind === "different-grant" ? "other" : "original",
          });
    const otherParams = provision(other);
    if (kind === "staff" && other) {
      otherParams.operatorAuthority = createAdmittedRunOperatorAuthority({
        ...other.authority,
        gatewayAccessGrant: null,
      });
    }
    await ensureSandboxContainer(otherParams);
    owner.controller.abort();
    await ensureSandboxContainer(otherParams);
    expect(fixture.containers.get(name)?.running).toBe(true);
    expect(fixture.calls.some(([operation]) => operation === "kill")).toBe(false);
    expect(owner.release).toHaveBeenCalledOnce();
    fixture.containers.get(name)!.running = false;
    const later = source();
    await ensureSandboxContainer(provision(later));
    later.controller.abort();
    await withSandboxContainerLifecycle(name, undefined, async () => {});
    expect(fixture.containers.get(name)?.running).toBe(true);
    expect(fixture.calls.some(([operation]) => operation === "kill")).toBe(false);
  },
);

it.each(["preexisting", "shared", "no-signal", "no-retain"] as const)(
  "does not infer exclusive custody for %s environments",
  async (kind) => {
    const owner = source({ signal: kind !== "no-signal", retain: kind !== "no-retain" });
    const params = provision(owner);
    if (kind === "shared") {
      params.cfg.scope = "shared";
    }
    if (kind === "preexisting") {
      await ensureSandboxContainer({ ...params, operatorAuthority: undefined });
    }
    const { containerName: name } = await ensureSandboxContainer(params);
    owner.controller.abort();
    await ensureSandboxContainer({ ...params, operatorAuthority: undefined });
    expect(fixture.containers.get(name)?.running).toBe(true);
    expect(fixture.calls.some(([operation]) => operation === "kill")).toBe(false);
    fixture.containers.get(name)!.running = false;
    const later = source();
    await ensureSandboxContainer({ ...params, operatorAuthority: later.authority });
    later.controller.abort();
    await withSandboxContainerLifecycle(name, undefined, async () => {});
    expect(fixture.containers.get(name)?.running).toBe(true);
    expect(fixture.calls.some(([operation]) => operation === "kill")).toBe(false);
  },
);

it("settles revocation during setup before an already-queued replacement can start", async () => {
  const owner = source();
  const started = createDeferred();
  fixture.setup = async (signal) => {
    started.resolve();
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("setup access revoked")), {
        once: true,
      });
    });
  };
  const creating = ensureSandboxContainer(provision(owner));
  const rejected = expect(creating).rejects.toThrow("setup access revoked");
  await started.promise;
  const replacement = source({ grantId: "replacement" });
  const queued = ensureSandboxContainer(provision(replacement));
  owner.controller.abort(new Error("setup access revoked"));
  await rejected;
  await queued;
  expect(fixture.calls.filter(([operation]) => operation === "kill")).toHaveLength(1);
  expect(fixture.calls.some(([operation]) => operation === "rm")).toBe(false);
  const operations = fixture.calls.map(([operation]) => operation);
  expect(operations.lastIndexOf("start")).toBeGreaterThan(operations.indexOf("wait"));
  expect([...fixture.containers.values()]).toEqual([expect.objectContaining({ running: true })]);
  replacement.closeForeground();
  expect(() => replacement.authority.assertCurrent()).not.toThrow();
  replacement.controller.abort();
  const [name] = fixture.containers.keys();
  if (!name) {
    throw new Error("Expected the retained private container");
  }
  await withSandboxContainerLifecycle(name, undefined, async () => {});
  expect(fixture.calls.filter(([operation]) => operation === "kill")).toHaveLength(2);
  expect(fixture.containers.get(name)?.running).toBe(false);
});

it("discards stopped custody when the generation was restarted outside its owner", async () => {
  const first = source();
  const { containerName } = await ensureSandboxContainer(provision(first));
  first.controller.abort();
  await withSandboxContainerLifecycle(containerName, undefined, async () => {});
  expect(fixture.containers.get(containerName)?.running).toBe(false);
  fixture.containers.get(containerName)!.running = true;
  const next = source();
  await ensureSandboxContainer(provision(next));
  next.controller.abort();
  await withSandboxContainerLifecycle(containerName, undefined, async () => {});
  expect(fixture.calls.filter(([operation]) => operation === "kill")).toHaveLength(1);
  expect(fixture.containers.get(containerName)?.running).toBe(true);
});

it("settles old targeted cleanup from its own termination receipt after same-ID restart", async () => {
  const first = source();
  const createBackend = (owner: ReturnType<typeof source>) => {
    const { operatorAuthority, ...input } = provision(owner);
    return createDockerSandboxBackend({ ...input, sessionKey: input.scopeKey }, operatorAuthority);
  };
  const backend = await createBackend(first);
  const cleanup = backend.prepareProcessCleanup!({});
  const inspected = createDeferred();
  const delayed = createDeferred();
  let inspections = 0;
  fixture.inspectState = async (container, format) => {
    if (++inspections === 1) {
      inspected.resolve();
      await delayed.promise;
    }
    return {
      code: 0,
      stdout:
        format === "{{.Id}}"
          ? container.id
          : JSON.stringify({
              Running: container.running,
              Paused: false,
              Pid: container.running ? 234 : 0,
            }),
      stderr: "",
    };
  };
  vi.mocked(execContainerRaw).mockResolvedValue({
    code: 125,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("exec failed"),
  });
  const pending = cleanup.terminate();
  void pending.catch(() => {});
  try {
    await inspected.promise;
    first.controller.abort();
    await withSandboxContainerLifecycle(backend.runtimeId, undefined, async () => {});
    const restarted = await createBackend(source({ grantId: "replacement" }));
    expect(restarted.runtimeId).toBe(backend.runtimeId);
    expect(fixture.containers.get(restarted.runtimeId)?.running).toBe(true);
    delayed.resolve();
    await expect(pending).resolves.toBeUndefined();
    await expect(restarted.prepareProcessCleanup!({}).terminate()).rejects.toThrow("exec failed");
  } finally {
    delayed.resolve();
    await pending.catch(() => {});
  }
});

it.each(["paused", "unreachable"] as const)(
  "retains a failed stop and refuses reuse when terminal inspection is %s",
  async (terminalState) => {
    const owner = source();
    await ensureSandboxContainer(provision(owner));
    fixture.terminalState = terminalState;
    owner.controller.abort();
    await expect(ensureSandboxContainer(provision(source()))).rejects.toThrow("Could not verify");
    expect(owner.release).toHaveBeenCalledOnce();
    expect(fixture.calls.filter(([operation]) => operation === "start")).toHaveLength(1);
  },
);

it("releases custody on removal so an old callback cannot stop a replacement generation", async () => {
  const owner = source();
  const { containerName: name } = await ensureSandboxContainer(provision(owner));
  const id = fixture.containers.get(name)!.id;
  await removeSandboxContainerRuntime(DOCKER_SANDBOX_ENGINE, name);
  const replacement = source();
  await ensureSandboxContainer(provision(replacement));
  owner.controller.abort();
  await ensureSandboxContainer(provision(replacement));
  expect(fixture.containers.get(name)?.id).not.toBe(id);
  expect(fixture.containers.get(name)?.running).toBe(true);
  expect(fixture.calls.some(([operation]) => operation === "kill")).toBe(false);
  expect(owner.release).toHaveBeenCalledOnce();
});

it.each(["partial-creation", "replacement", "manager"] as const)(
  "retains revocation custody when %s removal fails",
  async (kind) => {
    const owner = source();
    const params = provision(owner);
    fixture.removalFails = true;
    if (kind === "partial-creation") {
      fixture.setup = async () => {
        throw new Error("setup failed");
      };
      await expect(ensureSandboxContainer(params)).rejects.toThrow(
        "creation and cleanup both failed",
      );
      fixture.setup = undefined;
    } else {
      const { containerName } = await ensureSandboxContainer(params);
      if (kind === "manager") {
        await expect(
          removeSandboxContainerRuntime(DOCKER_SANDBOX_ENGINE, containerName),
        ).rejects.toThrow("permission denied");
      } else {
        fixture.containers.get(containerName)!.running = false;
        await expect(
          ensureSandboxContainer({
            ...params,
            cfg: {
              ...params.cfg,
              docker: { ...params.cfg.docker, image: "different:image" },
            },
          }),
        ).rejects.toThrow("Sandbox replacement failed");
      }
    }
    const retainedKills = [...fixture.containers.values()].map(({ id }) => ["kill", id]);
    expect(retainedKills).toHaveLength(1);
    owner.controller.abort();
    await ensureSandboxContainer(provision(source({ grantId: "replacement" })));
    expect(fixture.calls.filter(([operation]) => operation === "kill")).toEqual(retainedKills);
  },
);
