import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, expect, vi } from "vitest";
import { incomingCall, pendingDial } from "./fixtures.test-support.js";
export { incomingCall } from "./fixtures.test-support.js";

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
  installDriver: vi.fn(async () => ({ changed: false })),
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

// mock-isolation: keep native helper processes outside the synthetic runtime fixture.
vi.mock("../src/helper-supervisor.js", () => ({
  FaceTimeHelperSupervisor: class FaceTimeHelperSupervisor {
    start() {}
    stop() {}
    status() {
      return (
        [
          ["FaceTime", "com.apple.FaceTime", "com.apple.FaceTime.FTConversationService"],
          ["Phone", "com.apple.mobilephone", "com.apple.TelephonyUtilities"],
        ] as const
      ).map(([target, ...bundles]) => ({
        target,
        connected: bundles.some((bundle) => mocks.helper.connectedHelperBundles.includes(bundle)),
      }));
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

vi.mock("../src/driver-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/driver-setup.js")>()),
  installFaceTimeDriver: mocks.installDriver,
}));

vi.mock("../src/preflight.js", () => ({
  runFaceTimePreflight: vi.fn(async () => ({ ok: true, checks: [] })),
}));

vi.mock("../src/setup.js", () => ({
  runFaceTimeSetup: vi.fn(async () => ({ status: "ready", checks: [] })),
}));

// mock-isolation: the fixture supplies audio lifecycle events without native audio devices.
vi.mock("../src/talk-driver.js", () => ({ startFaceTimeTalkDriver: mocks.startTalk }));

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
import { createFaceTimeRuntime } from "../src/runtime.js";

export const carrierPeer = {
  bundleIdentifier: "com.apple.FaceTime",
  processId: 4321,
  processStartedAtMs: Date.parse("Tue Nov 14 22:13:20 2023"),
  connectionGeneration: 7,
};
export const commandResult = (stdout = "", code = 0) => ({ code, stdout, stderr: "" });
export const mutedResult = (outcome: string, muted: boolean) => ({
  outcome,
  muted,
  is_uplink_muted: muted,
});
export const helperResult = <T>(
  helperResults: T[],
  topologyComplete = true,
  topologyGeneration = 1,
) => ({
  helpersContacted: helperResults.length,
  topologyGeneration,
  topologyComplete,
  helperResults,
});

export const completeAction = (owner: Record<string, unknown>) => ({
  ...helperResult([owner, { outcome: "absent", found: false }]),
  ...owner,
});

export const completeSharedAction = (owner: Record<string, unknown>) => ({
  ...helperResult([
    { ...owner, helperBundleIdentifier: "com.apple.FaceTime" },
    { ...owner, helperBundleIdentifier: "com.apple.mobilephone" },
  ]),
  ...owner,
});

export const completeAbsence = () =>
  helperResult([
    { outcome: "absent", found: false },
    { outcome: "absent", found: false },
  ]);

export const emptyState = () =>
  createPluginStateKeyedStoreV2ForTests<unknown>(
    "facetime",
    { namespace: "pending-dial", maxEntries: 1, overflowPolicy: "reject-new" },
    { assertCurrent() {} },
  );

export function expectNotCalled(...functions: unknown[]) {
  for (const fn of functions) {
    expect(fn).not.toHaveBeenCalled();
  }
}

export async function pendingDialState(overrides: Record<string, unknown> = {}) {
  const store = emptyState();
  await store.register("active", { ...pendingDial(), ...overrides });
  return store;
}

export const pendingDialCarrierResult = () =>
  helperResult([
    {
      found: true,
      call_uuid: "approved-call",
      helperBundleIdentifier: "com.apple.FaceTime",
      helperPeer: { ...carrierPeer },
    },
    { found: false, helperBundleIdentifier: "com.apple.mobilephone" },
  ]);

export const pendingDialCancellationResult = (callUUID?: string) => ({
  helpersContacted: 2,
  helperResults: [
    {
      helperBundleIdentifier: "com.apple.FaceTime",
      cancelled: true,
      tombstoned: true,
      found: false,
      ...(callUUID ? { call_uuid: callUUID } : {}),
    },
    { helperBundleIdentifier: "com.apple.mobilephone", cancelled: false, found: false },
  ],
});

export const endedCall = (callUUID: string, identity: { dial_id?: string } = {}) => ({
  event: "ft-call-status-changed",
  data: { call_uuid: callUUID, call_status: 6, has_ended: true, is_outgoing: true, ...identity },
});

export const outgoingCall = (
  callUUID: string,
  callStatus = 1,
  identity: { dial_id?: string; is_sending_audio?: boolean } = {},
) => ({
  event: "ft-call-status-changed",
  data: {
    call_uuid: callUUID,
    call_status: callStatus,
    is_outgoing: true,
    handle: { value: "owner@example.com" },
    transport: incomingCall().data.transport,
    ...identity,
  },
});

export const dialReply = (call_uuid = "outbound-call", extra: Record<string, unknown> = {}) => ({
  call_uuid,
  muted: true,
  is_uplink_muted: true,
  transport: incomingCall().data.transport,
  ...extra,
});

export const createRuntime = (
  state: PluginStateKeyedStore<unknown, 2> = emptyState(),
  ownerHandles = ["owner@example.com"],
  storeOpeners?: {
    openKeyedStoreV2: () => PluginStateKeyedStore<unknown, 2>;
  },
) =>
  createFaceTimeRuntime({
    config: resolveFaceTimeConfig({ ownerHandles }),
    fullConfig: {} as never,
    runtime: {
      system: { runCommandWithTimeout: mocks.systemRun },
      state: storeOpeners ?? {
        openKeyedStoreV2: () => state,
      },
    } as never,
    logger: { info: vi.fn(), warn: mocks.warn, debug: vi.fn(), error: vi.fn() },
    pluginRoot: "/plugin",
  });

export function createTalkDriver(params: {
  readyForAudio?: () => Promise<void>;
  order?: string[];
}) {
  let realtimeActive = false;
  const deactivate = async () => {
    realtimeActive = false;
  };
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
    suspendMedia: vi.fn(deactivate),
    close: vi.fn(deactivate),
  };
}

