import { once } from "node:events";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SandboxPersistentExecRecord } from "./persistent-exec-store.types.js";
const mocks = vi.hoisted(() => ({
  command: vi.fn<typeof import("./container-engine.js").execContainer>(),
  current: vi.fn(),
  liveCurrent: vi.fn(),
  browserLiveCurrent: vi.fn(),
  imageBacking: vi.fn(),
  read: vi.fn(),
  browsers: vi.fn(),
  browserCurrent: vi.fn(),
  custody: vi.fn(),
  custodyCurrent: vi.fn(),
}));
// mock-isolation: Registry generations are fixture-owned; do not read the real state database.
vi.mock("./registry.js", () => ({
  assertSandboxRegistryEntryCurrent: mocks.liveCurrent,
  assertSandboxBrowserRegistryEntryCurrent: mocks.browserLiveCurrent,
  readRegistry: mocks.read,
  readBrowserRegistry: mocks.browsers,
  assertSandboxRegistryRetirementCurrent: (kind: string, entry: unknown) =>
    kind === "browser" ? mocks.browserCurrent(entry) : mocks.current(entry),
}));
// mock-isolation: Custody records and their currentness belong to this synthetic workspace fixture.
vi.mock("./persistent-exec-store.js", () => ({
  createSandboxPersistentExecStore: () => ({
    databasePath: "/synthetic/state.sqlite",
    environment: {},
    list: mocks.custody,
    assertCustodyCurrent: mocks.custodyCurrent,
  }),
}));
vi.mock("./docker.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker" },
  bindPodmanSandboxEngine: () => ({ id: "podman" }),
  execContainer: mocks.command,
  validateSandboxContainerEngineTarget: async () => {},
}));
// mock-isolation: The fixture chooses runtime visibility; mount-plan tests cover actual backing visibility.
vi.mock("./mount-plan.js", () => ({
  sandboxContainerShowsWorkspacePaths: mocks.imageBacking,
}));
import {
  prepareLocalWorkspaceImageRead,
  quiesceLocalWorkspace,
  type LocalWorkspacePausedRuntime,
} from "./local-workspace-quiescence.js";
const id = "a".repeat(64);
const entry = {
  containerName: "owned",
  backendId: "docker",
  sessionKey: "owner",
  workspaceDir: "/owned/projection",
};
const success = (stdout = "") => ({ code: 0, stdout, stderr: "" });
let retained: LocalWorkspacePausedRuntime[];
const persist = vi.fn((rows: LocalWorkspacePausedRuntime[]) => {
  retained = [...rows];
});
const commands = (action: string) =>
  mocks.command.mock.calls.map(([, args]) => args).filter(([name]) => name === action);
type EngineReply = ReturnType<typeof success>;
type EngineCommand = {
  action: string;
  target: string;
  apply: () => EngineReply;
  signal?: AbortSignal;
};
function mockEngine(
  ids: Record<string, string>,
  intercept: (command: EngineCommand) => EngineReply | void | Promise<EngineReply>,
) {
  const paused = new Set<string>();
  mocks.command.mockImplementation(async (_engine, args, options) => {
    const action = args.includes("{{.State.Paused}}") ? "resume-inspect" : args[0]!;
    const target = ids[args.at(-1)!] ?? args.at(-1)!;
    const apply = () => {
      if (action === "pause") {
        paused.add(target);
      }
      if (action === "unpause" && !paused.delete(target)) {
        return { code: 1, stdout: "", stderr: "container is not paused" };
      }
      if (action === "inspect") {
        return success(`${target} true ${paused.has(target)}`);
      }
      return success(action === "resume-inspect" ? String(paused.has(target)) : "");
    };
    return (await intercept({ action, target, apply, signal: options?.signal })) ?? apply();
  });
  return paused;
}
const quiesce = (overrides: Partial<Parameters<typeof quiesceLocalWorkspace>[0]> = {}) =>
  quiesceLocalWorkspace({
    workspaceDir: entry.workspaceDir,
    retained,
    persist,
    assertCurrent: () => {},
    ...overrides,
  });
beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  retained = [];
  persist.mockClear();
  mocks.read.mockResolvedValue({ entries: [entry] });
  mocks.browsers.mockResolvedValue({ entries: [] });
  mocks.imageBacking.mockResolvedValue(true);
  mocks.custody.mockResolvedValue([]);
});

it.each(["true", "false"])("recovers only owned pauses (Running=%s)", async (running) => {
  mocks.command.mockImplementation(async (_engine, args) =>
    success(args.includes("{{.State.Paused}}") ? "true" : id + ` ${running} true`),
  );
  await expect(quiesce()).rejects.toThrow("another owner");
  const { resume } = await quiesce({ retained: [{ name: "owned", id }] });
  await resume();
  expect(commands("pause")).toHaveLength(0);
  expect(commands("unpause").length).toBeGreaterThan(0);
});

