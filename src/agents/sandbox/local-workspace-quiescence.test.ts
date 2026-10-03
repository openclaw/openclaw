import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  current: vi.fn(),
  read: vi.fn(),
  browsers: vi.fn(),
  browserCurrent: vi.fn(),
}));
vi.mock("./registry.js", () => ({
  readRegistry: mocks.read,
  readBrowserRegistry: mocks.browsers,
  assertSandboxRegistryEntryCurrent: mocks.current,
  assertSandboxBrowserRegistryEntryCurrent: mocks.browserCurrent,
}));
vi.mock("./docker.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker" },
  bindPodmanSandboxEngine: () => ({ id: "podman" }),
  execContainer: mocks.command,
  validateSandboxContainerEngineTarget: async () => {},
}));
import { quiesceLocalWorkspace } from "./local-workspace-quiescence.js";
const id = "a".repeat(64);
const entry = {
  containerName: "owned",
  backendId: "docker",
  sessionKey: "owner",
  workspaceDir: "/owned/projection",
};
beforeEach(() => {
  mocks.command.mockReset();
  mocks.current.mockReset();
  mocks.read.mockReset().mockResolvedValue({ entries: [entry] });
  mocks.browsers.mockReset().mockResolvedValue({ entries: [] });
  mocks.browserCurrent.mockReset();
});

it.each(["true", "false"])(
  "recovers its recorded paused generation (Running=%s) but never adopts a foreign pause",
  async (running) => {
    mocks.command.mockImplementation(async (_engine, args: string[]) => ({
      code: 0,
      stdout: args.includes("{{.State.Paused}}") ? "true" : id + ` ${running} true`,
      stderr: "",
    }));
    const input = { workspaceDir: "/owned/projection", persist: vi.fn(), assertCurrent: () => {} };
    await expect(quiesceLocalWorkspace({ ...input, retained: [] })).rejects.toThrow(
      "another owner",
    );
    const { resume } = await quiesceLocalWorkspace({ ...input, retained: [{ name: "owned", id }] });
    await resume();
    expect(mocks.command.mock.calls.some((call) => call[1][0] === "pause")).toBe(false);
    expect(mocks.command.mock.calls.some((call) => call[1][0] === "unpause")).toBe(true);
  },
);

it.each([
  { failure: "retired", error: "retired" },
  { failure: "engine", error: "could not be inspected" },
])("rejects $failure inspection before pausing", async ({ failure, error }) => {
  mocks.command.mockImplementation(async () => {
    if (failure === "engine") {
      return { code: 125, stdout: "", stderr: "connection refused" };
    }
    mocks.current.mockImplementation(() => {
      throw new Error("retired");
    });
    return { code: 0, stdout: id + " true false", stderr: "" };
  });
  await expect(
    quiesceLocalWorkspace({
      workspaceDir: "/owned/projection",
      retained: [],
      persist: () => {},
      assertCurrent: () => {},
    }),
  ).rejects.toThrow(error);
  expect(mocks.command).toHaveBeenCalledOnce();
});

it("persists exact container and browser custody before pausing and resumes only those IDs", async () => {
  const browserId = "b".repeat(64);
  const retained = [
    { name: "owned", id },
    { name: "browser-owned", id: browserId },
  ];
  const persist = vi.fn();
  mocks.browsers.mockResolvedValue({
    entries: [
      { ...entry, containerName: "browser-owned" },
      { ...entry, containerName: "foreign", workspaceDir: "/other" },
    ],
  });
  mocks.command.mockImplementation(async (_engine, args: string[]) => {
    if (args[0] === "pause") {
      expect(persist).toHaveBeenLastCalledWith(args[1] === id ? retained.slice(0, 1) : retained);
    }
    return {
      code: 0,
      stderr: "",
      stdout: args.includes("{{.State.Paused}}")
        ? "true"
        : args[0] === "inspect"
          ? `${args.at(-1) === "browser-owned" ? browserId : id} true false`
          : "",
    };
  });
  const { resume } = await quiesceLocalWorkspace({
    workspaceDir: entry.workspaceDir,
    retained: [],
    persist,
    assertCurrent: () => {},
  });
  expect(persist).toHaveBeenLastCalledWith(retained);
  expect(mocks.browserCurrent).toHaveBeenCalledTimes(3);
  await resume();
  expect(
    mocks.command.mock.calls.filter((call) => call[1][0] === "unpause").map((call) => call[1][1]),
  ).toEqual([browserId, id]);
  expect(mocks.command.mock.calls.map((call) => call[1][0])).toEqual([
    "inspect",
    "pause",
    "inspect",
    "pause",
    "inspect",
    "unpause",
    "inspect",
    "unpause",
  ]);
  expect(mocks.command.mock.calls[7]?.[1]).toEqual(["unpause", id]);
  expect(persist).toHaveBeenLastCalledWith([]);
});

