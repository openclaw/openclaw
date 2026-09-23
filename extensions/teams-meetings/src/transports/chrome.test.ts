import { defineMeetingChromeCleanupTests } from "openclaw/plugin-sdk/test-fixtures";
import { describe, vi } from "vitest";
import { teamsMeetingsConfig } from "../config.js";

const resolveTeamsMeetingsConfig = teamsMeetingsConfig.resolveConfig;

const engineMocks = vi.hoisted(() => ({
  localDispose: vi.fn(async () => {}),
  nodeDispose: vi.fn(async () => {}),
  startAgent: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  const transport = (dispose: () => Promise<void>) => ({
    clearOutput: vi.fn(async () => {}),
    dispose,
    onFatal: vi.fn(),
    startInput: vi.fn(),
    stop: dispose,
    writeOutput: vi.fn(async () => {}),
  });
  return {
    ...original,
    MeetingPlatformAdapter: {
      ...original.MeetingPlatformAdapter,
      createChromeRuntimeBindings: () => ({
        createBindings: original.createMeetingRealtimeEngineBindings,
        createLocalAudioTransport: () => transport(engineMocks.localDispose),
        createNodeAudioTransport: () => transport(engineMocks.nodeDispose),
        startAgentRealtimeEngine: engineMocks.startAgent,
        startRealtimeEngine: original.startMeetingRealtimeEngine,
      }),
    },
  };
});

import { launchTeamsMeetingInChrome, launchTeamsMeetingOnNode } from "./chrome.js";

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_rollback%40thread.v2/0";

describe("Microsoft Teams meeting Chrome startup cleanup", () => {
  defineMeetingChromeCleanupTests({
    url: URL,
    tabId: "teams-tab",
    title: "Teams",
    nodeCommand: "teamsmeetings.chrome",
    preserveTrackedBrowser: false,
    resolveConfig: resolveTeamsMeetingsConfig,
    launchInChrome: launchTeamsMeetingInChrome,
    launchOnNode: launchTeamsMeetingOnNode,
    engineMocks,
  });
});
