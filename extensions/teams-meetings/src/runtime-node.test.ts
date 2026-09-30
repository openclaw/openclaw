import {
  createMeetingNodeBrowserFixture,
  useMeetingTestState,
} from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { teamsMeetingsPlugin } from "../index.js";

const resolveTeamsMeetingsConfig = teamsMeetingsPlugin.config.resolveConfig;
const testState = useMeetingTestState(createOpenClawTestState);

const realtimeMocks = vi.hoisted(() => ({
  speak: vi.fn(),
  startAgent: vi.fn(async ({ transport }: { transport: { stop(): Promise<void> } }) => ({
    getHealth: () => ({
      realtimeTranscriptLines: 0,
      recentRealtimeTranscript: [],
      providerConnected: true,
      realtimeReady: true,
      audioInputActive: true,
      audioOutputActive: false,
      lastInputBytes: 0,
      lastOutputBytes: 0,
      suppressedInputBytes: 0,
      recentTalkEvents: [],
      bridgeClosed: false,
    }),
    providerId: "test",
    speak: realtimeMocks.speak,
    stop: vi.fn(() => transport.stop()),
  })),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  const adapter = original.MeetingPlatformAdapter;
  const defineBrowserMeetingPlugin: typeof adapter.defineBrowserMeetingPlugin = (spec) =>
    adapter.defineBrowserMeetingPlugin({
      ...spec,
      chromeRuntime: {
        ...adapter.createChromeRuntimeBindings(),
        createNodeAudioTransport: () => ({
          clearOutput: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
          onFatal: vi.fn(),
          startInput: vi.fn(),
          stop: vi.fn(async () => {}),
          writeOutput: vi.fn(async () => {}),
        }),
        startAgentRealtimeEngine: realtimeMocks.startAgent,
      },
    });
  return {
    ...original,
    MeetingPlatformAdapter: { ...adapter, defineBrowserMeetingPlugin },
  };
});

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_node_resume%40thread.v2/0";

describe("Microsoft Teams meetings node realtime recovery", () => {
  it("starts the node bridge after manual admission becomes route-ready", async () => {
    const harness = createMeetingNodeBrowserFixture({
      url: URL,
      tabId: "teams-tab",
      title: "Teams",
      nodeCommand: "teamsmeetings.chrome",
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
                reason: "teams-admission-required",
                message: "Waiting for admission",
              },
              url: state.tabUrl,
            },
    });
    harness.state.inCall = false;
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const runtime = new teamsMeetingsPlugin.Runtime({
      config: resolveTeamsMeetingsConfig({
        chrome: { waitForInCallMs: 1 },
        chromeNode: { node: "node-1" },
      }),
      fullConfig: {},
      logger,
      runtime: harness.runtime,
    });
    testState.track(runtime, { readWarnings: () => logger.warn.mock.calls });

    const joined = await runtime.join({
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
    expect(realtimeMocks.startAgent).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.startAgent).toHaveBeenCalledWith(
      expect.objectContaining({ requesterSessionKey: "agent:support:session:caller" }),
    );
    expect(realtimeMocks.speak).toHaveBeenCalledWith("hello");
    expect(joined.session.chrome?.audioBridge).toMatchObject({ type: "node-command-pair" });
    expect(harness.state.audioCaptureId).toEqual(expect.any(String));
    await runtime.leave(joined.session.id);
    expect(harness.state.audioCaptureId).toBeUndefined();
  });
});
