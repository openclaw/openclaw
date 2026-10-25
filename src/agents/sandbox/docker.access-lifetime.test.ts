import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createEnteredGate } from "../entered-gate.test-support.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { execContainerRaw, type ExecContainerRawOptions } from "./container-engine.js";
import {
  removeSandboxContainerRuntime,
  withSandboxContainerLifecycle,
} from "./container-lifecycle.js";
import { createDockerSandboxBackend } from "./docker-backend.js";
import { DOCKER_SANDBOX_ENGINE, ensureSandboxContainer } from "./docker.js";
import type { SandboxRegistryEntry } from "./registry.types.js";

type Container = { id: string; name: string; hash: string; running: boolean; generation: number };
type Inspection = { code: number; stdout: string; stderr: string };
const fixture = vi.hoisted(() => ({
  containers: new Map<string, Container>(),
  registry: new Map<string, SandboxRegistryEntry>(),
  calls: [] as string[][],
  serial: 0,
  imageFails: false,
  removalFails: false,
  terminalState: "stopped" as "stopped" | "paused" | "unreachable",
  setup: undefined as undefined | ((signal: AbortSignal | undefined) => Promise<void>),
  inspectState: undefined as
    | undefined
    | ((container: Container, format: string) => Promise<Inspection>),
  inspect: (container: Container, paused = false, pid = 123) =>
    JSON.stringify({
      Running: container.running,
      Paused: paused,
      Pid: container.running || paused ? pid : 0,
      StartedAt: new Date(container.generation * 1_000).toISOString(),
    }),
  result: (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr }),
  save: (entry: SandboxRegistryEntry): void => {
    fixture.registry.set(entry.containerName, {
      ...fixture.registry.get(entry.containerName),
      ...structuredClone(entry),
    });
  },
}));

// mock-isolation: capture lifecycle diagnostics without installing real log sinks.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// mock-isolation: lifecycle cases share an in-memory registry rather than durable sandbox state.
vi.mock("./registry.js", () => ({
  readRegistryEntry: vi.fn(async (name: string) => fixture.registry.get(name) ?? null),
  updateRegistry: vi.fn(async (entry: SandboxRegistryEntry) => fixture.save(entry)),
  completeSandboxRegistryReservation: vi.fn(async (entry: SandboxRegistryEntry) => {
    fixture.save({ ...entry, runtimeState: "ready" });
  }),
  removeRegistryEntry: vi.fn(
    async (name: string, options?: { preserveRemovalIntent?: boolean }) => {
      const state = fixture.registry.get(name)?.runtimeState;
      if (
        !options?.preserveRemovalIntent ||
        !["removing", "removing-pending"].includes(state ?? "")
      ) {
        fixture.registry.delete(name);
      }
    },
  ),
}));
vi.mock("./mount-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mount-plan.js")>()),
  prepareSandboxMountPlan: vi.fn(async () => ({ binds: [], skippedBinds: [] })),
  compareSandboxMountPlan: vi.fn(async () => "match"),
  resolveSandboxContainerOnlyMounts: vi.fn(async () => []),
}));
// mock-isolation: simulate container commands and failures without invoking a container engine.
vi.mock("./container-engine.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  PODMAN_SANDBOX_ENGINE: { id: "podman", command: "podman", displayName: "Podman" },
  execContainerRaw: vi.fn(),
  execContainer: vi.fn(async (_engine: unknown, args: string[], opts?: ExecContainerRawOptions) => {
    fixture.calls.push(args);
    const { result } = fixture;
    if (args[0] === "context" && args[1] === "inspect") {
      return result(JSON.stringify({ Host: "unix:///fixture-docker.sock" }));
    }
    if (args[0] === "info") {
      return result("fixture-daemon");
    }
    if (args[0] === "image") {
      if (fixture.imageFails) {
        throw new Error("image unavailable");
      }
      return result();
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
      fixture.containers.set(name, { id, name, hash, running: false, generation: 0 });
      return result(id);
    }
    const target = args[0] === "exec" ? args[2] : args.at(-1);
    const container = [...fixture.containers.values()].find(
      (entry) => entry.name === target || entry.id === target,
    );
    if (!container) {
      return result("", 1, `No such container: ${target}`);
    }
    if (args[0] === "inspect") {
      if (fixture.inspectState && args.at(-1) === container.id) {
        return fixture.inspectState(container, args[2] ?? "");
      }
      if (args[2] === "{{json .State}}") {
        return fixture.terminalState === "unreachable"
          ? result("", 125, "engine connection refused")
          : result(fixture.inspect(container, fixture.terminalState === "paused"));
      }
      if (args[2] === "{{.Id}} {{.HostConfig.ReadonlyRootfs}}") {
        return result(`${container.id} true`);
      }
      return result(
        args[2] === "{{.Id}}"
          ? container.id
          : args[2] === "{{.State.Running}}"
            ? String(container.running)
            : container.hash,
      );
    }
    if (args[0] === "start") {
      container.running = true;
      container.generation++;
    } else if (args[0] === "kill") {
      container.running = false;
    } else if (args[0] === "exec") {
      await fixture.setup?.(opts?.signal);
    } else if (args[0] === "rm") {
      if (fixture.removalFails) {
        return result("", 1, "permission denied");
      }
      fixture.containers.delete(container.name);
    }
    return result();
  }),
}));