it("persists exact container and browser custody before pausing and resumes only those IDs", async () => {
  const browserId = "b".repeat(64);
  const ids: Record<string, string> = { owned: id, "browser-owned": browserId };
  const expected = Object.entries(ids).map(([name, runtimeId]) => ({ name, id: runtimeId }));
  mocks.browsers.mockResolvedValue({
    entries: [{ ...entry, containerName: "browser-owned" }],
  });
  mockEngine(ids, ({ action, target }) => {
    if (action === "pause") {
      expect(persist).toHaveBeenLastCalledWith(target === id ? expected.slice(0, 1) : expected);
    }
  });
  const { resume } = await quiesce();
  expect(mocks.browserCurrent).toHaveBeenCalledTimes(3);
  await resume();
  expect(commands("unpause")).toEqual([browserId, id].map((runtimeId) => ["unpause", runtimeId]));
  expect(persist).toHaveBeenCalledTimes(4);
  expect(retained).toEqual([]);
});

it.each([false, true])(
  "clears orphaned custody only when present (retained=%s)",
  async (orphaned) => {
    mocks.read.mockResolvedValue({ entries: [] });
    retained = orphaned ? [{ name: "gone", id }] : [];
    await (await quiesce()).resume();
    expect(retained).toEqual([]);
    expect(persist.mock.calls).toEqual(orphaned ? [[[]]] : []);
    expect(mocks.command).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "finishes retirement before binding removal (retained=%s)",
  async (orphaned) => {
    mocks.read.mockResolvedValue({ entries: [] });
    retained = orphaned ? [{ name: "gone", id }] : [];
    const authority = new AbortController();
    const custody = await quiesce({ assertCurrent: () => authority.signal.throwIfAborted() });
    await custody.retire();
    expect(retained).toEqual([]);
    expect(persist.mock.calls).toEqual(orphaned ? [[[]]] : []);
    authority.abort(new Error("workspace removed"));
    await expect(custody.resume()).resolves.toBeUndefined();
    expect(mocks.command).not.toHaveBeenCalled();
  },
);

it("keeps receipt recovery available when retirement cleanup fails", async () => {
  mocks.read.mockResolvedValue({ entries: [] });
  retained = [{ name: "gone", id }];
  persist.mockImplementationOnce(() => {
    throw new Error("receipt cleanup failed");
  });
  const custody = await quiesce();
  await expect(custody.retire()).rejects.toThrow("receipt cleanup failed");
  expect(retained).toEqual([{ name: "gone", id }]);
  await custody.resume();
  expect(retained).toEqual([]);
});

it("records each released generation before a later resume failure and re-fences running recovery", async () => {
  const otherId = "b".repeat(64);
  let failFirst = true;
  mocks.read.mockResolvedValue({ entries: [entry, { ...entry, containerName: "other" }] });
  const pausedIds = mockEngine({ owned: id, other: otherId }, ({ action, target }) => {
    if (action === "unpause" && target === id && failFirst) {
      return { code: 1, stdout: "", stderr: "temporary engine fault" };
    }
    return undefined;
  });
  const { resume } = await quiesce();
  await expect(resume()).rejects.toThrow("resume failed");
  expect(retained).toEqual([{ name: "owned", id }]);
  failFirst = false;
  const { resume: recovered } = await quiesce();
  expect(pausedIds).toEqual(new Set([id, otherId]));
  await recovered();
  expect({ retained, paused: [...pausedIds] }).toEqual({ retained: [], paused: [] });
});

it.each(["inspect", "pause", "resume-inspect", "unpause"])(
  "bounds a hung %s, joins command cleanup, and preserves uncertain custody for recovery",
  async (phase) => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    const entered = createDeferred();
    const cleanup = createDeferred();
    const abortedCommand = Object.assign(new Error("Aborted"), { name: "AbortError" });
    let fail = true;
    let aborted = false;
    const settled = vi.fn();
    const paused = mockEngine({ owned: id }, async ({ action, apply, signal: commandSignal }) => {
      const signal = expectDefined(commandSignal, "bounded engine command signal");
      signal.throwIfAborted();
      // The engine may accept a mutation before its client stops responding.
      const result = apply();
      if (fail && action === phase) {
        fail = false;
        entered.resolve();
        await once(signal, "abort");
        aborted = true;
        await cleanup.promise;
        throw abortedCommand;
      }
      return result;
    });
    const operation = quiesce()
      .then((control) => control.resume())
      .catch((error: unknown) => error)
      .finally(settled);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      cleanup.resolve();
      expect(await operation).toBe(abortedCommand);
      expect(retained).toEqual(phase === "inspect" ? [] : [{ name: "owned", id }]);
      await (await quiesce()).resume();
      expect({ retained, paused: [...paused] }).toEqual({ retained: [], paused: [] });
    } finally {
      cleanup.resolve();
      timeout.mockRestore();
      vi.useRealTimers();
    }
  },
);

