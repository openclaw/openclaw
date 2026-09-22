import { createMeetingNodeBrowserFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { zoomMeetingsConfig } from "./config.js";

const resolveZoomMeetingsConfig = zoomMeetingsConfig.resolveConfig;

const realtimeMocks = vi.hoisted(() => ({
  healths: [] as Array<{ bridgeClosed: boolean }>,
  speak: vi.fn(),
  startAgent: vi.fn(async ({ transport }: { transport: { stop(): Promise<void> } }) => {
    const health = { bridgeClosed: false };
    realtimeMocks.healths.push(health);
    return {
      getHealth: () => health,
      providerId: "test",
      speak: realtimeMocks.speak,
      stop: vi.fn(() => transport.stop()),
    };
  }),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  return {
    ...original,
    MeetingPlatformAdapter: {
      ...original.MeetingPlatformAdapter,
      createChromeRuntimeBindings: () => ({
        createBindings: original.createMeetingRealtimeEngineBindings,
        createLocalAudioTransport: original.createLocalMeetingRealtimeAudioTransport,
        createNodeAudioTransport: () => ({
          clearOutput: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
          onFatal: vi.fn(),
          startInput: vi.fn(),
          stop: vi.fn(async () => {}),
          writeOutput: vi.fn(async () => {}),
        }),
        startAgentRealtimeEngine: realtimeMocks.startAgent,
        startRealtimeEngine: original.startMeetingRealtimeEngine,
      }),
    },
  };
});

import { ZoomMeetingsRuntime } from "./runtime.js";

const URL = "https://zoom.us/j/12345678903?pwd=node";

describe("Zoom meetings node realtime recovery", () => {
  it("starts the node bridge after manual admission becomes route-ready", async () => {
    const harness = createMeetingNodeBrowserFixture({
      url: URL,
      tabId: "zoom-tab",
      title: "Zoom",
      nodeCommand: "zoommeetings.chrome",
      status: (state) =>
        state.inCall
          ? {
              audioInputRouted: true,
              audioOutputRouted: true,
              inCall: true,
              micMuted: false,
              url: state.tabUrl,
            }
          : {
              inCall: false,
              manualAction: {
                reason: "zoom-admission-required",
                message: "Waiting for admission",
              },
              url: state.tabUrl,
            },
    });
    harness.state.inCall = false;
    const runtime = new ZoomMeetingsRuntime({
      config: resolveZoomMeetingsConfig({
        chrome: { waitForInCallMs: 1 },
        chromeNode: { node: "node-1" },
        realtime: { agentId: "consult" },
      }),
      fullConfig: {},
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      runtime: harness.runtime,
    });

    const joined = await runtime.join({
      agentId: "support",
      message: undefined,
      mode: "agent",
      requesterSessionKey: "agent:support:session:caller",
      transport: "chrome-node",
      url: URL,
    });
    expect(joined.session.chrome?.audioBridge).toBeUndefined();
    harness.state.inCall = true;

    const spoken = await runtime.speak(joined.session.id, "hello");

    expect(spoken.spoken).toBe(true);
    expect(joined.session.agentId).toBe("support");
    expect(realtimeMocks.startAgent).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          realtime: expect.objectContaining({ agentId: "support" }),
        }),
        requesterSessionKey: "agent:support:session:caller",
      }),
    );
    expect(realtimeMocks.speak).toHaveBeenCalledWith("hello");
    expect(joined.session.chrome?.audioBridge).toMatchObject({ type: "node-command-pair" });

    const firstEngine = await realtimeMocks.startAgent.mock.results[0]?.value;
    if (!firstEngine) {
      throw new Error("Expected the initial meeting engine");
    }
    await firstEngine.stop();
    realtimeMocks.healths[0]!.bridgeClosed = true;
    await runtime.status(joined.session.id);
    const recovered = await runtime.speak(joined.session.id, "again");

    expect(recovered.spoken).toBe(true);
    expect(realtimeMocks.startAgent).toHaveBeenCalledTimes(2);
    expect(realtimeMocks.speak).toHaveBeenCalledWith("again");
    expect(joined.session.chrome?.health?.bridgeClosed).toBe(false);
    expect(harness.state.audioCaptureId).toEqual(expect.any(String));
    await runtime.leave(joined.session.id);
    expect(harness.state.audioCaptureId).toBeUndefined();
  });
});
