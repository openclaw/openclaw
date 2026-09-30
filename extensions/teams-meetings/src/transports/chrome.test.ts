import { defineMeetingChromeCleanupTests } from "openclaw/plugin-sdk/test-fixtures";
import { describe, vi } from "vitest";
import { teamsMeetingsPlugin } from "../../index.js";

const resolveTeamsMeetingsConfig = teamsMeetingsPlugin.config.resolveConfig;

const engineMocks = vi.hoisted(() => ({
  localDispose: vi.fn(async () => {}),
  nodeDispose: vi.fn(async () => {}),
  startAgent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  const adapter = original.MeetingPlatformAdapter;
  const transport = (dispose: () => Promise<void>) => ({
    clearOutput: vi.fn(async () => {}),
    dispose,
    onFatal: vi.fn(),
    startInput: vi.fn(),
    stop: dispose,
    writeOutput: vi.fn(async () => {}),
  });
  const defineBrowserMeetingPlugin: typeof adapter.defineBrowserMeetingPlugin = (spec) =>
    adapter.defineBrowserMeetingPlugin({
      ...spec,
      chromeRuntime: {
        ...adapter.createChromeRuntimeBindings(),
        createLocalAudioTransport: () => transport(engineMocks.localDispose),
        createNodeAudioTransport: () => transport(engineMocks.nodeDispose),
        startAgentRealtimeEngine: engineMocks.startAgent,
      },
    });
  return {
    ...original,
    MeetingPlatformAdapter: { ...adapter, defineBrowserMeetingPlugin },
  };
});

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_rollback%40thread.v2/0";

describe("Microsoft Teams meeting Chrome startup cleanup", () => {
  defineMeetingChromeCleanupTests({
    url: URL,
    tabId: "teams-tab",
    title: "Teams",
    nodeCommand: "teamsmeetings.chrome",
    preserveTrackedBrowser: false,
    resolveConfig: resolveTeamsMeetingsConfig,
    launchInChrome: teamsMeetingsPlugin.chrome.launchInChrome,
    launchOnNode: teamsMeetingsPlugin.chrome.launchOnNode,
    engineMocks,
  });
});