export function failTalkStartup(until?: Promise<void>) {
  const error = new Error("capture failed during startup");
  const startup: { released: boolean; closure?: Promise<boolean> } = { released: false };
  mocks.startTalk.mockImplementationOnce(
    async (params: { onFailure(error: Error): Promise<boolean> }) => {
      startup.closure = params.onFailure(error);
      void startup.closure.then(() => {
        startup.released = true;
      });
      await (until ? Promise.race([startup.closure, until]) : startup.closure);
      throw error;
    },
  );
  return startup;
}

afterAll(() => resetPluginStateStoreForTests());

export async function resetRuntimeTestState() {
  resetPluginStateStoreForTests({ closeDatabase: false });
  await emptyState().clear();
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
        return commandResult("", 1);
      }
      return argv.includes("lstart=")
        ? commandResult("Tue Nov 14 22:13:20 2023\n")
        : commandResult("/System/Applications/FaceTime.app/Contents/MacOS/FaceTime\n");
    }
    if (argv[0] === "/bin/kill" && !mocks.carrierProcessAlive) {
      exitedCarrierPids.add(pid);
    }
    return commandResult();
  });
  mocks.helper.answerCall.mockResolvedValue(completeAction(mutedResult("answered-muted", true)));
  mocks.helper.setMuted.mockResolvedValue(completeAction(mutedResult("media-configured", false)));
  mocks.helper.startTransmission.mockResolvedValue(
    completeAction({
      ...mutedResult("media-active", false),
      is_sending_audio: true,
      is_sending_transmission: true,
    }),
  );
  mocks.helper.safetyMute.mockResolvedValue(
    completeAction({ ...mutedResult("safe-muted", true), downlink_muted: true }),
  );
  mocks.helper.leaveCall.mockResolvedValue(completeAction({ outcome: "termination-requested" }));
  mocks.helper.inspectCall.mockResolvedValue(completeAbsence());
}
