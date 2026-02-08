import { afterEach, describe, expect, it, vi } from "vitest";

const noop = () => {};
let lifecycleHandler:
  | ((evt: { stream?: string; runId: string; data?: { phase?: string } }) => void)
  | undefined;

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent.wait") {
      return { status: "timeout" };
    }
    return {};
  }),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: vi.fn((handler: typeof lifecycleHandler) => {
    lifecycleHandler = handler;
    return noop;
  }),
}));

const announceSpy = vi.fn(async () => true);
vi.mock("./subagent-announce.js", () => ({
  runSubagentAnnounceFlow: (...args: unknown[]) => announceSpy(...args),
}));

describe("subagent registry steer restarts", () => {
  afterEach(async () => {
    announceSpy.mockClear();
    lifecycleHandler = undefined;
    const mod = await import("./subagent-registry.js");
    mod.resetSubagentRegistryForTests();
  });

  it("suppresses announce for interrupted runs and only announces the replacement run", async () => {
    const mod = await import("./subagent-registry.js");

    mod.registerSubagentRun({
      runId: "run-old",
      childSessionKey: "agent:main:subagent:steer",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "initial task",
      cleanup: "keep",
    });

    const previous = mod.listSubagentRunsForRequester("agent:main:main")[0];
    expect(previous?.runId).toBe("run-old");

    const marked = mod.markSubagentRunForSteerRestart("run-old");
    expect(marked).toBe(true);

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-old",
      data: { phase: "end" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(announceSpy).not.toHaveBeenCalled();

    const replaced = mod.replaceSubagentRunAfterSteer({
      previousRunId: "run-old",
      nextRunId: "run-new",
      fallback: previous,
    });
    expect(replaced).toBe(true);

    const runs = mod.listSubagentRunsForRequester("agent:main:main");
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe("run-new");

    lifecycleHandler?.({
      stream: "lifecycle",
      runId: "run-new",
      data: { phase: "end" },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(announceSpy).toHaveBeenCalledTimes(1);

    const announce = announceSpy.mock.calls[0]?.[0] as { childRunId?: string };
    expect(announce.childRunId).toBe("run-new");
  });
});