type SourceOptions = {
  profileId?: string;
  grantId?: string;
  grantSignal?: AbortSignal;
  retain?: boolean;
  signal?: boolean;
};
function source(params: SourceOptions = {}) {
  const controller = new AbortController();
  const signal = params.grantSignal
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
  const retain = () => {
    assertCurrent();
    references++;
    return release;
  };
  const authority = createAdmittedRunOperatorAuthority({
    profileId: params.profileId ?? "guest",
    scopes: ["operator.write"],
    gatewayAccessGrant: { pluginId: "fixture-access", grantId: params.grantId ?? "original" },
    source: {},
    signal: params.signal === false ? undefined : signal,
    assertCurrent,
    retain: params.retain === false ? undefined : retain,
  });
  return { authority, controller, release, closeForeground: () => references-- };
}

const sandboxConfig = resolveSandboxConfigForAgent({
  agents: {
    defaults: { sandbox: { mode: "all", scope: "session", docker: { setupCommand: "setup" } } },
  },
});
function provision(owner?: ReturnType<typeof source>, scopeKey = "guest") {
  return {
    engine: DOCKER_SANDBOX_ENGINE,
    operatorAuthority: owner?.authority,
    scopeKey,
    workspaceDir: "/workspace",
    agentWorkspaceDir: "/workspace",
    cfg: structuredClone(sandboxConfig),
  };
}
async function start(owner = source()) {
  const params = provision(owner);
  const { containerName: name, containerId: id } = await ensureSandboxContainer(params);
  return { owner, params, name, id };
}

const calls = (name: string) => fixture.calls.filter(([operation]) => operation === name);
const ensure = (owner = source(), scopeKey?: string) =>
  ensureSandboxContainer(provision(owner, scopeKey));
const drain = (name: string) => withSandboxContainerLifecycle(name, undefined, async () => {});
async function revoke(owner: ReturnType<typeof source>, name: string) {
  owner.controller.abort();
  await drain(name);
}
function expectCounts(counts: Record<string, number>) {
  expect(Object.fromEntries(Object.keys(counts).map((op) => [op, calls(op).length]))).toEqual(
    counts,
  );
}
function allocated() {
  expect(fixture.containers.size).toBe(1);
  return [...fixture.containers.values()][0]!;
}
function expectProtected(name: string, priorKills = 0) {
  expect(fixture.containers.get(name)?.running).toBe(true);
  expect(calls("kill")).toHaveLength(priorKills);
}
async function restartAndRevoke(name: string, params?: ReturnType<typeof provision>) {
  fixture.containers.get(name)!.running = false;
  const later = source();
  await ensureSandboxContainer({
    ...(params ?? provision(later)),
    operatorAuthority: later.authority,
  });
  await revoke(later, name);
}

