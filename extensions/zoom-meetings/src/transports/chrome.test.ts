import { defineMeetingChromeCleanupTests } from "openclaw/plugin-sdk/test-fixtures";
import { describe, vi } from "vitest";
import { zoomMeetingsConfig } from "../config.js";

const resolveZoomMeetingsConfig = zoomMeetingsConfig.resolveConfig;

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

import { launchZoomMeetingInChrome, launchZoomMeetingOnNode } from "./chrome.js";

const URL = "https://zoom.us/j/12345678905?pwd=rollback";

describe("Zoom meeting Chrome startup cleanup", () => {
  defineMeetingChromeCleanupTests({
    url: URL,
    tabId: "zoom-tab",
    title: "Zoom",
    nodeCommand: "zoommeetings.chrome",
    preserveTrackedBrowser: true,
    resolveConfig: resolveZoomMeetingsConfig,
    launchInChrome: launchZoomMeetingInChrome,
    launchOnNode: launchZoomMeetingOnNode,
    engineMocks,
  });
});
