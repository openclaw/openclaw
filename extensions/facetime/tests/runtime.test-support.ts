import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  helperParams: undefined as
    | undefined
    | {
        onMessage(message: unknown, peer?: unknown): void | Promise<void>;
        onConnect(bundleIdentifier: string): void;
        onDisconnect(bundleIdentifier: string): void;
      },
  helper: {
    connectedSockets: 2,
    connectedHelperBundles: ["com.apple.FaceTime", "com.apple.mobilephone"],
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    answerCall: vi.fn(),
    leaveCall: vi.fn(),
    safetyMute: vi.fn(),
    setMuted: vi.fn(),
    startTransmission: vi.fn(),
    inspectCall: vi.fn(),
    startCall: vi.fn(),
    findOutgoingCall: vi.fn(),
    cancelOutgoingCall: vi.fn(),
  },
  startTalk: vi.fn(),
  systemRun: vi.fn(),
  carrierProcessAlive: false,
  warn: vi.fn(),
}));

export { mocks };

vi.mock("../src/helper-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/helper-rpc.js")>();
  return {
    ...actual,
    FaceTimeHelperSocketServer: vi.fn(function (params: NonNullable<typeof mocks.helperParams>) {
      mocks.helperParams = params;
      return mocks.helper;
    }),
  };
});

vi.mock("../src/helper-supervisor.js", () => ({
  FaceTimeHelperSupervisor: class FaceTimeHelperSupervisor {
    start() {}
    stop() {}
    status() {
      const connected = new Set(mocks.helper.connectedHelperBundles);
      return [
        {
          target: "FaceTime",
          connected:
            connected.has("com.apple.FaceTime") ||
            connected.has("com.apple.FaceTime.FTConversationService"),
        },
        {
          target: "Phone",
          connected:
            connected.has("com.apple.mobilephone") || connected.has("com.apple.TelephonyUtilities"),
        },
      ];
    }
    connected() {}
    disconnected() {}
    stale() {}
  },
}));

vi.mock("../src/plugin-paths.js", () => ({
  ensureCaptureBinary: vi.fn(async () => "/usr/bin/true"),
  ensureHelperArtifacts: vi.fn(async () => ({ buildId: "build", ipcKey: "key" })),
}));

vi.mock("../src/driver-setup.js", () => ({
  installFaceTimeDriver: vi.fn(async () => ({ changed: false })),
}));

vi.mock("../src/preflight.js", () => ({
  runFaceTimePreflight: vi.fn(async () => ({ ok: true, checks: [] })),
}));

vi.mock("../src/setup.js", () => ({
  runFaceTimeSetup: vi.fn(async () => ({ status: "ready", checks: [] })),
}));

vi.mock("../src/talk-driver.js", () => ({
  startFaceTimeTalkDriver: mocks.startTalk,
}));

vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...actual,
    validateFaceTimeConfig(config: import("../src/config.js").FaceTimeConfig) {
      const validation = actual.validateFaceTimeConfig(config);
      const errors = validation.errors.filter((error) => error !== "facetime requires macOS");
      return { valid: errors.length === 0, errors };
    },
  };
});

import { resolveFaceTimeConfig } from "../src/config.js";
export { FaceTimeHelperActionError } from "../src/helper-results.js";
import { createFaceTimeRuntime } from "../src/runtime.js";

export function completeAction(owner: Record<string, unknown>) {
  return {
    helpersContacted: 2,
    topologyGeneration: 1,
    topologyComplete: true,
    helperResults: [owner, { outcome: "absent", found: false }],
    ...owner,
  };
}

export function completeSharedAction(owner: Record<string, unknown>) {
  return {
    helpersContacted: 2,
    topologyGeneration: 1,
    topologyComplete: true,
    helperResults: [
      { ...owner, helperBundleIdentifier: "com.apple.FaceTime" },
      { ...owner, helperBundleIdentifier: "com.apple.mobilephone" },
    ],
    ...owner,
  };
}

export function completeAbsence() {
  return {
    helpersContacted: 2,
    topologyGeneration: 1,
    topologyComplete: true,
    helperResults: [
      { outcome: "absent", found: false },
      { outcome: "absent", found: false },
    ],
  };
}

export async function pendingDialState(overrides: Record<string, unknown> = {}) {
  const store = createPluginStateKeyedStoreForTests<unknown>("facetime", {
    namespace: "pending-dial",
    maxEntries: 1,
    overflowPolicy: "reject-new",
  });
  await store.register("active", {
    dialID: "approved-dial",
    version: 1,
    ownerEpoch: 1,
    handle: "owner@example.com",
    mode: "audio",
    delivery: "accepted",
    requestedAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  });
  return store;
}

export function pendingDialCarrierResult() {
  return {
    helpersContacted: 2,
    topologyGeneration: 1,
    topologyComplete: true,
    helperResults: [
      {
        found: true,
        call_uuid: "approved-call",
        helperBundleIdentifier: "com.apple.FaceTime",
        helperPeer: {
          bundleIdentifier: "com.apple.FaceTime",
          processId: 4321,
          processStartedAtMs: Date.parse("Tue Nov 14 22:13:20 2023"),
          connectionGeneration: 7,
        },
      },
      {
        found: false,
        helperBundleIdentifier: "com.apple.mobilephone",
      },
    ],
  };
}