beforeEach(() => {
  fixture.calls.length = 0;
  fixture.registry.clear();
  fixture.imageFails = false;
  vi.mocked(execContainerRaw).mockReset();
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
  const { owner, params, name, id } = await start();
  const independent = source({ grantId: "independent" });
  const { containerName: otherName } = await ensure(independent, "independent");
  owner.closeForeground();
  await ensureSandboxContainer(params);
  expect(calls("create")).toHaveLength(2);
  expect(fixture.containers.get(name)?.running).toBe(true);

  owner.controller.abort(new Error("original access revoked"));
  const replacement = source();
  await ensure(replacement);
  expect(calls("kill")).toEqual([["kill", id]]);
  expect(calls("wait")).toEqual([["wait", id]]);
  expect(calls("rm")).toEqual([]);
  expect(fixture.containers.get(name)).toMatchObject({ id, running: true });
  expect(fixture.containers.get(otherName)?.running).toBe(true);
  await expect(ensureSandboxContainer(params)).rejects.toThrow("original access revoked");
  expect(owner.release).toHaveBeenCalledTimes(2);
  replacement.closeForeground();
  expect(() => replacement.authority.assertCurrent()).not.toThrow();
  await revoke(replacement, name);
  expect(fixture.containers.get(name)?.running).toBe(false);
  expect(calls("kill")).toEqual(Array.from({ length: 2 }, () => ["kill", id]));
});

it("preserves a valid same-grant source after device loss, then stops on full grant revocation", async () => {
  const grant = new AbortController();
  const first = source({ grantSignal: grant.signal });
  const second = source({ grantSignal: grant.signal });
  const { containerName, containerId } = await ensure(first);
  await ensure(second);
  first.closeForeground();
  second.closeForeground();

  first.controller.abort(new Error("first device revoked"));
  await ensure(second);
  expectProtected(containerName);
  expect(first.release).toHaveBeenCalledOnce();

  grant.abort(new Error("original invitation revoked"));
  await ensure(source({ grantId: "replacement" }));
  expect(calls("kill")).toEqual([["kill", containerId]]);
  expect(calls("rm")).toEqual([]);
  await expect(ensure(second)).rejects.toThrow("original invitation revoked");
});

it("does not let a revoked queued caller discard another grant's private custody", async () => {
  const first = source();
  const setup = createEnteredGate();
  fixture.setup = setup.wait;
  const creating = ensure(first);
  await setup.entered;
  const other = source({ grantId: "other" });
  const queued = ensure(other);
  const rejected = expect(queued).rejects.toThrow("queued access revoked");
  other.controller.abort(new Error("queued access revoked"));
  setup.release();
  const { containerId } = await creating;
  await rejected;
  first.controller.abort();
  await ensure(source({ grantId: "replacement" }));
  expect(calls("kill")).toEqual([["kill", containerId]]);
});

it("retains a same-grant new source through cold replacement of the old generation", async () => {
  const { name: containerName, id: oldId } = await start();
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
  expect(calls("kill")).toEqual([["kill", containerId]]);
});

it.each([
  "staff",
  "different-grant",
  "unclassified",
  "preexisting",
  "shared",
  "no-signal",
  "no-retain",
] as const)(
  "permanently protects %s custody from revocation and later private reuse",
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
    const mixed = ["staff", "different-grant", "unclassified"].includes(kind);
    const reuse: ReturnType<typeof provision> = { ...params, operatorAuthority: undefined };
    if (kind === "staff" || kind === "different-grant") {
      const other = source({ grantId: kind === "different-grant" ? "other" : "original" });
      reuse.operatorAuthority =
        kind === "staff"
          ? createAdmittedRunOperatorAuthority({ ...other.authority, gatewayAccessGrant: null })
          : other.authority;
    }
    if (mixed) {
      await ensureSandboxContainer(reuse);
    }
    owner.controller.abort();
    await ensureSandboxContainer(reuse);
    expectProtected(name);
    if (mixed) {
      expect(owner.release).toHaveBeenCalledOnce();
    }
    await restartAndRevoke(name, params);
    expectProtected(name);
  },
);