it("records each released generation before a later resume failure and re-fences running recovery", async () => {
  const otherId = "b".repeat(64);
  const pausedIds = new Set<string>();
  let retained: Array<{ name: string; id: string }> = [];
  let failFirst = true;
  mocks.read.mockResolvedValue({ entries: [entry, { ...entry, containerName: "other" }] });
  mocks.command.mockImplementation(async (_engine, args: string[]) => {
    const runtimeId = args.at(-1) === "other" || args.at(-1) === otherId ? otherId : id;
    if (args.includes("{{.State.Paused}}")) {
      return { code: 0, stdout: String(pausedIds.has(runtimeId)), stderr: "" };
    }
    if (args[0] === "inspect") {
      return { code: 0, stdout: runtimeId + " true " + pausedIds.has(runtimeId), stderr: "" };
    }
    if (args[0] === "pause") {
      pausedIds.add(args[1]!);
    }
    if (args[0] === "unpause") {
      if (args[1] === id && failFirst) {
        return { code: 1, stdout: "", stderr: "temporary engine fault" };
      }
      if (!pausedIds.delete(args[1]!)) {
        return { code: 1, stdout: "", stderr: "container is not paused" };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const input = {
    workspaceDir: entry.workspaceDir,
    assertCurrent: () => {},
    persist: (rows: typeof retained) => {
      retained = [...rows];
    },
  };
  const { resume } = await quiesceLocalWorkspace({ ...input, retained });
  await expect(resume()).rejects.toThrow("resume failed");
  expect(retained).toEqual([{ name: "owned", id }]);
  failFirst = false;
  const { resume: recovered } = await quiesceLocalWorkspace({ ...input, retained });
  expect(pausedIds).toEqual(new Set([id, otherId]));
  await recovered();
  expect(retained).toEqual([]);
  expect(pausedIds.size).toBe(0);
});

it.each([
  { owner: "workspace", removed: false, error: "revoked" },
  { owner: "registry", removed: false, error: "runtime retired" },
  { owner: "registry", removed: true, error: "runtime retired" },
])(
  "does not unpause a retired $owner owner (engine removed=$removed)",
  async ({ owner, removed, error }) => {
    let retiring = false;
    mocks.command.mockImplementation(async (_engine, args: string[]) => {
      if (args.includes("{{.State.Paused}}")) {
        return removed
          ? { code: 1, stdout: "", stderr: "no such container" }
          : { code: 0, stdout: "true", stderr: "" };
      }
      return { code: 0, stdout: args[0] === "inspect" ? id + " true false" : "", stderr: "" };
    });
    mocks.current.mockImplementation(() => {
      if (retiring && owner === "registry") {
        throw new Error("runtime retired");
      }
    });
    const persist = vi.fn();
    const { resume } = await quiesceLocalWorkspace({
      workspaceDir: entry.workspaceDir,
      retained: [],
      persist,
      assertCurrent: () => {
        if (retiring && owner === "workspace") {
          throw new Error("revoked");
        }
      },
    });
    retiring = true;
    if (removed) {
      await resume();
      expect(persist).toHaveBeenLastCalledWith([]);
    } else {
      await expect(resume()).rejects.toThrow(error);
      expect(persist).toHaveBeenLastCalledWith([{ name: "owned", id }]);
    }
    expect(mocks.command.mock.calls.some((call) => call[1][0] === "unpause")).toBe(false);
  },
);