export function pendingDialCancellationResult() {
  return {
    helpersContacted: 2,
    helperResults: [
      {
        helperBundleIdentifier: "com.apple.FaceTime",
        cancelled: true,
        tombstoned: true,
        found: false,
      },
      { helperBundleIdentifier: "com.apple.mobilephone", cancelled: false, found: false },
    ],
  };
}

export function incomingCall(status = 4) {
  return {
    event: "ft-call-status-changed",
    data: {
      call_uuid: "call-1",
      call_status: status,
      has_ended: status === 6,
      is_outgoing: false,
      is_sending_audio: false,
      handle: { value: "owner@example.com" },
      transport: {
        kind: "facetime",
        classifier_version: "tu-provider-v1",
        service: 2,
        facetime_transport_type: 1,
        provider_classified: true,
        provider_is_facetime: true,
        provider_is_telephony: false,
        is_using_baseband: false,
        is_wifi_call: false,
        is_voip: true,
        is_emergency: false,
      },
    },
  };
}

export async function createRuntime(
  state: PluginStateKeyedStore<unknown> = createPluginStateKeyedStoreForTests<unknown>("facetime", {
    namespace: "pending-dial",
    maxEntries: 1,
    overflowPolicy: "reject-new",
  }),
  ownerHandles = ["owner@example.com"],
) {
  return await createFaceTimeRuntime({
    config: resolveFaceTimeConfig({ ownerHandles }),
    fullConfig: {} as never,
    runtime: {
      system: {
        runCommandWithTimeout: mocks.systemRun,
      },
      state: {
        openKeyedStore: () => state,
      },
    } as never,
    logger: {
      info: vi.fn(),
      warn: mocks.warn,
      debug: vi.fn(),
      error: vi.fn(),
    },
    pluginRoot: "/plugin",
  });
}

export function createTalkDriver(params: {
  readyForAudio?: () => Promise<void>;
  order?: string[];
}) {
  let realtimeActive = false;
  return {
    callUUID: "call-1",
    recentTalkEvents: [],
    readyForAudio: vi.fn(async () => {
      params.order?.push("provider-and-route-readiness");
      await params.readyForAudio?.();
      realtimeActive = true;
    }),
    processOutputSuppressed: vi.fn(() => true),
    realtimeActive: vi.fn(() => realtimeActive),
    activate: vi.fn(() => {
      params.order?.push("activate");
    }),
    suspendMedia: vi.fn(async () => {
      realtimeActive = false;
    }),
    close: vi.fn(async () => {
      realtimeActive = false;
    }),
  };
}

afterAll(() => resetPluginStateStoreForTests());

export async function resetRuntimeTestState() {
  resetPluginStateStoreForTests({ closeDatabase: false });
  await createPluginStateKeyedStoreForTests<unknown>("facetime", {
    namespace: "pending-dial",
    maxEntries: 1,
    overflowPolicy: "reject-new",
  }).clear();
  vi.clearAllMocks();
  mocks.helperParams = undefined;
  mocks.helper.connectedSockets = 2;
  mocks.helper.connectedHelperBundles = ["com.apple.FaceTime", "com.apple.mobilephone"];
  mocks.carrierProcessAlive = false;
  const exitedCarrierPids = new Set<string>();
  mocks.systemRun.mockImplementation(async (argv: string[]) => {
    const pid = argv[2];
    if (!pid) {
      throw new Error("Expected a carrier process ID");
    }
    if (argv[0] === "/bin/ps") {
      if (exitedCarrierPids.has(pid)) {
        return { code: 1, stdout: "", stderr: "" };
      }
      return argv.includes("lstart=")
        ? { code: 0, stdout: "Tue Nov 14 22:13:20 2023\n", stderr: "" }
        : {
            code: 0,
            stdout: "/System/Applications/FaceTime.app/Contents/MacOS/FaceTime\n",
            stderr: "",
          };
    }
    if (argv[0] === "/bin/kill" && !mocks.carrierProcessAlive) {
      exitedCarrierPids.add(pid);
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  mocks.helper.answerCall.mockResolvedValue(
    completeAction({ outcome: "answered-muted", muted: true, is_uplink_muted: true }),
  );
  mocks.helper.setMuted.mockResolvedValue(
    completeAction({ outcome: "media-configured", muted: false, is_uplink_muted: false }),
  );
  mocks.helper.startTransmission.mockResolvedValue(
    completeAction({
      outcome: "media-active",
      muted: false,
      is_uplink_muted: false,
      is_sending_audio: true,
      is_sending_transmission: true,
    }),
  );
  mocks.helper.safetyMute.mockResolvedValue(
    completeAction({
      outcome: "safe-muted",
      downlink_muted: true,
      muted: true,
      is_uplink_muted: true,
    }),
  );
  mocks.helper.leaveCall.mockResolvedValue(completeAction({ outcome: "termination-requested" }));
  mocks.helper.inspectCall.mockResolvedValue(completeAbsence());
}