it.each([
  { timing: "stopped", changed: "grant" },
  { timing: "queued", changed: "profile" },
])(
  "preserves mixed history after $timing reuse changes the $changed",
  async ({ timing, changed }) => {
    const { owner: first, name: containerName, id: containerId } = await start();
    const other = source({
      grantId: changed === "grant" ? "other" : "original",
      profileId: changed === "profile" ? "other" : "guest",
    });
    if (timing === "queued") {
      const gate = createEnteredGate();
      const blocked = withSandboxContainerLifecycle(containerName, undefined, gate.wait);
      await gate.entered;
      const queued = ensure(other);
      first.controller.abort();
      gate.release();
      await blocked;
      await queued;
    } else {
      await revoke(first, containerName);
      await ensure(other);
    }
    await revoke(other, containerName);
    expect(fixture.containers.get(containerName)).toMatchObject({ id: containerId, running: true });
    expect(calls("kill")).toEqual([["kill", containerId]]);

    await restartAndRevoke(containerName);
    expectProtected(containerName, 1);
  },
);

it("retains interrupted setup and rejects queued or later reuse before restart", async () => {
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
  const creating = ensure(owner);
  const rejected = expect(creating).rejects.toThrow("setup access revoked");
  await started.promise;
  const queued = ensure();
  void queued.catch(() => {});
  owner.controller.abort(new Error("setup access revoked"));
  await rejected;
  await expect(queued).rejects.toThrow("setup did not complete");
  const container = allocated();
  await drain(container.name);
  expectCounts({ kill: 1, rm: 0, start: 1, exec: 1 });
  expect(container.running).toBe(false);
  expect(fixture.registry.get(container.name)?.runtimeState).toBe("pending");

  const later = provision(source());
  later.cfg.docker.image = "changed:image";
  await expect(ensureSandboxContainer(later)).rejects.toThrow("setup did not complete");
  expectCounts({ create: 1, start: 1, exec: 1, rm: 0 });
});

it("recovers a pending unallocated attempt when setup is removed", async () => {
  fixture.imageFails = true;
  await expect(ensure()).rejects.toThrow("image unavailable");
  expect(fixture.containers.size).toBe(0);
  fixture.imageFails = false;
  const params = provision(source());
  delete params.cfg.docker.setupCommand;
  const created = await ensureSandboxContainer(params);
  await expect(ensureSandboxContainer(params)).resolves.toEqual(created);
  expect(fixture.registry.get(created.containerName)?.runtimeState).toBe("ready");
  expectCounts({ create: 1, exec: 0 });
});

it("preserves management removal intent across failed setup and queued reuse", async () => {
  const setup = createEnteredGate();
  fixture.setup = async () => {
    await setup.wait();
    throw new Error("setup failed");
  };
  const creating = ensure();
  const failed = expect(creating).rejects.toThrow("setup failed");
  await setup.entered;
  fixture.setup = undefined;
  const container = allocated();
  const entry = fixture.registry.get(container.name)!;
  expect(entry).toBeDefined();
  const queued = ensure();
  void queued.catch(() => {});
  // Management publishes its removal fence before it waits for this owner queue.
  fixture.registry.set(container.name, { ...entry, runtimeState: "removing-pending" });
  const removing = removeSandboxContainerRuntime(DOCKER_SANDBOX_ENGINE, container.name);
  setup.release();
  await failed;
  await removing;
  await expect(queued).rejects.toThrow("is being removed");
  expectCounts({ create: 1, start: 1 });
  expect(fixture.registry.get(container.name)?.runtimeState).toBe("removing-pending");
});