it.each([
  ["inspect", "registry", false, "retired"],
  ["inspect", "engine", false, "could not be inspected"],
  ["resume", "workspace", false, "revoked"],
  ["resume", "registry", false, "runtime retired"],
  ["resume", "registry", true, "runtime retired"],
] as const)("fences %s after %s loss (removed=%s)", async (phase, owner, removed, error) => {
  const authority = new AbortController();
  mockEngine({ owned: id }, ({ action }) => {
    if (phase === "inspect") {
      if (owner === "engine") {
        return { code: 125, stdout: "", stderr: "connection refused" };
      }
      authority.abort(new Error(error));
    }
    if (action === "resume-inspect" && removed) {
      return { code: 1, stdout: "", stderr: "no such container" };
    }
    return undefined;
  });
  const assertCurrent = () => authority.signal.throwIfAborted();
  mocks.current.mockImplementation(owner === "registry" ? assertCurrent : () => {});
  const prepare = () =>
    quiesce({ assertCurrent: owner === "workspace" ? assertCurrent : () => {} });
  if (phase === "inspect") {
    await expect(prepare()).rejects.toThrow(error);
    expect(mocks.command).toHaveBeenCalledOnce();
  } else {
    const { resume } = await prepare();
    authority.abort(new Error(error));
    if (removed) {
      await resume();
      expect(persist).toHaveBeenLastCalledWith([]);
    } else {
      await expect(resume()).rejects.toThrow(error);
      expect(persist).toHaveBeenLastCalledWith([{ name: "owned", id }]);
    }
  }
  expect(commands("unpause")).toHaveLength(0);
});

it("fences a dedicated stream writer and requires settlement before retiring its workspace", async () => {
  const childId = "b".repeat(64);
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const target = {
    kind: "docker" as const,
    endpoint: "unix:///synthetic/docker.sock",
    daemonId: "daemon",
  };
  const record: SandboxPersistentExecRecord = {
    ownerKey: "stream",
    sourceIdentity: "source",
    attemptId,
    backendId: "docker",
    containerId: id,
    containerName: entry.containerName,
    containerStartedAt: "2026-01-01T00:00:00Z",
    backendTarget: target,
    workspaceBinding: {
      workspaceDir: entry.workspaceDir,
      workspaceSource: "managed-worktree",
      registryCreatedAtMs: 1,
    },
    owner: { pid: 1, host: "synthetic", startedAt: 1, namespace: "synthetic", token: "synthetic" },
    revision: 1,
    phase: "running",
    error: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    receipt: { version: 1, target, attemptId, parentContainerId: id, containerId: childId },
  };
  mocks.custody.mockResolvedValue([record]);
  mockEngine({ owned: id, [`openclaw-stream-${attemptId}`]: childId }, () => {});
  const persistCustody = vi.fn();
  const { resume, retire } = await quiesce({ persist: persistCustody });
  expect(persistCustody).toHaveBeenLastCalledWith([
    { name: entry.containerName, id },
    { name: `openclaw-stream-${attemptId}`, id: childId },
  ]);
  expect(commands("pause")).toEqual([id, childId].map((runtimeId) => ["pause", runtimeId]));
  await expect(retire()).rejects.toThrow("Settle persistent streams");
  expect(commands("rm")).toEqual([]);
  await resume();
  expect(commands("unpause")).toEqual([childId, id].map((runtimeId) => ["unpause", runtimeId]));
  expect(mocks.custodyCurrent).toHaveBeenCalledWith(record);
  expect(persistCustody).toHaveBeenLastCalledWith([]);

  const imageRead = {
    workspaceDir: entry.workspaceDir,
    containerRoot: "/workspace",
    targets: ["/workspace/image.png"],
    assertCurrent: () => {},
  };
  const assertImageCurrent = await prepareLocalWorkspaceImageRead(imageRead);
  expect(mocks.imageBacking).toHaveBeenCalledOnce();
  expect(mocks.imageBacking).toHaveBeenCalledWith(
    expect.objectContaining({ containerName: entry.containerName }),
  );
  mocks.liveCurrent.mockImplementation(() => {
    throw new Error("parent retired");
  });
  expect(assertImageCurrent).toThrow("parent retired");
  mocks.read.mockResolvedValue({ entries: [] });
  await expect(prepareLocalWorkspaceImageRead(imageRead)).rejects.toThrow(
    "Sandbox image backing is unavailable",
  );
  expect(mocks.imageBacking).toHaveBeenCalledOnce();
});