it("discards stopped custody when the generation was restarted outside its owner", async () => {
  const { owner: first, name: containerName } = await start();
  await revoke(first, containerName);
  expect(fixture.containers.get(containerName)?.running).toBe(false);
  fixture.containers.get(containerName)!.running = true;
  const next = source();
  await ensure(next);
  await revoke(next, containerName);
  expectProtected(containerName, 1);
});

it("settles old targeted cleanup from its own termination receipt after same-ID restart", async () => {
  const first = source();
  const createBackend = (owner: ReturnType<typeof source>) => {
    const { operatorAuthority, ...input } = provision(owner);
    return createDockerSandboxBackend({ ...input, sessionKey: input.scopeKey }, operatorAuthority);
  };
  const backend = await createBackend(first);
  const cleanup = backend.prepareProcessCleanup!({});
  const inspection = createEnteredGate();
  let inspections = 0;
  fixture.inspectState = async (container, format) => {
    if (++inspections === 1) {
      await inspection.wait();
    }
    return fixture.result(
      format === "{{.Id}}" ? container.id : fixture.inspect(container, false, 234),
    );
  };
  vi.mocked(execContainerRaw).mockResolvedValue({
    code: 125,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("exec failed"),
  });
  const pending = cleanup.terminate();
  void pending.catch(() => {});
  try {
    await inspection.entered;
    await revoke(first, backend.runtimeId);
    const restarted = await createBackend(source());
    expect(restarted.runtimeId).toBe(backend.runtimeId);
    expect(fixture.containers.get(restarted.runtimeId)?.running).toBe(true);
    inspection.release();
    await expect(pending).resolves.toBeUndefined();
    await expect(restarted.prepareProcessCleanup!({}).terminate()).rejects.toThrow("exec failed");
  } finally {
    inspection.release();
    await pending.catch(() => {});
  }
});

it.each(["paused", "unreachable"] as const)(
  "retains a failed stop and refuses reuse when terminal inspection is %s",
  async (terminalState) => {
    const { owner } = await start();
    fixture.terminalState = terminalState;
    owner.controller.abort();
    await expect(ensure()).rejects.toThrow("Could not verify");
    expect(owner.release).toHaveBeenCalledOnce();
    expect(calls("start")).toHaveLength(1);
  },
);

it("releases custody on removal so an old callback cannot stop a replacement generation", async () => {
  const { owner, name, id } = await start();
  await removeSandboxContainerRuntime(DOCKER_SANDBOX_ENGINE, name);
  const replacement = source();
  await ensure(replacement);
  owner.controller.abort();
  await ensure(replacement);
  expect(fixture.containers.get(name)?.id).not.toBe(id);
  expectProtected(name);
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
      expect([...fixture.registry.values()]).toEqual([
        expect.objectContaining({ runtimeState: "pending", workspaceDir: params.workspaceDir }),
      ]);
      fixture.setup = undefined;
    } else {
      const { containerName } = await ensureSandboxContainer(params);
      if (kind === "manager") {
        await expect(
          removeSandboxContainerRuntime(DOCKER_SANDBOX_ENGINE, containerName),
        ).rejects.toThrow("permission denied");
      } else {
        fixture.containers.get(containerName)!.running = false;
        params.cfg.docker.image = "different:image";
        await expect(ensureSandboxContainer(params)).rejects.toThrow("Sandbox replacement failed");
      }
    }
    const retainedKills = [...fixture.containers.values()].map(({ id }) => ["kill", id]);
    expect(retainedKills).toHaveLength(1);
    owner.controller.abort();
    for (const name of fixture.containers.keys()) {
      await drain(name);
    }
    expect(calls("kill")).toEqual(retainedKills);
  },
);
