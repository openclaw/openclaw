import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createContext, runInNewContext, Script } from "node:vm";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  convertMeetingTtsAudioForBridge,
  createLocalMeetingRealtimeAudioTransport,
  createMeetingRealtimeEngineBindings,
  createNodeMeetingRealtimeAudioTransport,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createRequireRecord, useMeetingTestState } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { findGoogleMeetCalendarEvent } from "./src/calendar.js";
import { registerGoogleMeetCli } from "./src/cli.js";
import { resolveGoogleMeetConfig, type GoogleMeetConfig } from "./src/config.js";
import { normalizeMeetUrl } from "./src/meet-url.js";
import { buildGoogleMeetPreflightReport, fetchGoogleMeetArtifacts } from "./src/meet.js";
import {
  createTestMeetRealtimeAudioTransport,
  meetAudioBridge,
  meetBrowserState,
  meetRuntime,
  meetSession,
  MEET_URL,
  MEET_URL_EN,
  stubMeetArtifactsApi,
  testBridgeProcess,
} from "./src/test-support/fixtures.test-helpers.js";
import {
  captureStdout,
  createGoogleMeetToolGatewayForTest,
  getMeetTool,
  invokeGoogleMeetGatewayMethodForTest,
  noopLogger,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import * as chromeTransport from "./src/transports/chrome.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./src/transports/google-meet-platform-adapter.js";
import {
  buildMeetDtmfSequence,
  normalizeDialInNumber,
  prefixDtmfWait,
} from "./src/transports/twilio.js";
import type { GoogleMeetJoinResult, GoogleMeetSession } from "./src/transports/types.js";
import { testing as googleMeetPluginTesting } from "./test-api.js";

let meetingTestState: ReturnType<typeof useMeetingTestState>;

vi.mock("./src/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/runtime.js")>();
  return {
    ...actual,
    GoogleMeetRuntime: class extends actual.GoogleMeetRuntime {
      constructor(...args: ConstructorParameters<typeof actual.GoogleMeetRuntime>) {
        super(...args);
        meetingTestState.track(this, {
          readWarnings: () => vi.mocked(args[0].logger.warn).mock.calls,
        });
      }
    },
  };
});

const TEST_TALKBACK_DEBOUNCE_MS = 900;
const testTempDirs = new Set<string>();

function createIsolatedTestDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  testTempDirs.add(dir);
  return dir;
}

type MeetRealtimeAudioSpawn = NonNullable<
  Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]["spawn"]
>;
type TestMeetVoiceBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

function createTestMeetVoiceProvider(
  options: {
    defaultModel?: string;
    handleBargeIn?: RealtimeVoiceBridge["handleBargeIn"];
    sendUserMessage?: RealtimeVoiceBridge["sendUserMessage"];
    triggerGreeting?: RealtimeVoiceBridge["triggerGreeting"];
  } = {},
) {
  let request: TestMeetVoiceBridgeRequest | undefined;
  const bridge = {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    ...(options.sendUserMessage ? { sendUserMessage: options.sendUserMessage } : {}),
    setMediaTimestamp: vi.fn(),
    ...(options.handleBargeIn ? { handleBargeIn: options.handleBargeIn } : {}),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    ...(options.triggerGreeting ? { triggerGreeting: options.triggerGreeting } : {}),
    isConnected: vi.fn(() => true),
  };
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    autoSelectOrder: 1,
    resolveConfig: ({ rawConfig }) => rawConfig,
    isConfigured: () => true,
    createBridge: (nextRequest) => {
      request = nextRequest;
      return bridge;
    },
  };
  return {
    bridge,
    provider,
    sendAudio: bridge.sendAudio,
    requireRequest: () => {
      if (!request) {
        throw new Error("Expected realtime bridge callbacks");
      }
      return request;
    },
  };
}

function createGoogleMeetTestEngineBindings(params: {
  config: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["config"];
  fullConfig: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["fullConfig"];
  runtime: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["runtime"];
  logger: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["logger"];
}) {
  return createMeetingRealtimeEngineBindings({
    platform: GOOGLE_MEET_PLATFORM_ADAPTER,
    ...params,
  });
}

type TestLocalRealtimeEngineParams = Omit<
  Parameters<typeof startMeetingRealtimeEngine>[0],
  "config" | "consultAgent" | "handleToolCall" | "platform" | "tools" | "transport"
> & {
  config: GoogleMeetConfig;
  spawn?: MeetRealtimeAudioSpawn;
};

async function startTestLocalRealtimeAudioBridge(params: TestLocalRealtimeEngineParams) {
  const { spawn, ...engineParams } = params;
  const transport = createLocalMeetingRealtimeAudioTransport({
    inputCommand: ["capture-meet"],
    outputCommand: ["play-meet"],
    bargeInInputCommand: params.config.chrome.bargeInInputCommand,
    bargeInRmsThreshold: params.config.chrome.bargeInRmsThreshold,
    bargeInPeakThreshold: params.config.chrome.bargeInPeakThreshold,
    bargeInCooldownMs: params.config.chrome.bargeInCooldownMs,
    logger: params.logger,
    logScope: "[google-meet]",
    spawn,
  });
  return await startMeetingRealtimeEngine({
    ...engineParams,
    ...createGoogleMeetTestEngineBindings(engineParams),
    transport,
  });
}

type TestNodeRealtimeEngineParams = Omit<
  Parameters<typeof startMeetingRealtimeEngine>[0],
  "config" | "consultAgent" | "handleToolCall" | "platform" | "tools" | "transport"
> & {
  config: GoogleMeetConfig;
  nodeId: string;
  bridgeId: string;
};

async function startTestNodeRealtimeAudioBridge(params: TestNodeRealtimeEngineParams) {
  const { nodeId, bridgeId, ...engineParams } = params;
  const transport = createNodeMeetingRealtimeAudioTransport({
    runtime: params.runtime,
    nodeId,
    bridgeId,
    logger: params.logger,
    commandName: "googlemeet.chrome",
    logScope: "[google-meet]",
    logPrefix: "node",
  });
  Reflect.set(transport, Symbol.for("openclaw.internal.meeting-node-output-generation.v1"), true);
  return await startMeetingRealtimeEngine({
    ...engineParams,
    ...createGoogleMeetTestEngineBindings(engineParams),
    logPrefix: "node",
    talkSessionId: `google-meet:${params.meetingSessionId}:${bridgeId}:node-realtime`,
    talkContext: { nodeId, bridgeId },
    transport,
  });
}

const voiceCallMocks = vi.hoisted(() => ({
  joinMeetViaVoiceCallGateway: vi.fn(async () => ({
    callId: "call-1",
    dtmfSent: true,
    introSent: true,
  })),
  endMeetingVoiceCallGatewayCall: vi.fn(async () => {}),
  getMeetingVoiceCallGatewayCall: vi.fn(
    async (): Promise<{
      found: boolean;
      call?: { callId: string; state?: string; endedAt?: number; endReason?: string };
    }> => ({
      found: true,
      call: { callId: "call-1" },
    }),
  ),
  isMeetingVoiceCallMissingError: vi.fn((error: unknown) =>
    String(error).includes("Call not found"),
  ),
  speakMeetingViaVoiceCallGateway: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: vi.fn(async (params: { url: string; init?: RequestInit }) => ({
    response: await fetch(params.url, params.init),
    release: vi.fn(async () => {}),
  })),
}));

function jsonResponse(value: unknown): Response {
  return Response.json(value);
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

vi.mock("./src/voice-call-gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/voice-call-gateway.js")>()),
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/meeting-runtime")>();
  return {
    ...actual,
    endMeetingVoiceCallGatewayCall: voiceCallMocks.endMeetingVoiceCallGatewayCall,
    getMeetingVoiceCallGatewayCall: voiceCallMocks.getMeetingVoiceCallGatewayCall,
    isMeetingVoiceCallMissingError: voiceCallMocks.isMeetingVoiceCallMissingError,
    speakMeetingViaVoiceCallGateway: voiceCallMocks.speakMeetingViaVoiceCallGateway,
  };
});

let localBrowserGatewayRequestHandler: NonNullable<
  Parameters<typeof setupGoogleMeetPlugin>[2]
>["gatewayRequestHandler"];

function setup(
  config?: Parameters<typeof setupGoogleMeetPlugin>[1],
  options?: Parameters<typeof setupGoogleMeetPlugin>[2],
) {
  const harness = setupGoogleMeetPlugin(plugin, config, {
    ...options,
    ...(localBrowserGatewayRequestHandler
      ? {
          gatewayAvailable: true,
          gatewayRequestHandler: localBrowserGatewayRequestHandler,
        }
      : {}),
  });
  googleMeetPluginTesting.setCallGatewayFromCliForTests(
    createGoogleMeetToolGatewayForTest(harness.methods),
  );
  googleMeetPluginTesting.setPlatformForTests(() => options?.registerPlatform ?? "darwin");
  return harness;
}

type GoogleMeetSetupOptions = NonNullable<Parameters<typeof setupGoogleMeetPlugin>[2]>;
type NodeInvokeHandler = NonNullable<GoogleMeetSetupOptions["nodesInvokeHandler"]>;
type NodeBrowserRequest = {
  path?: string;
  body?: { targetId?: string; url?: string };
};
type NodeBrowserTab = {
  targetId: string;
  title: string;
  url: string;
};

function createNodeBrowserScenario(params: {
  tabs: NodeBrowserTab[] | (() => NodeBrowserTab[]);
  targetId?: string;
  open?: (request: NodeBrowserRequest) => NodeBrowserTab;
  focus?: boolean;
  grantPermissions?: boolean;
  navigate?: (request: NodeBrowserRequest) => Record<string, unknown>;
  inspect?: (request: NodeBrowserRequest) => Record<string, unknown>;
  nodeCommand?: (command: string, request: NodeBrowserRequest) => unknown;
}): NodeInvokeHandler {
  return async ({ command, params: rawParams }) => {
    const request = rawParams as NodeBrowserRequest;
    if (command !== "browser.proxy") {
      if (!params.nodeCommand) {
        throw new Error(`unexpected command ${command}`);
      }
      return params.nodeCommand(command, request);
    }
    if (request.path === "/tabs") {
      const tabs = typeof params.tabs === "function" ? params.tabs() : params.tabs;
      return { payload: { result: { running: true, tabs } } };
    }
    if (request.path === "/tabs/open" && params.open) {
      return { payload: { result: params.open(request) } };
    }
    if (request.path === "/tabs/focus" && params.focus) {
      return { payload: { result: { ok: true } } };
    }
    if (request.path === "/permissions/grant" && params.grantPermissions) {
      return { payload: { result: { ok: true } } };
    }
    if (request.path === "/navigate" && params.navigate) {
      return { payload: { result: params.navigate(request) } };
    }
    if (request.path === "/act" && params.inspect) {
      return browserProxyPayload({
        ok: true,
        targetId: request.body?.targetId ?? params.targetId,
        result: JSON.stringify(params.inspect(request)),
      });
    }
    throw new Error(`unexpected browser proxy path ${request.path}`);
  };
}

function requireNodeInvocation(
  nodesInvoke: { mock: { calls: unknown[][] } },
  match: { command?: string; path: string },
): Record<string, unknown> {
  const call = nodesInvoke.mock.calls
    .map(([raw]) => requireRecord(raw, "node invoke"))
    .find(
      (entry) =>
        (match.command === undefined || entry.command === match.command) &&
        requireRecord(entry.params, "node invoke params").path === match.path,
    );
  if (!call) {
    throw new Error(`Expected node invoke ${JSON.stringify(match)}`);
  }
  return call;
}

type ChromeMeetLaunchResult = Awaited<ReturnType<typeof chromeTransport.launchChromeMeet>>;
type ChromeMeetLeaveResult = Awaited<ReturnType<typeof chromeTransport.leaveChromeMeet>>;

function mockChromeMeetLifecycle(params: {
  launches: Array<ChromeMeetLaunchResult | Error>;
  leaveResults?: ChromeMeetLeaveResult[];
  watchLeave?: boolean;
}) {
  const launch = vi.spyOn(chromeTransport, "launchChromeMeet");
  for (const result of params.launches) {
    if (result instanceof Error) {
      launch.mockRejectedValueOnce(result);
    } else {
      launch.mockResolvedValueOnce(result);
    }
  }
  const leave =
    params.watchLeave || params.leaveResults
      ? vi.spyOn(chromeTransport, "leaveChromeMeet")
      : undefined;
  for (const result of params.leaveResults ?? []) {
    leave?.mockResolvedValueOnce(result);
  }
  return { launch, leave };
}

function createChromeLifecycleRuntime(config: Record<string, unknown> = {}) {
  return meetRuntime(
    {
      defaultTransport: "chrome",
      defaultMode: "agent",
      realtime: { introMessage: "" },
      ...config,
    },
    noopLogger,
  );
}

const GOOGLE_MEET_ENV_KEYS = [
  "OPENCLAW_GOOGLE_MEET_CLIENT_ID",
  "GOOGLE_MEET_CLIENT_ID",
  "OPENCLAW_GOOGLE_MEET_CLIENT_SECRET",
  "GOOGLE_MEET_CLIENT_SECRET",
  "OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN",
  "GOOGLE_MEET_REFRESH_TOKEN",
  "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN",
  "GOOGLE_MEET_ACCESS_TOKEN",
  "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT",
  "GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT",
  "OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING",
  "GOOGLE_MEET_DEFAULT_MEETING",
  "OPENCLAW_GOOGLE_MEET_PREVIEW_ACK",
  "GOOGLE_MEET_PREVIEW_ACK",
] as const;

function resolveGoogleMeetConfigFromTestEnv(env: Record<string, string>) {
  for (const key of GOOGLE_MEET_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return resolveGoogleMeetConfig({});
}

type MockSessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  [key: string]: unknown;
};

function createMockSessionRuntime(sessionStore: Record<string, unknown>) {
  const sessionRoot = createIsolatedTestDir("openclaw-google-meet-session-");
  return {
    resolveStorePath: vi.fn(() => path.join(sessionRoot, "sessions.json")),
    loadSessionStore: vi.fn(() => sessionStore),
    saveSessionStore: vi.fn(async () => {}),
    updateSessionStore: vi.fn(async (_storePath, mutator: (store: never) => unknown) =>
      mutator(sessionStore as never),
    ),
    getSessionEntry: vi.fn(
      ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey] as MockSessionEntry,
    ),
    patchSessionEntry: vi.fn(
      async ({
        sessionKey,
        fallbackEntry,
        update,
      }: {
        sessionKey: string;
        fallbackEntry: MockSessionEntry;
        update: (entry: MockSessionEntry) => Promise<MockSessionEntry> | MockSessionEntry;
      }) => {
        const current = (sessionStore[sessionKey] as MockSessionEntry | undefined) ?? fallbackEntry;
        const patch = await update(current);
        const next = { ...current, ...patch };
        sessionStore[sessionKey] = next;
        return next;
      },
    ),
    resolveSessionFilePath: vi.fn(() => path.join(sessionRoot, "session.json")),
  };
}

function twilioJoinRequest() {
  return {
    action: "join" as const,
    url: MEET_URL,
    dialInNumber: "+15551234567",
    pin: "123456",
  };
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function requireSetupCheck(checks: unknown[] | undefined, id: string): Record<string, unknown> {
  const check = checks
    ?.map((item) => requireRecord(item, "setup check"))
    .find((item) => item.id === id);
  if (!check) {
    throw new Error(`Expected setup check ${id}`);
  }
  return check;
}

function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T>;
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T;
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T | Promise<T>): T | Promise<T> {
  const originalPlatform = process.platform;
  const restore = () => Object.defineProperty(process, "platform", { value: originalPlatform });
  Object.defineProperty(process, "platform", { value: platform });
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

type TwilioSetupCredentials = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
};

type TwilioVoiceCallEntry = {
  enabled: boolean;
  config?: {
    provider?: string;
    publicUrl?: string;
    fromNumber?: string;
    twilio?: { accountSid?: string; authToken?: string };
  };
};

async function runTwilioSetupStatus(params: {
  env?: TwilioSetupCredentials;
  googleMeetConfig?: NonNullable<Parameters<typeof setup>[0]>;
  includeVoiceCallInAllowlist?: boolean;
  voiceCallEntry?: TwilioVoiceCallEntry | null;
  request?: Record<string, unknown>;
}) {
  const env = params.env ?? {
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: "+15550001234",
  };
  vi.stubEnv("TWILIO_ACCOUNT_SID", env.accountSid);
  vi.stubEnv("TWILIO_AUTH_TOKEN", env.authToken);
  vi.stubEnv("TWILIO_FROM_NUMBER", env.fromNumber);
  const voiceCallEntry =
    params.voiceCallEntry === undefined
      ? {
          enabled: true,
          config: {
            provider: "twilio",
            publicUrl: "https://voice.example.com/voice/webhook",
          },
        }
      : params.voiceCallEntry;
  const { tools } = setup(params.googleMeetConfig ?? { defaultTransport: "chrome" }, {
    fullConfig: {
      plugins: {
        allow: [
          "google-meet",
          ...(params.includeVoiceCallInAllowlist === false ? [] : ["voice-call"]),
        ],
        entries: voiceCallEntry ? { "voice-call": voiceCallEntry } : {},
      },
    },
  });
  return await getMeetTool({ tools }).execute("id", {
    action: "setup_status",
    ...params.request,
  });
}

async function getTwilioVoiceCallCredentialsCheck(params: {
  env: TwilioSetupCredentials;
  configured?: Partial<TwilioSetupCredentials>;
}): Promise<Record<string, unknown>> {
  const result = await runTwilioSetupStatus({
    env: params.env,
    googleMeetConfig: {
      defaultTransport: "chrome-node",
      chromeNode: { node: "parallels-macos" },
    },
    voiceCallEntry: {
      enabled: true,
      config: {
        provider: "twilio",
        publicUrl: "https://voice.example.com/voice/webhook",
        fromNumber: params.configured?.fromNumber,
        twilio: {
          accountSid: params.configured?.accountSid,
          authToken: params.configured?.authToken,
        },
      },
    },
  });
  return requireSetupCheck(result.details.checks, "twilio-voice-call-credentials");
}

function mockLocalMeetBrowserRequest(
  browserActResult: Record<string, unknown> | (() => Record<string, unknown>) = meetBrowserState(),
  options: {
    trackOpenedTab?: boolean;
    allowNavigate?: boolean;
    allowPermissions?: boolean;
    permissionResult?: Record<string, unknown>;
  } = {},
) {
  let openedUrl: string | undefined;
  const callGatewayFromCli = vi.fn(
    async (
      _method: string,
      _opts: unknown,
      params?: unknown,
      _extra?: unknown,
    ): Promise<Record<string, unknown>> => {
      const request = params as {
        path?: string;
        body?: { fn?: string; targetId?: string; url?: string };
      };
      if (request.path === "/tabs") {
        return {
          tabs:
            options.trackOpenedTab && openedUrl
              ? [{ targetId: "local-meet-tab", title: "Meet", url: openedUrl }]
              : [],
        };
      }
      if (request.path === "/tabs/open") {
        openedUrl = request.body?.url ?? MEET_URL;
        return {
          targetId: "local-meet-tab",
          title: "Meet",
          url: openedUrl,
        };
      }
      if (request.path === "/tabs/focus") {
        return { ok: true };
      }
      if (request.path === "/navigate" && options.allowNavigate !== false) {
        return {
          targetId: request.body?.targetId ?? "local-meet-tab",
          url: request.body?.url ?? MEET_URL,
        };
      }
      if (request.path === "/permissions/grant" && options.allowPermissions !== false) {
        return (
          options.permissionResult ?? {
            ok: true,
            origin: "https://meet.google.com",
            grantedPermissions: ["audioCapture", "videoCapture", "speakerSelection"],
            unsupportedPermissions: [],
          }
        );
      }
      if (request.path === "/act") {
        return {
          result: JSON.stringify(
            typeof browserActResult === "function" ? browserActResult() : browserActResult,
          ),
        };
      }
      throw new Error(`unexpected browser request path ${request.path}`);
    },
  );
  localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
    await callGatewayFromCli(method, {}, params, requestOptions);
  return callGatewayFromCli;
}

function createCapturedBrowserRuntime(
  request: (params: Record<string, unknown>) => Promise<unknown>,
) {
  return {
    gateway: {
      isAvailable: async () => true,
      request: async (_method: string, params: Record<string, unknown>) => await request(params),
    },
    system: {
      runCommandWithTimeout: async () => ({ code: 0, stdout: "BlackHole 2ch", stderr: "" }),
    },
  } as never;
}

function meetButton(label: string, disabled = false) {
  return {
    disabled,
    innerText: "",
    textContent: "",
    click: vi.fn(),
    getAttribute: vi.fn((name: string) => (name === "aria-label" ? label : null)),
  };
}

function createCaptionPageContext(buttons: () => unknown[], window: Record<string, unknown> = {}) {
  return createContext({
    Date,
    JSON,
    String,
    crypto: { randomUUID: () => "caption-epoch" },
    document: {
      body: { innerText: "", textContent: "" },
      title: "Meet",
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn((selector: string) => (selector === "button" ? buttons() : [])),
    },
    location: { href: MEET_URL, hostname: "meet.google.com" },
    MutationObserver: class {
      observe = vi.fn();
    },
    window,
  });
}

async function captureMeetStatusScript(params: {
  autoJoin: boolean;
  captionSessionId?: string;
  mode: "agent" | "transcribe";
}) {
  let script: string | undefined;
  const baseConfig = resolveGoogleMeetConfig({});
  const config = {
    ...baseConfig,
    chrome: {
      ...baseConfig.chrome,
      autoJoin: params.autoJoin,
      reuseExistingTab: false,
      waitForInCallMs: 0,
    },
  };
  const runtime = createCapturedBrowserRuntime(async (request) => {
    if (request.path === "/tabs" || request.path === "/tabs/open") {
      const tab = {
        targetId: "local-meet-tab",
        title: "Meet",
        url: MEET_URL_EN,
      };
      return request.path === "/tabs" ? { tabs: [tab] } : tab;
    }
    if (request.path === "/tabs/focus" || request.path === "/permissions/grant") {
      return { ok: true };
    }
    if (request.path === "/act") {
      script = requireRecord(request.body, "Meet status request body").fn as string;
      return {
        result: JSON.stringify({
          manualAction: {
            reason: "meet-admission-required",
            message: "Waiting for admission",
          },
        }),
      };
    }
    throw new Error(`unexpected browser request path ${String(request.path)}`);
  });
  if (params.mode === "agent") {
    await chromeTransport.recoverCurrentMeetTab({
      runtime,
      config,
      mode: "agent",
      readOnly: false,
      url: MEET_URL,
    });
  } else {
    await chromeTransport.launchChromeMeet({
      runtime,
      config,
      fullConfig: {},
      meetingSessionId: params.captionSessionId ?? "session-1",
      mode: params.mode,
      url: MEET_URL,
      logger: noopLogger,
    });
  }
  if (!script) {
    throw new Error("Google Meet status script was not sent through browser control");
  }
  return script;
}

async function captureMeetLeaveScript() {
  let script: string | undefined;
  const config = resolveGoogleMeetConfig({});
  await chromeTransport.leaveChromeMeet({
    runtime: createCapturedBrowserRuntime(async (request) => {
      if (request.path === "/tabs") {
        return {
          tabs: [
            {
              targetId: "local-meet-tab",
              title: "Meet",
              url: MEET_URL_EN,
            },
          ],
        };
      }
      if (request.path === "/act") {
        script = requireRecord(request.body, "Meet leave request body").fn as string;
        return { result: JSON.stringify({ departed: true, urlMatched: true }) };
      }
      throw new Error(`unexpected browser request path ${String(request.path)}`);
    }),
    config,
    meetingSessionId: "session-1",
    meetingUrl: MEET_URL,
    tab: { targetId: "local-meet-tab", openedByPlugin: false },
  });
  if (!script) {
    throw new Error("Google Meet leave script was not sent through browser control");
  }
  return script;
}

const CREATE_URL = "https://meet.google.com/new?hl=en";
const MEETING_URL = "https://meet.google.com/new-abcd-xyz";
const PERMISSION_ACTION = {
  reason: "meet-permission-required",
  message: "Allow microphone/camera permissions, then retry meeting creation.",
};

function setupBrowser(
  browser: Parameters<typeof createBrowserProxyHandler>[0],
  config: Parameters<typeof setupGoogleMeetPlugin>[1] = {},
) {
  return setup(
    { defaultTransport: "chrome-node", chromeNode: { node: "parallels-macos" }, ...config },
    { nodesInvokeHandler: createBrowserProxyHandler(browser) },
  );
}

type BrowserProxyBody = {
  fn?: string;
  targetId?: string;
  url?: string;
};

type BrowserProxyTab = {
  targetId: string;
  title?: string;
  url?: string;
};

function browserProxyPayload(result: unknown) {
  return { payload: { result } };
}

function browserCreateResult() {
  return { meetingUri: MEETING_URL, browserUrl: MEETING_URL, browserTitle: "Meet" };
}

function createBrowserProxyHandler(options: {
  act: (body: BrowserProxyBody) => unknown;
  handleChromeStart?: boolean;
  navigateTo?: BrowserProxyTab;
  openedTargetId?: string | ((url: string | undefined) => string);
  tabs?: BrowserProxyTab[];
}) {
  return async (params: { command: string; params?: unknown }) => {
    if (params.command === "googlemeet.chrome" && options.handleChromeStart) {
      return { payload: { launched: true } };
    }
    if (params.command !== "browser.proxy") {
      throw new Error(`unexpected node command ${params.command}`);
    }
    const proxy = params.params as { path?: string; body?: BrowserProxyBody };
    switch (proxy.path) {
      case "/tabs":
        return browserProxyPayload({ tabs: options.tabs ?? [] });
      case "/tabs/open": {
        const targetId =
          typeof options.openedTargetId === "function"
            ? options.openedTargetId(proxy.body?.url)
            : (options.openedTargetId ?? "tab-1");
        return browserProxyPayload({
          targetId,
          title: "Meet",
          url: proxy.body?.url,
        });
      }
      case "/tabs/focus":
      case "/permissions/grant":
        return browserProxyPayload({ ok: true });
      case "/navigate":
        if (options.navigateTo) {
          return browserProxyPayload(options.navigateTo);
        }
        break;
      case "/act":
        return browserProxyPayload({
          ok: true,
          targetId: proxy.body?.targetId,
          result: await options.act(proxy.body ?? {}),
        });
      case undefined:
        break;
    }
    throw new Error(`unexpected browser proxy path ${proxy.path}`);
  };
}

function browserCall(route: string, body?: BrowserProxyBody) {
  const params = body ? { path: route, body: expect.objectContaining(body) } : { path: route };
  return expect.objectContaining({
    command: "browser.proxy",
    params: expect.objectContaining(params),
  });
}

describe("google-meet plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(voiceCallMocks)) {
      mock.mockReset();
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    localBrowserGatewayRequestHandler = undefined;
    googleMeetPluginTesting.setCallGatewayFromCliForTests();
    googleMeetPluginTesting.setPlatformForTests();
    for (const dir of testTempDirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    testTempDirs.clear();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.doUnmock("openclaw/plugin-sdk/meeting-runtime");
    vi.doUnmock("./src/voice-call-gateway.js");
    vi.resetModules();
  });

  meetingTestState = useMeetingTestState(createOpenClawTestState);

  it("keeps realtime.provider as the transcription compatibility fallback", () => {
    const custom = resolveGoogleMeetConfig({
      realtime: {
        provider: "custom-stt",
      },
    });
    expect(custom.realtime.provider).toBe("custom-stt");
    expect(custom.realtime.transcriptionProvider).toBe("custom-stt");

    const google = resolveGoogleMeetConfig({
      realtime: {
        provider: "google",
      },
    });
    expect(google.realtime.provider).toBe("google");
    expect(google.realtime.transcriptionProvider).toBe("openai");
  });

  it("uses voiceProvider for bidi and transcriptionProvider for agent mode resolution", async () => {
    const voice = createTestMeetVoiceProvider({
      sendUserMessage: vi.fn(),
      triggerGreeting: vi.fn(),
    });
    const voiceProviders: RealtimeVoiceProviderPlugin[] = [
      {
        id: "openai",
        label: "OpenAI",
        autoSelectOrder: 1,
        isConfigured: () => true,
        createBridge: () => {
          throw new Error("unused");
        },
      },
      {
        ...voice.provider,
        id: "google",
        label: "Google",
        autoSelectOrder: 2,
      },
    ];
    const createSession = vi.fn(() => ({
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    }));
    const transcriptionProviders: RealtimeTranscriptionProviderPlugin[] = [
      {
        id: "openai",
        label: "OpenAI",
        autoSelectOrder: 1,
        isConfigured: () => true,
        createSession,
      },
    ];
    const config = resolveGoogleMeetConfig({
      realtime: {
        provider: "openai",
        transcriptionProvider: "openai",
        voiceProvider: "google",
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
      },
    });

    const engineParams = { config, fullConfig: {}, runtime: {} as never, logger: noopLogger };
    const bindings = createGoogleMeetTestEngineBindings(engineParams);
    const voiceTransport = createTestMeetRealtimeAudioTransport();
    const voiceHandle = await startMeetingRealtimeEngine({
      ...engineParams,
      ...bindings,
      meetingSessionId: "provider-resolution-voice",
      providers: voiceProviders,
      transport: voiceTransport.transport,
    });
    expect(voiceHandle.providerId).toBe("google");
    expect(voice.requireRequest().providerConfig).toEqual({
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
    });
    await voiceHandle.stop();

    const transcriptionTransport = createTestMeetRealtimeAudioTransport();
    const transcriptionHandle = await startMeetingAgentRealtimeEngine({
      ...engineParams,
      ...bindings,
      meetingSessionId: "provider-resolution-transcription",
      providers: transcriptionProviders,
      transport: transcriptionTransport.transport,
    });
    expect(transcriptionHandle.providerId).toBe("openai");
    expect(createSession).toHaveBeenCalledOnce();
    await transcriptionHandle.stop();
  });

  it("preserves an empty realtime intro message for silent joins", () => {
    expect(
      resolveGoogleMeetConfig({
        realtime: {
          introMessage: "",
        },
      }).realtime.introMessage,
    ).toBe("");
  });

  it("keeps legacy command-pair audio format when custom commands omit a format", () => {
    const config = resolveGoogleMeetConfig({
      chrome: {
        audioInputCommand: ["capture-legacy"],
        audioOutputCommand: ["play-legacy"],
      },
    });
    expect(config.chrome.audioFormat).toBe("g711-ulaw-8khz");
    expect(config.chrome.audioInputCommand).toEqual(["capture-legacy"]);
    expect(config.chrome.audioOutputCommand).toEqual(["play-legacy"]);
  });

  it("clamps configured Chrome audio buffers above SoX's minimum", () => {
    const config = resolveGoogleMeetConfig({
      chrome: { audioBackend: "blackhole-2ch", audioBufferBytes: 1 },
    });

    expect(config.chrome.audioBufferBytes).toBe(17);
    expect(config.chrome.audioInputCommand?.slice(0, 4)).toEqual(["sox", "-q", "--buffer", "17"]);
    expect(config.chrome.audioOutputCommand?.slice(0, 4)).toEqual(["sox", "-q", "--buffer", "17"]);
  });

  it("uses env fallbacks for OAuth, preview, and default meeting values", () => {
    const config = resolveGoogleMeetConfigFromTestEnv({
      OPENCLAW_GOOGLE_MEET_CLIENT_ID: "client-id",
      GOOGLE_MEET_CLIENT_SECRET: "client-secret",
      OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN: "refresh-token",
      GOOGLE_MEET_ACCESS_TOKEN: "access-token",
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: "123456",
      GOOGLE_MEET_DEFAULT_MEETING: MEET_URL,
      OPENCLAW_GOOGLE_MEET_PREVIEW_ACK: "true",
    });
    expect(config.defaults).toEqual({ meeting: MEET_URL });
    expect(config.preview).toEqual({ enrollmentAcknowledged: true });
    expect(config.oauth).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiresAt: 123456,
    });
  });

  it.each(["0x10"])("ignores non-decimal env numeric fallbacks: %s", (expiresAt) => {
    const config = resolveGoogleMeetConfigFromTestEnv({
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN: "access-token",
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: expiresAt,
    });

    expect(config.oauth).toEqual({ accessToken: "access-token" });
  });

  it("requires explicit Meet URLs", () => {
    expect(normalizeMeetUrl(MEET_URL)).toBe(MEET_URL);
    expect(() => normalizeMeetUrl("https://example.com/abc-defg-hij")).toThrow("meet.google.com");
    expect(() => normalizeMeetUrl("https://user@meet.google.com/abc-defg-hij")).toThrow(
      "meet.google.com",
    );
    expect(() => normalizeMeetUrl("https://meet.google.com:444/abc-defg-hij")).toThrow(
      "meet.google.com",
    );
  });

  it("registers the node-host command used by chrome-node transport", () => {
    const { nodeHostCommands, nodeInvokePolicies } = setup();

    const command = nodeHostCommands.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.command === "googlemeet.chrome",
    );
    if (!command) {
      throw new Error("expected googlemeet.chrome node host command");
    }
    expect(command.cap).toBe("google-meet");
    expect(command.dangerous).toBe(true);
    expect(typeof command.handle).toBe("function");
    expect(nodeInvokePolicies).toHaveLength(1);
    expect(nodeInvokePolicies[0]).toMatchObject({
      commands: ["googlemeet.chrome"],
      dangerous: true,
    });
  });

  it("keeps local Chrome talk-back available on Linux and blocks unsupported hosts", async () => {
    const { cliRegistrations, methods, tools } = setup(undefined, { registerPlatform: "linux" });
    const tool = getMeetTool({ tools });
    const callGatewayFromCli = vi.fn(async () => ({ ok: true }));
    googleMeetPluginTesting.setCallGatewayFromCliForTests(callGatewayFromCli);

    expect(tools).toHaveLength(1);
    expect(cliRegistrations).toHaveLength(1);
    expect(methods.has("googlemeet.setup")).toBe(true);

    const joined = await tool.execute("linux-agent", { action: "join" });
    expect(joined.details).toEqual({ ok: true });
    expect(callGatewayFromCli).toHaveBeenCalledOnce();
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "googlemeet.join",
      expect.any(Object),
      { action: "join" },
      { progress: false, scopes: ["operator.admin"] },
    );

    const transcribed = await tool.execute("linux-transcribe", {
      action: "join",
      mode: "transcribe",
    });
    expect(transcribed.details).toEqual({ ok: true });
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "googlemeet.join",
      expect.any(Object),
      { action: "join", mode: "transcribe" },
      { progress: false, scopes: ["operator.admin"] },
    );

    googleMeetPluginTesting.setPlatformForTests(() => "win32");
    const blocked = await tool.execute("windows-agent", { action: "join" });
    expect(blocked.details).toEqual({
      error:
        "Google Meet local Chrome talk-back audio requires macOS with BlackHole 2ch or Linux with PipeWire-Pulse. On this host, use mode: transcribe, transport: twilio, or a supported chrome-node.",
    });
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);

    googleMeetPluginTesting.setPlatformForTests(() => "linux");
    const remote = await tool.execute("linux-chrome-node", {
      action: "join",
      transport: "chrome-node",
    });
    expect(remote.details).toEqual({ ok: true });
    expect(callGatewayFromCli).toHaveBeenCalledTimes(3);
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      3,
      "googlemeet.join",
      expect.any(Object),
      { action: "join", transport: "chrome-node" },
      { progress: false, scopes: ["operator.admin"] },
    );
  });

  it("adds a reauth hint for missing Calendar scopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("insufficientPermissions", { status: 403 })),
    );

    const request = findGoogleMeetCalendarEvent({
      accessToken: "token",
      timeMin: "2026-04-25T00:00:00Z",
      timeMax: "2026-04-26T00:00:00Z",
    });
    await expect(request).rejects.toThrow("calendar.events.readonly");
    await expect(request).rejects.toThrow("googlemeet auth login");
  });

  it("keeps all conference records available when requested", async () => {
    const fetchMock = stubMeetArtifactsApi();

    await fetchGoogleMeetArtifacts({
      accessToken: "token",
      meeting: "abc-defg-hij",
      pageSize: 2,
      allConferenceRecords: true,
    });

    const listCall = fetchMock.mock.calls.find(([input]) => {
      const url = requestUrl(input);
      return url.pathname === "/v2/conferenceRecords";
    });
    if (!listCall) {
      throw new Error("Expected conferenceRecords.list fetch call");
    }
    const listUrl = requestUrl(listCall[0]);
    expect(listUrl.searchParams.get("pageSize")).toBe("2");
    expect(listUrl.searchParams.get("filter")).toBe('space.name = "spaces/abc-defg-hij"');
  });

  it("merges duplicate attendance participants and annotates timing through the tool", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/v2/conferenceRecords/rec-1") {
        return jsonResponse({
          name: "conferenceRecords/rec-1",
          startTime: "2026-04-25T10:00:00Z",
          endTime: "2026-04-25T11:00:00Z",
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants") {
        return jsonResponse({
          participants: [
            {
              name: "conferenceRecords/rec-1/participants/p1",
              signedinUser: { user: "users/alice", displayName: "Alice" },
            },
            {
              name: "conferenceRecords/rec-1/participants/p2",
              signedinUser: { user: "users/alice", displayName: "Alice" },
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants/p1/participantSessions") {
        return jsonResponse({
          participantSessions: [
            {
              name: "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
              startTime: "2026-04-25T10:10:00Z",
              endTime: "2026-04-25T10:30:00Z",
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants/p2/participantSessions") {
        return jsonResponse({
          participantSessions: [
            {
              name: "conferenceRecords/rec-1/participants/p2/participantSessions/s1",
              startTime: "2026-04-25T10:40:00Z",
              endTime: "2026-04-25T10:50:00Z",
            },
          ],
        });
      }
      return new Response(`unexpected ${url.pathname}`, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { details: result } = await getMeetTool(setup()).execute("attendance", {
      action: "attendance",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      conferenceRecord: "rec-1",
      pageSize: "3",
    });
    expect(result.input).toBe("rec-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://meet.googleapis.com/v2/conferenceRecords/rec-1",
      { headers: { Authorization: "Bearer token", Accept: "application/json" } },
    );
    expect(result.attendance).toHaveLength(1);
    const row = result.attendance[0];
    expect(row?.displayName).toBe("Alice");
    expect(row?.participants).toEqual([
      "conferenceRecords/rec-1/participants/p1",
      "conferenceRecords/rec-1/participants/p2",
    ]);
    expect(row?.firstJoinTime).toBe("2026-04-25T10:10:00.000Z");
    expect(row?.lastLeaveTime).toBe("2026-04-25T10:50:00.000Z");
    expect(row?.durationMs).toBe(1_800_000);
    expect(row?.late).toBe(true);
    expect(row?.earlyLeave).toBe(true);
    expect(row?.sessions.map((session) => session.name)).toEqual([
      "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
      "conferenceRecords/rec-1/participants/p2/participantSessions/s1",
    ]);
  });

  it("surfaces Developer Preview acknowledgment blockers in preflight reports", () => {
    const report = buildGoogleMeetPreflightReport({
      input: "abc-defg-hij",
      space: { name: "spaces/abc-defg-hij" },
      previewAcknowledged: false,
      tokenSource: "cached-access-token",
    });
    expect(report.resolvedSpaceName).toBe("spaces/abc-defg-hij");
    expect(report.previewAcknowledged).toBe(false);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toContain("Developer Preview Program");
  });

  it("builds Twilio dial plans from a PIN", () => {
    expect(normalizeDialInNumber("+1 (555) 123-4567")).toBe("+15551234567");
    expect(buildMeetDtmfSequence({ pin: "123 456" })).toBe("123456#");
    expect(buildMeetDtmfSequence({ dtmfSequence: "ww123#" })).toBe("ww123#");
    expect(prefixDtmfWait("123456#", 12000)).toBe("wwwwwwwwwwwwwwwwwwwwwwww123456#");
  });

  it("passes the caller session key through tool joins for agent context forking", async () => {
    const { tools } = setup(
      {},
      { toolContext: { sessionKey: "agent:main:discord:channel:general" } },
    );
    const gatewayParams: unknown[] = [];
    googleMeetPluginTesting.setCallGatewayFromCliForTests(async (_method, _opts, params) => {
      gatewayParams.push(params);
      return { ok: true };
    });
    const tool = getMeetTool({ tools });

    await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      requesterSessionKey: "agent:main:wrong",
    });

    const gatewayJoinParams = requireRecord(gatewayParams[0], "gateway join params");
    expect(gatewayJoinParams.url).toBe(MEET_URL);
    expect(gatewayJoinParams.requesterSessionKey).toBe("agent:main:discord:channel:general");
  });

  it("derives trusted agent ownership from the invoking session key", async () => {
    const { tools, gatewayRequest } = setup(
      { defaultTransport: "twilio" },
      {
        gatewayAvailable: true,
        toolContext: { sessionKey: "agent:support:pr103522-live" },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
      agentId: "spoofed",
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "googlemeet.join",
      expect.objectContaining({
        agentId: "support",
        requesterSessionKey: "agent:support:pr103522-live",
      }),
      { timeoutMs: 60_000, scopes: ["operator.admin"] },
    );
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        sessionKey: `agent:support:google-meet:${result.details.session.id}`,
      }),
    );
  });

  it("keeps Twilio calls on the configured realtime agent when no tool override exists", async () => {
    const { tools } = setup({
      defaultTransport: "twilio",
      realtime: { agentId: "support" },
    });
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
    });

    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        sessionKey: `agent:support:google-meet:${result.details.session.id}`,
      }),
    );
  });

  it("keeps test-listen probes on the agent that invoked the tool", async () => {
    const { tools, gatewayRequest } = setup(
      { defaultTransport: "chrome-node" },
      {
        gatewayAvailable: true,
        toolContext: { agentId: "Support", sessionKey: "agent:support:main" },
        browserActResult: {
          inCall: true,
          captioning: true,
          transcriptLines: 1,
          lastCaptionText: "hello from the meeting",
          title: "Meet call",
          url: MEET_URL,
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "test_listen",
      url: MEET_URL,
      timeoutMs: "100",
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "googlemeet.testListen",
      expect.objectContaining({
        agentId: "support",
        requesterSessionKey: "agent:support:main",
      }),
      { timeoutMs: 60_000, scopes: ["operator.admin"] },
    );
    expect(result.details.session.agentId).toBe("support");
    expect(result.details.listenVerified).toBe(true);
  });

  it("fails closed for standalone non-default agent routing", async () => {
    const { tools } = setup(
      {},
      { toolContext: { agentId: "support", sessionKey: "agent:support:main" } },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
    });

    expect(result.details.error).toContain("requires a Gateway-hosted agent run");
  });

  it("does not accept agent routing from an external gateway caller", async () => {
    const { methods } = setup({ defaultTransport: "twilio" });

    await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
      url: MEET_URL,
      dialInNumber: "+15551234567",
      agentId: "spoofed",
    });

    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: undefined,
        sessionKey: expect.stringMatching(/^voice:google-meet:meet_/),
      }),
    );
  });

  it("explains that Twilio joins need dial-in details", async () => {
    const tool = getMeetTool(setup({ defaultTransport: "twilio" }));

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
    });

    expect(result.details.error).toContain("Twilio transport requires a Meet dial-in phone number");
    expect(result.details.error).toContain("Google Meet URLs do not include dial-in details");
  });

  it("does not reuse Twilio Meet sessions whose delegated call is no longer active", async () => {
    voiceCallMocks.getMeetingVoiceCallGatewayCall.mockResolvedValueOnce({ found: false });
    const tool = getMeetTool(setup({ defaultTransport: "twilio" }));
    const first = await tool.execute("id", twilioJoinRequest());
    const second = await tool.execute("id", twilioJoinRequest());

    expect(first.details.session.state).toBe("ended");
    expect(first.details.session.notes).toContain("Voice Call is no longer active.");
    expect(second.details.session.id).not.toBe(first.details.session.id);
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "the authoritative end timestamp",
      call: { callId: "call-1", state: "completed", endedAt: 1_780_000_000_000 },
    },
    {
      name: "the authoritative end reason",
      call: { callId: "call-1", state: "completed", endReason: "completed" },
    },
  ])("redials a persisted completed Twilio call identified by $name", async ({ call }) => {
    voiceCallMocks.getMeetingVoiceCallGatewayCall.mockResolvedValueOnce({ found: true, call });
    const tool = getMeetTool(setup({ defaultTransport: "twilio" }));
    const request = twilioJoinRequest();

    const first = await tool.execute("first", request);
    const second = await tool.execute("second", request);

    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledTimes(2);
    expect(first.details.session.state).toBe("ended");
    expect(first.details.session.notes).toContain("Voice Call is no longer active.");
    expect(second.details.session.id).not.toBe(first.details.session.id);
  });

  it.each([
    {
      name: "a terminal-looking state without an authoritative terminal fact",
      result: { found: true, call: { callId: "call-1", state: "completed" } },
    },
    {
      name: "an unknown call record",
      result: { found: true },
    },
  ])("reuses the active Meet session for $name", async ({ result }) => {
    voiceCallMocks.getMeetingVoiceCallGatewayCall.mockResolvedValueOnce(result);
    const tool = getMeetTool(setup({ defaultTransport: "twilio" }));
    const request = twilioJoinRequest();

    const first = await tool.execute("first", request);
    const second = await tool.execute("second", request);

    expect(second.details.session.id).toBe(first.details.session.id);
    expect(first.details.session.state).toBe("active");
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();
  });

  it("reuses the active Meet session when delegated call status temporarily rejects", async () => {
    voiceCallMocks.getMeetingVoiceCallGatewayCall.mockRejectedValueOnce(
      new Error("temporary voice gateway failure"),
    );
    const tool = getMeetTool(setup({ defaultTransport: "twilio" }));
    const request = twilioJoinRequest();

    const first = await tool.execute("first", request);
    const second = await tool.execute("second", request);

    expect(second.details.session.id).toBe(first.details.session.id);
    expect(first.details.session.state).toBe("active");
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();
  });

  it("serializes concurrent identical Twilio joins", async () => {
    let finishDial:
      | ((result: { callId: string; dtmfSent: boolean; introSent: boolean }) => void)
      | undefined;
    const dialing = new Promise<{ callId: string; dtmfSent: boolean; introSent: boolean }>(
      (resolve) => {
        finishDial = resolve;
      },
    );
    voiceCallMocks.joinMeetViaVoiceCallGateway.mockReturnValueOnce(dialing);
    const runtime = meetRuntime({ defaultTransport: "twilio" }, noopLogger);
    const request = {
      url: MEET_URL,
      dialInNumber: "+15551234567",
      pin: "123456",
    };

    const firstJoin = runtime.join(request);
    await vi.waitFor(() => {
      expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();
    });
    const secondJoin = runtime.join(request);
    await Promise.resolve();
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();

    finishDial?.({ callId: "call-1", dtmfSent: true, introSent: true });
    const [first, second] = await Promise.all([firstJoin, secondJoin]);

    expect(second.session.id).toBe(first.session.id);
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();
  });

  it("delegates Twilio session speech through voice-call", async () => {
    const tool = getMeetTool(setup({ defaultTransport: "twilio" }));
    const joined = await tool.execute("id", twilioJoinRequest());

    const spoken = await tool.execute("id", {
      action: "speak",
      sessionId: joined.details.session.id,
      message: "Say exactly: hello after joining.",
    });

    expect(requireRecord(spoken.details, "spoken details").spoken).toBe(true);
    expect(voiceCallMocks.speakMeetingViaVoiceCallGateway).toHaveBeenCalledWith({
      gateway: expect.any(Object),
      callId: "call-1",
      message: "Say exactly: hello after joining.",
    });
  });

  it("rejects ended-session speech before invoking voice-call", async () => {
    const tool = getMeetTool(setup({ defaultTransport: "twilio" }));
    const joined = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
    });
    const sessionId = requireRecord(joined.details.session, "joined Twilio session").id;
    await tool.execute("id", { action: "leave", sessionId });
    expect(voiceCallMocks.endMeetingVoiceCallGatewayCall).toHaveBeenCalledWith({
      gateway: expect.any(Object),
      callId: "call-1",
    });
    voiceCallMocks.speakMeetingViaVoiceCallGateway.mockClear();

    const spoken = await tool.execute("id", {
      action: "speak",
      sessionId,
      message: "Do not send this.",
    });

    expect(spoken.details.found).toBe(true);
    expect(spoken.details.spoken).toBe(false);
    expect(voiceCallMocks.speakMeetingViaVoiceCallGateway).not.toHaveBeenCalled();
  });

  it("rejects agent-mode external audio bridges in setup status", async () => {
    await withPlatform("darwin", async () => {
      const { tools } = setup(
        {
          defaultMode: "agent",
          defaultTransport: "chrome",
          chrome: {
            audioBridgeCommand: ["bridge", "start"],
            audioInputCommand: ["capture-meet"],
            audioOutputCommand: ["play-meet"],
          },
        },
        {
          runCommandWithTimeoutHandler: async (argv) => {
            if (argv[0]?.endsWith("system_profiler")) {
              return { code: 0, stdout: "BlackHole 2ch", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      );
      const tool = getMeetTool({ tools });

      const result = await tool.execute("id", { action: "setup_status" });

      expect(result.details.ok).toBe(false);
      const audioBridgeCheck = result.details.checks
        ?.map((check) => requireRecord(check, "setup check"))
        .find((check) => check.id === "audio-bridge");
      if (!audioBridgeCheck) {
        throw new Error("Expected audio-bridge setup check");
      }
      expect(audioBridgeCheck.ok).toBe(false);
      expect(String(audioBridgeCheck.message)).toContain("chrome.audioBridgeCommand is bidi-only");
    });
  });

  it("writes export bundles through the tool", async () => {
    stubMeetArtifactsApi();
    const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-tool-export-"));
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    try {
      const result = await tool.execute("id", {
        action: "export",
        accessToken: "token",
        expiresAt: Date.now() + 120_000,
        meeting: "abc-defg-hij",
        includeDocumentBodies: true,
        outputDir: tempDir,
        zip: true,
      });

      expect(result.details.files).toContain(path.join(tempDir, "manifest.json"));
      expect(result.details.zipFile).toBe(`${tempDir}.zip`);
      const manifest = requireRecord(
        JSON.parse(readFileSync(path.join(tempDir, "manifest.json"), "utf8")),
        "export manifest",
      );
      expect(manifest.request).toEqual({
        meeting: "abc-defg-hij",
        includeDocumentBodies: true,
        includeTranscriptEntries: true,
        allConferenceRecords: false,
        mergeDuplicateParticipants: true,
      });
      expect(manifest.counts).toEqual({
        conferenceRecords: 1,
        artifacts: 1,
        recordings: 1,
        transcripts: 1,
        transcriptEntries: 1,
        smartNotes: 1,
        attendanceRows: 1,
        warnings: 0,
      });
      expect(manifest.files).toEqual([
        "summary.md",
        "attendance.csv",
        "transcript.md",
        "artifacts.json",
        "attendance.json",
        "manifest.json",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(`${tempDir}.zip`, { force: true });
    }
  });

  it("dry-runs export bundles through the tool", async () => {
    stubMeetArtifactsApi();
    const parentDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-tool-dry-run-"));
    const outputDir = path.join(parentDir, "bundle");
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    try {
      const result = await tool.execute("id", {
        action: "export",
        accessToken: "token",
        expiresAt: Date.now() + 120_000,
        conferenceRecord: "rec-1",
        outputDir,
        dryRun: true,
      });

      expect(result.details.dryRun).toBe(true);
      expect(result.details.manifest?.files).toEqual([
        "summary.md",
        "attendance.csv",
        "transcript.md",
        "artifacts.json",
        "attendance.json",
        "manifest.json",
      ]);
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it("reports the latest conference record from today's calendar through the tool", async () => {
    stubMeetArtifactsApi();
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "latest",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      today: true,
    });

    expect(result.details.calendarEvent?.meetingUri).toBe(MEET_URL);
  });

  it("reports calendar event previews through the tool", async () => {
    stubMeetArtifactsApi();
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "calendar_events",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      today: true,
    });

    expect(result.details.events).toHaveLength(1);
    expect(result.details.events?.[0]?.selected).toBe(true);
    expect(result.details.events?.[0]?.meetingUri).toBe(MEET_URL);
  });

  it("fails setup status when the configured Chrome node is not connected", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesListResult: {
          nodes: [
            {
              nodeId: "node-1",
              displayName: "parallels-macos",
              connected: false,
              caps: [],
              commands: [],
              remoteIp: "192.168.0.25",
            },
          ],
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(false);
    const check = requireSetupCheck(result.details.checks, "chrome-node-connected");
    expect(check.ok).toBe(false);
    expect(check.message).toContain("parallels-macos");
    expect(check.message).toContain("offline");
    expect(check.message).toContain("missing googlemeet.chrome");
    expect(check.message).toContain("missing browser.proxy/browser capability");
  });

  it.each([
    {
      config: { defaultTransport: "chrome" },
      failingCommand: "system_profiler",
      expectedCheckId: "chrome-local-audio-device",
      expectedMessage: "BlackHole 2ch audio device not found",
    },
    {
      config: {
        defaultTransport: "chrome",
        chrome: { bargeInInputCommand: ["missing-barge-capture"] },
      },
      failingCommand: "missing-barge-capture",
      expectedCheckId: "chrome-local-audio-commands",
      expectedMessage: "Chrome audio command missing: missing-barge-capture",
    },
  ] satisfies Array<{
    config: NonNullable<Parameters<typeof setup>[0]>;
    failingCommand: string;
    expectedCheckId: string;
    expectedMessage: string;
  }>)(
    "reports $expectedMessage",
    async ({ config, failingCommand, expectedCheckId, expectedMessage }) => {
      await withPlatform("darwin", async () => {
        const { tools } = setup(config, {
          runCommandWithTimeoutHandler: async (argv) => {
            if (argv[0]?.endsWith("system_profiler")) {
              const stdout =
                failingCommand === "system_profiler" ? "Built-in Output" : "BlackHole 2ch";
              return { code: 0, stdout, stderr: "" };
            }
            if (argv[0] === "/bin/sh" && argv.at(-1) === failingCommand) {
              return { code: 1, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        });
        const tool = getMeetTool({ tools });

        const result = await tool.execute("id", { action: "setup_status", transport: "chrome" });

        expect(result.details.ok).toBe(false);
        const check = requireSetupCheck(result.details.checks, expectedCheckId);
        expect(check.ok).toBe(false);
        if (expectedCheckId === "chrome-local-audio-device") {
          expect(check.message).toContain(expectedMessage);
        } else {
          expect(check.message).toBe(expectedMessage);
        }
      });
    },
  );

  it("skips local Chrome audio prerequisites for observe-only setup status", async () => {
    await withPlatform("darwin", async () => {
      const { tools, runCommandWithTimeout } = setup(
        { defaultMode: "transcribe", defaultTransport: "chrome" },
        {
          runCommandWithTimeoutHandler: async () => ({
            code: 1,
            stdout: "Built-in Output",
            stderr: "",
          }),
        },
      );
      const tool = getMeetTool({ tools });

      const result = await tool.execute("id", {
        action: "setup_status",
        transport: "chrome",
        mode: "transcribe",
      });

      expect(result.details.ok).toBe(true);
      const check = requireSetupCheck(result.details.checks, "audio-bridge");
      expect(check.ok).toBe(true);
      expect(check.message).toBe(
        "Chrome observe-only mode does not require a realtime audio bridge",
      );
      expect(
        result.details.checks?.filter(
          (checkLocal) => checkLocal.id === "chrome-local-audio-device",
        ),
      ).toStrictEqual([]);
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
    });
  });

  it.each([
    {
      label: "environment account SID",
      env: { accountSid: "   ", authToken: "test-auth-token", fromNumber: "+15550001234" },
    },
    {
      label: "environment from number",
      env: { accountSid: "AC123", authToken: "test-auth-token", fromNumber: "   " },
    },
    {
      label: "configured auth token",
      env: { accountSid: "", authToken: "", fromNumber: "" },
      configured: { accountSid: "AC123", authToken: "   ", fromNumber: "+15550001234" },
    },
  ])("reports a blank $label as missing", async ({ env, configured }) => {
    const check = await getTwilioVoiceCallCredentialsCheck({ env, configured });

    expect(check.ok).toBe(false);
  });

  it("reports missing voice-call wiring for explicit Twilio transport", async () => {
    const result = await runTwilioSetupStatus({
      env: { accountSid: "", authToken: "", fromNumber: "" },
      includeVoiceCallInAllowlist: false,
      voiceCallEntry: { enabled: false },
      request: { transport: "twilio" },
    });

    expect(result.details.ok).toBe(false);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-plugin").ok).toBe(false);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-credentials").ok).toBe(
      false,
    );
  });

  it("reports missing voice-call plugin entry for explicit Twilio transport", async () => {
    const result = await runTwilioSetupStatus({
      voiceCallEntry: null,
      request: { transport: "twilio" },
    });

    expect(result.details.ok).toBe(false);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-plugin").ok).toBe(false);
  });

  it("accepts request-provided Twilio dial-in details during setup", async () => {
    const result = await runTwilioSetupStatus({
      request: { transport: "twilio", dialInNumber: "+15551234567" },
    });

    expect(result.details.ok).toBe(true);
    const check = requireSetupCheck(result.details.checks, "twilio-dial-plan");
    expect(check.ok).toBe(true);
    expect(check.message).toContain("request includes");
  });

  it("reports a private voice-call publicUrl as unusable for Twilio transport", async () => {
    const result = await runTwilioSetupStatus({
      googleMeetConfig: { defaultTransport: "twilio" },
      voiceCallEntry: {
        enabled: true,
        config: { provider: "twilio", publicUrl: "http://[fd00::1]/voice/webhook" },
      },
    });

    expect(result.details.ok).toBe(false);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-webhook").ok).toBe(false);
  });

  function mockLocalMeetBrowserRequestWithTabState(options?: {
    reused?: boolean;
    tabUrlAfterJoin?: string;
    leaveClicked?: boolean;
    nonFinalTranscriptGate?: Promise<void>;
    onNonFinalTranscriptRead?: () => void;
    shouldGateNonFinalTranscriptRead?: () => boolean;
    finalTranscript?: {
      droppedLines?: number;
      epoch?: string;
      lines: Array<{ at?: string; speaker?: string; text: string }>;
    };
    transcript?: {
      droppedLines?: number;
      epoch?: string;
      lines: Array<{ at?: string; speaker?: string; text: string }>;
    };
  }) {
    let joined = false;
    let leaveStep = 0;
    let openedTabUrl = options?.reused ? MEET_URL_EN : undefined;
    const callGatewayFromCli = vi.fn(
      async (
        _method: string,
        _opts: unknown,
        params?: unknown,
        _extra?: unknown,
      ): Promise<Record<string, unknown>> => {
        const request = params as {
          method?: string;
          path?: string;
          body?: { fn?: string; targetId?: string; url?: string };
        };
        if (request.path === "/tabs") {
          const currentTabUrl = joined ? (options?.tabUrlAfterJoin ?? openedTabUrl) : openedTabUrl;
          return {
            tabs: openedTabUrl
              ? [{ targetId: "local-meet-tab", title: "Meet", url: currentTabUrl }]
              : [],
          };
        }
        if (request.path === "/tabs/open") {
          openedTabUrl = request.body?.url;
          return { targetId: "local-meet-tab", title: "Meet", url: openedTabUrl };
        }
        if (request.path === "/tabs/focus") {
          return { ok: true };
        }
        if (request.path === "/navigate") {
          openedTabUrl = request.body?.url ?? openedTabUrl;
          return { targetId: request.body?.targetId, url: openedTabUrl };
        }
        if (request.path === "/permissions/grant") {
          return { ok: true };
        }
        if (request.method === "DELETE" && request.path === "/tabs/local-meet-tab") {
          if (options?.reused) {
            throw new Error("leave must not close a reused user-owned tab");
          }
          openedTabUrl = undefined;
          return { ok: true };
        }
        if (request.path === "/act") {
          const script = String(request.body?.fn);
          if (script.includes("const expectedSessionId =")) {
            const finalizing = script.includes("if (true &&");
            if (!finalizing && options?.shouldGateNonFinalTranscriptRead?.() === true) {
              options?.onNonFinalTranscriptRead?.();
              await options?.nonFinalTranscriptGate;
            }
            const responseTranscript = finalizing
              ? (options?.finalTranscript ?? options?.transcript)
              : options?.transcript;
            return {
              result: JSON.stringify({
                urlMatched: options?.tabUrlAfterJoin?.includes("/abc-defg-hij") !== false,
                droppedLines: responseTranscript?.droppedLines ?? 0,
                epoch: responseTranscript?.epoch,
                lines: responseTranscript?.lines ?? [],
              }),
            };
          }
          if (String(request.body?.fn).includes("leaveAction")) {
            const currentUrl = options?.tabUrlAfterJoin ?? openedTabUrl;
            const urlMatched = currentUrl?.includes("/abc-defg-hij") === true;
            if (!urlMatched) {
              return { result: JSON.stringify({ departed: true, urlMatched: false }) };
            }
            if (options?.leaveClicked === false) {
              return { result: JSON.stringify({ departed: false, urlMatched: true }) };
            }
            leaveStep += 1;
            if (leaveStep === 1) {
              return {
                result: JSON.stringify({
                  departed: false,
                  leaveAction: "leave",
                  urlMatched: true,
                }),
              };
            }
            return {
              result: JSON.stringify({ departed: true, urlMatched: true }),
            };
          }
          joined = true;
          return { result: JSON.stringify(meetBrowserState({ micMuted: true })) };
        }
        throw new Error(`unexpected browser request path ${request.path}`);
      },
    );
    localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
      await callGatewayFromCli(method, {}, params, requestOptions);
    return callGatewayFromCli;
  }

  async function withLocalChromeMeetSession<T>(
    options: Parameters<typeof mockLocalMeetBrowserRequestWithTabState>[0],
    run: (context: {
      callGatewayFromCli: ReturnType<typeof mockLocalMeetBrowserRequestWithTabState>;
      methods: ReturnType<typeof setup>["methods"];
      joined: GoogleMeetJoinResult;
    }) => Promise<T>,
  ): Promise<T> {
    return await withPlatform("darwin", async () => {
      const callGatewayFromCli = mockLocalMeetBrowserRequestWithTabState(options);
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as GoogleMeetJoinResult;
      return await run({ callGatewayFromCli, methods, joined });
    });
  }

  it("reads and snapshots the bounded transcript from the exact tracked tab", async () => {
    await withLocalChromeMeetSession(
      {
        transcript: {
          droppedLines: 2,
          lines: [
            { at: "2026-07-12T06:00:00.000Z", speaker: "Alice", text: "third line" },
            { at: "2026-07-12T06:00:01.000Z", speaker: "Bob", text: "fourth line" },
          ],
        },
      },
      async ({ callGatewayFromCli, methods, joined }) => {
        const beforeRead = callGatewayFromCli.mock.calls.length;
        const transcript = (await invokeGoogleMeetGatewayMethodForTest(
          methods,
          "googlemeet.transcript",
          { sessionId: joined.session.id, sinceIndex: 3 },
        )) as {
          droppedLines: number;
          startIndex: number;
          nextIndex: number;
          lines: Array<{ text: string }>;
        };
        expect(transcript).toMatchObject({ droppedLines: 2, startIndex: 3, nextIndex: 4 });
        expect(transcript.lines.map((line) => line.text)).toEqual(["fourth line"]);
        const readCalls = callGatewayFromCli.mock.calls.slice(beforeRead);
        expect(readCalls).toHaveLength(1);
        expect(requireRecord(readCalls[0]?.[2], "transcript request")).toMatchObject({
          method: "POST",
          path: "/act",
          body: { targetId: "local-meet-tab" },
        });

        await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
          sessionId: joined.session.id,
        });
        const afterLeave = (await invokeGoogleMeetGatewayMethodForTest(
          methods,
          "googlemeet.transcript",
          { sessionId: joined.session.id },
        )) as { lines: Array<{ text: string }> };
        expect(afterLeave.lines.map((line) => line.text)).toEqual(["third line", "fourth line"]);

        await expect(
          invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
            sessionId: joined.session.id,
            sinceIndex: 1.5,
          }),
        ).rejects.toThrow("sinceIndex must be a non-negative safe integer");
      },
    );
  });

  it("refuses to read a tracked tab after it navigates away from the meeting", async () => {
    await withLocalChromeMeetSession(
      {
        tabUrlAfterJoin: "https://meet.google.com/lookup/unrelated",
        transcript: { lines: [{ text: "must not leak" }] },
      },
      async ({ methods, joined }) => {
        await expect(
          invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
            sessionId: joined.session.id,
          }),
        ).rejects.toThrow("tracked Meet tab no longer shows this session's meeting URL");
      },
    );
  });

  it("does not let a late active read replace the finalized leave snapshot", async () => {
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let activeReads = 0;
    let gateNonFinalTranscriptReads = false;
    await withLocalChromeMeetSession(
      {
        transcript: { lines: [{ text: "partial" }] },
        finalTranscript: { lines: [{ text: "partial" }, { text: "complete caption" }] },
        nonFinalTranscriptGate: readGate,
        shouldGateNonFinalTranscriptRead: () => gateNonFinalTranscriptReads,
        onNonFinalTranscriptRead: () => {
          activeReads += 1;
          markReadStarted?.();
        },
      },
      async ({ callGatewayFromCli, methods, joined }) => {
        gateNonFinalTranscriptReads = true;
        const lateRead = invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
          sessionId: joined.session.id,
        });
        await readStarted;
        const secondRead = invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
          sessionId: joined.session.id,
        });
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        expect(activeReads).toBe(1);
        const leaving = invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
          sessionId: joined.session.id,
        });
        const repeatedLeave = invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
          sessionId: joined.session.id,
        });
        releaseRead?.();
        await Promise.allSettled([lateRead, secondRead, leaving, repeatedLeave]);
        const finalCaptures = callGatewayFromCli.mock.calls.filter((call) => {
          const request = call[2] as { body?: { fn?: string } };
          const script = String(request.body?.fn);
          return script.includes("const expectedSessionId =") && script.includes("if (true &&");
        });
        expect(finalCaptures).toHaveLength(1);
        const result = (await invokeGoogleMeetGatewayMethodForTest(
          methods,
          "googlemeet.transcript",
          { sessionId: joined.session.id },
        )) as { lines: Array<{ text: string }> };
        expect(result.lines.map((line) => line.text)).toEqual(["partial", "complete caption"]);
      },
    );
  });

  it("reports browserLeft false when the reused tab's Leave call click fails", async () => {
    await withLocalChromeMeetSession(
      { reused: true, leaveClicked: false },
      async ({ methods, joined }) => {
        const left = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
          sessionId: joined.session.id,
        })) as {
          found: boolean;
          browserLeft?: boolean;
          session: { state: string; notes: string[] };
        };

        expect(left.found).toBe(true);
        expect(left.session.state).toBe("ended");
        expect(left.browserLeft).toBe(false);
        expect(left.session.notes).toContain(
          "Could not find Meet's Leave call button in the reused browser tab; leave it manually.",
        );
      },
    );
  });

  it("does not touch a reused tab after it moves to another meeting", async () => {
    await withLocalChromeMeetSession(
      {
        reused: true,
        tabUrlAfterJoin: "https://meet.google.com/xyz-abcd-efg?hl=en",
      },
      async ({ callGatewayFromCli, methods, joined }) => {
        const left = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
          sessionId: joined.session.id,
        })) as { browserLeft?: boolean; session: { notes: string[] } };

        expect(left.browserLeft).toBe(true);
        expect(left.session.notes).toContain(
          "Meet tab moved away from this session; left its current page untouched.",
        );
        expect(
          callGatewayFromCli.mock.calls.some((call) =>
            String((call[2] as { body?: { fn?: string } }).body?.fn).includes("leaveAction"),
          ),
        ).toBe(true);
        expect(
          callGatewayFromCli.mock.calls.some(
            (call) => (call[2] as { method?: string }).method === "DELETE",
          ),
        ).toBe(false);
      },
    );
  });

  it("meet leave script clicks the enabled Leave call button", async () => {
    const makeButton = (label: string, disabled = false, iconText?: string) => ({
      disabled,
      innerText: "",
      textContent: "",
      click: vi.fn(),
      getAttribute: vi.fn((name: string) => (name === "aria-label" ? label : null)),
      querySelector: vi.fn((selector: string) =>
        selector === "i" && iconText !== undefined ? { textContent: iconText } : null,
      ),
    });
    const leaveButton = makeButton("Leave call");
    const document = {
      querySelectorAll: vi.fn((selector: string) =>
        selector === "button" ? [makeButton("Turn on captions"), leaveButton] : [],
      ),
    };
    const context = createContext({
      JSON,
      String,
      URL,
      location: { href: MEET_URL_EN },
      document,
    });
    const leaveScript = await captureMeetLeaveScript();
    const run = new Script(`(${leaveScript})()`).runInContext(context) as string;

    expect(leaveButton.click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(run)).toEqual({
      departed: false,
      leaveAction: "leave",
      urlMatched: true,
    });

    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button" ? [makeButton("Leave call", true)] : [],
    );
    const runDisabled = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(JSON.parse(runDisabled)).toEqual({ departed: false, urlMatched: true });

    // Localized UI: no English label anywhere, but the Material Symbols
    // "call_end" icon ligature identifies the leave control in any language.
    const localizedLeave = makeButton("Anruf verlassen", false, "call_end");
    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button"
        ? [makeButton("Untertitel aktivieren", false, "closed_caption_off"), localizedLeave]
        : [],
    );
    const runLocalized = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(localizedLeave.click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(runLocalized)).toEqual({
      departed: false,
      leaveAction: "leave",
      urlMatched: true,
    });

    const confirmLeave = makeButton("Leave meeting");
    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button" ? [makeButton("End meeting for all"), confirmLeave] : [],
    );
    const runConfirmation = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(confirmLeave.click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(runConfirmation)).toEqual({
      departed: false,
      leaveAction: "confirm",
      urlMatched: true,
    });

    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button" ? [makeButton("Rejoin")] : [],
    );
    const runDeparted = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(JSON.parse(runDeparted)).toEqual({ departed: true, urlMatched: true });

    leaveButton.click.mockClear();
    context.location.href = "https://meet.google.com/xyz-abcd-efg?hl=en";
    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button" ? [leaveButton] : [],
    );
    const runMoved = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(leaveButton.click).not.toHaveBeenCalled();
    expect(JSON.parse(runMoved)).toEqual({ departed: true, urlMatched: false });
  });

  it("refreshes blocked realtime browser health read-only when status is requested", async () => {
    let openedTab = false;
    const { methods, nodesInvoke } = setup(
      {
        defaultMode: "agent",
        defaultTransport: "chrome-node",
      },
      {
        nodesInvokeHandler: createNodeBrowserScenario({
          tabs: () => (openedTab ? [{ targetId: "tab-1", title: "Meet", url: MEET_URL_EN }] : []),
          targetId: "tab-1",
          open: (request) => {
            openedTab = true;
            return {
              targetId: "tab-1",
              title: "Meet",
              url: request.body?.url ?? MEET_URL_EN,
            };
          },
          focus: true,
          grantPermissions: true,
          navigate: (request) => ({
            targetId: request.body?.targetId ?? "tab-1",
            url: request.body?.url ?? MEET_URL_EN,
          }),
          inspect: () => ({
            inCall: false,
            manualAction: {
              reason: "meet-audio-choice-required",
              message: "Choose the Meet microphone path manually.",
            },
            title: "Meet",
            url: MEET_URL,
          }),
          nodeCommand: () => ({ payload: { launched: openedTab } }),
        }),
      },
    );

    const join = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
      url: MEET_URL,
    })) as { session: { id: string } };
    openedTab = true;
    nodesInvoke.mockClear();

    const status = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.status", {
      sessionId: join.session.id,
    })) as { session?: { chrome?: { health?: { manualAction?: unknown } } } };

    expect(status.session?.chrome?.health?.manualAction).toEqual({
      reason: "meet-audio-choice-required",
      message: "Choose the Meet microphone path manually.",
    });
    const actCall = requireNodeInvocation(nodesInvoke, { command: "browser.proxy", path: "/act" });
    const actParams = requireRecord(actCall.params, "act params");
    expect(requireRecord(actParams.body, "act body").targetId).toBe("tab-1");
    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        const params = requireRecord(call.params, "node invoke params");
        return call.command === "browser.proxy" && params.path === "/permissions/grant";
      }),
    ).toBe(false);
  });

  it("retries caption enable until the captions button is available", async () => {
    const leaveButton = meetButton("Leave call");
    const captionButton = meetButton("Turn on captions");
    const page = { buttons: [leaveButton] };
    const windowState: Record<string, unknown> = {};
    const context = createCaptionPageContext(() => page.buttons, windowState);
    const inspect = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: false,
        captionSessionId: "session-1",
        mode: "transcribe",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;

    const first = JSON.parse(await inspect()) as { captionsEnabledAttempted?: boolean };
    const captionsStateKey = "__openclawMeetCaptions";
    const stateAfterFirst = windowState[captionsStateKey] as {
      enabledAttempted?: boolean;
    };
    expect(first.captionsEnabledAttempted).toBe(false);
    expect(stateAfterFirst.enabledAttempted).toBe(false);
    expect(captionButton.click).not.toHaveBeenCalled();

    page.buttons = [leaveButton, captionButton];
    const second = JSON.parse(await inspect()) as { captionsEnabledAttempted?: boolean };
    const stateAfterSecond = windowState[captionsStateKey] as {
      enabledAttempted?: boolean;
    };
    expect(second.captionsEnabledAttempted).toBe(true);
    expect(stateAfterSecond.enabledAttempted).toBe(true);
    expect(captionButton.click).toHaveBeenCalledTimes(1);
  });

  it("reports in-call Meet audio permission problems from button labels", async () => {
    const context = createCaptionPageContext(() => [
      meetButton("Leave call"),
      meetButton("Microphone problem. Show more info"),
      meetButton("Microphone: Permission needed"),
      meetButton("Speaker: Permission needed"),
    ]);
    const inspect = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: false,
        mode: "agent",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;

    const result = JSON.parse(await inspect()) as {
      inCall?: boolean;
      manualAction?: { reason: string; message: string };
    };

    expect(result.inCall).toBe(true);
    expect(result.manualAction?.reason).toBe("meet-permission-required");
    expect(result.manualAction?.message).toContain("Allow microphone/camera/speaker permissions");
  });

  it("does not auto-join when Meet is already active elsewhere", async () => {
    const joinElsewhere = {
      disabled: false,
      innerText: "Join here too",
      textContent: "Join here too",
      click: vi.fn(),
      getAttribute: vi.fn(() => null),
    };
    const document = {
      body: { innerText: "", textContent: "" },
      title: "Meet",
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === "button") {
          return [joinElsewhere];
        }
        return [];
      }),
    };
    const context = createContext({
      JSON,
      document,
      location: {
        href: MEET_URL_EN,
        hostname: "meet.google.com",
      },
      window: {},
    });
    const inspect = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: true,
        mode: "transcribe",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;

    const result = JSON.parse(await inspect()) as {
      clickedJoin?: boolean;
      manualAction?: { reason: string; message: string };
    };

    expect(result.clickedJoin).toBe(false);
    expect(result.manualAction?.reason).toBe("meet-session-conflict");
    expect(joinElsewhere.click).not.toHaveBeenCalled();
  });

  it("does not unmute local or remote microphones without a verified virtual input", async () => {
    const remoteMute = meetButton("You can't remotely mute Peter Steinberger's microphone", true);
    const localMic = meetButton("Turn on microphone");
    const context = createCaptionPageContext(() => [
      meetButton("Leave call"),
      remoteMute,
      localMic,
    ]);
    const inspect = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: false,
        mode: "agent",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;

    const result = JSON.parse(await inspect()) as { micMuted?: boolean; notes?: string[] };

    expect(result.micMuted).toBe(true);
    expect(localMic.click).not.toHaveBeenCalled();
    expect(remoteMute.click).not.toHaveBeenCalled();
    expect(result.notes).not.toContain(
      "Turned on the Meet microphone after verifying the virtual audio input.",
    );
  });

  it("blocks realtime speech while the Meet microphone remains muted", async () => {
    await withPlatform("darwin", async () => {
      mockLocalMeetBrowserRequest(meetBrowserState({ micMuted: true }));
      const { methods } = setup({
        realtime: { introMessage: "" },
        chrome: {
          audioBridgeCommand: ["bridge", "start"],
          waitForInCallMs: 1,
        },
      });
      const payload = requireRecord(
        await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", { url: MEET_URL }),
        "join response",
      );
      const session = requireRecord(payload.session, "join session");
      const chrome = requireRecord(session.chrome, "join chrome");
      const health = requireRecord(chrome.health, "join health");
      expect(payload.spoken).toBe(false);
      expect(health.micMuted).toBe(true);
      expect(health.speechReady).toBe(false);
      expect(health.speechBlockedReason).toBe("meet-microphone-muted");
    });
  });

  it("opens an English replacement without touching an ambiguous matching tab", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesInvokeHandler: createNodeBrowserScenario({
          tabs: [
            {
              targetId: "wrong-account-english-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?authuser=other%40example.com&hl=en",
            },
            {
              targetId: "existing-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
            },
          ],
          open: () => ({
            targetId: "english-meet-tab",
            title: "Meet",
            url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
          }),
          grantPermissions: true,
          inspect: () => ({
            inCall: true,
            title: "Meet",
            url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
          }),
          nodeCommand: () => ({ payload: { launched: true } }),
        }),
      },
    );
    await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
      url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
    });

    const openCall = requireNodeInvocation(nodesInvoke, { path: "/tabs/open" });
    expect(requireRecord(openCall.params, "open params")).toEqual({
      method: "POST",
      path: "/tabs/open",
      timeoutMs: 30000,
      body: {
        url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
      },
    });
    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        const params = requireRecord(call.params, "node invoke params");
        return params.path === "/tabs/focus" || params.path === "/navigate";
      }),
    ).toBe(false);
    const actCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return params.path === "/act";
    });
    expect(actCalls.length).toBeGreaterThanOrEqual(1);
    const englishTabActCall = actCalls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return requireRecord(params.body, "act body").targetId === "english-meet-tab";
    });
    if (!englishTabActCall) {
      throw new Error("Expected browser.proxy /act on the English replacement tab");
    }
    const actParams = requireRecord(
      requireRecord(englishTabActCall[0], "act node invoke").params,
      "act params",
    );
    expect(actParams).toEqual({
      method: "POST",
      path: "/act",
      timeoutMs: expect.any(Number),
      body: {
        kind: "evaluate",
        targetId: "english-meet-tab",
        fn: expect.any(String),
      },
    });
    expect(actParams.timeoutMs).toBeGreaterThan(0);
    expect(actParams.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("prefers an English replacement when recovering matching Meet tabs", async () => {
    const { tools, nodesInvoke } = setup(
      { defaultTransport: "chrome-node" },
      {
        nodesInvokeHandler: createNodeBrowserScenario({
          tabs: [
            {
              targetId: "wrong-account-english-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?authuser=other%40example.com&hl=en",
            },
            {
              targetId: "ambiguous-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com",
            },
            {
              targetId: "english-meet-tab",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
            },
          ],
          focus: true,
          inspect: () => ({ inCall: true, title: "Meet", url: MEET_URL_EN }),
        }),
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com",
      readOnly: true,
    });

    expect(result.details.targetId).toBe("english-meet-tab");
    expect(requireRecord(result.details.browser, "recovered browser state").inCall).toBe(true);
    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        const params = requireRecord(call.params, "node invoke params");
        return (
          params.path === "/tabs/focus" &&
          requireRecord(params.body, "focus body").targetId === "english-meet-tab"
        );
      }),
    ).toBe(true);
  });

  it("preserves the Google sign-in diagnostic when no meeting tab is recoverable", async () => {
    const { tools } = setup(
      { defaultTransport: "chrome-node" },
      {
        nodesInvokeHandler: createNodeBrowserScenario({
          tabs: [
            {
              targetId: "google-sign-in-tab",
              title: "Sign in - Google Accounts - Meet",
              url: "https://accounts.google.com/signin",
            },
          ],
          focus: true,
          inspect: () => ({
            inCall: false,
            manualAction: {
              reason: "google-login-required",
              message: "Sign in to Google, then retry.",
            },
            url: "https://accounts.google.com/signin",
          }),
        }),
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", { action: "recover_current_tab" });
    const browser = requireRecord(result.details.browser, "recovered browser state");
    expect(result.details.targetId).toBe("google-sign-in-tab");
    expect(browser.manualAction).toEqual({
      reason: "google-login-required",
      message: "Sign in to Google, then retry.",
    });
  });

  it("reports an ambiguous local Chrome Meet tab without reloading it", async () => {
    const callGatewayFromCli = vi.fn(
      async (
        _method: string,
        _opts: unknown,
        params?: unknown,
        _extra?: unknown,
      ): Promise<Record<string, unknown>> => {
        const request = params as { path?: string; body?: { targetId?: string } };
        if (request.path === "/tabs") {
          return {
            tabs: [
              {
                targetId: "local-meet-tab",
                title: "Meet",
                url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
              },
            ],
          };
        }
        if (request.path === "/tabs/focus") {
          return { ok: true };
        }
        if (request.path === "/navigate") {
          return {
            targetId: request.body?.targetId ?? "local-meet-tab",
            url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
          };
        }
        if (request.path === "/act") {
          return {
            result: JSON.stringify({
              inCall: false,
              manualAction: {
                reason: "meet-admission-required",
                message: "Admit the OpenClaw browser participant in Google Meet.",
              },
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
            }),
          };
        }
        throw new Error(`unexpected browser request path ${request.path}`);
      },
    );
    localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
      await callGatewayFromCli(method, {}, params, requestOptions);
    const { tools, nodesInvoke } = setup({
      defaultTransport: "chrome",
      chrome: {
        browserProfile: "meet-devtools",
      },
    });
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: MEET_URL,
    });

    expect(result.details.transport).toBe("chrome");
    expect(result.details.found).toBe(true);
    expect(result.details.targetId).toBe("local-meet-tab");
    const browser = requireRecord(result.details.browser, "recovered browser state");
    expect(browser.manualAction).toMatchObject({
      reason: "meet-locale-required",
      message: expect.stringContaining("not pinned to English"),
    });
    const focusCall = callGatewayFromCli.mock.calls.find(
      (call) => requireRecord(call[2], "browser request").path === "/tabs/focus",
    );
    if (!focusCall) {
      throw new Error("Expected browser /tabs/focus request");
    }
    expect(focusCall[0]).toBe("browser.request");
    expect(requireRecord(focusCall[2], "focus request").method).toBe("POST");
    expect(requireRecord(focusCall[2], "focus request").path).toBe("/tabs/focus");
    expect(requireRecord(focusCall[2], "focus request").query).toBeUndefined();
    expect(focusCall[3]).toEqual({ timeoutMs: 10_000, scopes: ["operator.admin"] });
    expect(
      callGatewayFromCli.mock.calls.some((call) => {
        const requestPath = requireRecord(call[2], "browser request").path;
        return requestPath === "/navigate" || requestPath === "/act";
      }),
    ).toBe(false);
    expect(nodesInvoke).not.toHaveBeenCalled();
  });

  it("refreshes realtime browser state in status after a delayed Meet join", async () => {
    await withPlatform("darwin", async () => {
      let browserState: Record<string, unknown> = {
        inCall: false,
        title: "Meet",
        url: MEET_URL,
      };
      mockLocalMeetBrowserRequest(() => browserState, {
        trackOpenedTab: true,
        permissionResult: { ok: true },
      });
      const { methods } = setup({
        chrome: {
          audioBridgeCommand: ["bridge", "start"],
          waitForInCallMs: 1,
        },
        realtime: { introMessage: "" },
      });
      const joinPayload = requireRecord(
        await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", { url: MEET_URL }),
        "join response payload",
      );
      const joinSession = requireRecord(joinPayload.session, "join session");
      const joinChrome = requireRecord(joinSession.chrome, "join chrome session");
      expect(requireRecord(joinChrome.health, "join chrome health").inCall).toBe(false);
      browserState = {
        inCall: true,
        micMuted: false,
        title: "Meet",
        url: MEET_URL,
      };
      const statusPayload = requireRecord(
        await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.status", {}),
        "status response payload",
      );
      const sessions = statusPayload.sessions as unknown[];
      expect(sessions).toHaveLength(1);
      const statusSession = requireRecord(sessions[0], "status session");
      const statusChrome = requireRecord(statusSession.chrome, "status chrome session");
      const statusHealth = requireRecord(statusChrome.health, "status chrome health");
      expect(statusHealth.inCall).toBe(true);
      expect(statusHealth.speechReady).toBe(false);
      expect(statusHealth.speechBlockedReason).toBe("audio-bridge-unavailable");
    });
  });

  it("resets test speech output and loopback baselines when another agent owns the old session", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const oldSession = meetSession({
      id: "meet_old",
      agentId: "support",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: {
          audioOutputActive: true,
          lastOutputBytes: 100,
          outputLoopbackSignalBytes: 200,
          outputGeneration: 10,
          verifiedOutputGeneration: 10,
        },
      },
    });
    const newSession = meetSession({
      id: "meet_new",
      agentId: "main",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: {
          audioOutputActive: true,
          lastOutputBytes: 1,
          outputLoopbackSignalBytes: 2,
          outputGeneration: 1,
          verifiedOutputGeneration: 1,
        },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([oldSession]);
    vi.spyOn(runtime, "join").mockResolvedValue({ session: newSession, spoken: true });

    const result = await runtime.testSpeech({
      url: MEET_URL,
      agentId: "main",
      message: "Say exactly: hello.",
    });

    expect(result.speechOutputVerified).toBe(true);
    expect(result.speechOutputTimedOut).toBe(false);
  });

  it("keeps the pre-join output and loopback baselines when reusing the same session", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const session = meetSession({
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: {
          audioOutputActive: true,
          lastOutputBytes: 10,
          outputLoopbackSignalBytes: 20,
          outputGeneration: 1,
          verifiedOutputGeneration: 1,
        },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([session]);
    vi.spyOn(runtime, "join").mockImplementation(async () => {
      session.chrome!.health!.lastOutputBytes = 11;
      session.chrome!.health!.outputLoopbackSignalBytes = 21;
      session.chrome!.health!.outputGeneration = 2;
      session.chrome!.health!.verifiedOutputGeneration = 2;
      return { session, spoken: true };
    });

    const result = await runtime.testSpeech({
      url: MEET_URL,
      message: "Say exactly: hello.",
    });

    expect(result.speechOutputVerified).toBe(true);
    expect(result.speechOutputTimedOut).toBe(false);
  });

  it("does not verify speech from fresh output bytes without fresh loopback signal", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const session = meetSession({
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: {
          audioOutputActive: true,
          lastOutputBytes: 10,
          outputLoopbackSignalBytes: 20,
          outputGeneration: 1,
          verifiedOutputGeneration: 1,
        },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([session]);
    vi.spyOn(runtime, "join").mockImplementation(async () => {
      session.chrome!.health!.lastOutputBytes = 11;
      session.chrome!.health!.outputGeneration = 2;
      return { session, spoken: true };
    });

    const result = await runtime.testSpeech({
      url: MEET_URL,
      message: "Say exactly: hello.",
    });

    expect(result.speechOutputVerified).toBe(false);
    expect(result.speechOutputTimedOut).toBe(false);
  });

  it("rejects realtime and Twilio modes for test listen", async () => {
    const runtime = meetRuntime({}, noopLogger);

    await expect(
      runtime.testListen({
        url: MEET_URL,
        mode: "realtime",
      }),
    ).rejects.toThrow("test_listen requires mode: transcribe");

    await expect(
      runtime.testListen({
        url: MEET_URL,
        transport: "twilio",
      }),
    ).rejects.toThrow("test_listen supports chrome or chrome-node");
  });

  it("resets test listen transcript baselines when another agent owns the old session", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const oldSession = meetSession({
      id: "meet_old",
      mode: "transcribe",
      agentId: "support",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { transcriptLines: 10, lastCaptionText: "old caption" },
      },
    });
    const newSession = meetSession({
      id: "meet_new",
      mode: "transcribe",
      agentId: "main",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { transcriptLines: 1, lastCaptionText: "fresh caption" },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([oldSession]);
    vi.spyOn(runtime, "join").mockResolvedValue({ session: newSession, spoken: false });

    const result = await runtime.testListen({
      url: MEET_URL,
      agentId: "main",
    });

    expect(result.listenVerified).toBe(true);
    expect(result.listenTimedOut).toBe(false);
  });

  it("keeps the pre-join test listen baseline when reusing the same session", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const session = meetSession({
      mode: "transcribe",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { transcriptLines: 1, lastCaptionText: "old caption" },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([session]);
    vi.spyOn(runtime, "join").mockImplementation(async () => {
      session.chrome!.health = { transcriptLines: 2, lastCaptionText: "fresh caption" };
      return { session, spoken: false };
    });

    const result = await runtime.testListen({
      url: MEET_URL,
    });

    expect(result.listenVerified).toBe(true);
    expect(result.listenTimedOut).toBe(false);
  });

  it("preserves plugin ownership from browser create through join and leave", async () => {
    const createMeet = vi
      .spyOn(GOOGLE_MEET_PLATFORM_ADAPTER.create!, "browser")
      .mockResolvedValueOnce({
        source: "browser",
        nodeId: "meet-node",
        targetId: "created-meet-tab-a",
        openedByPlugin: true,
        meetingUri: "https://meet.google.com/drf-ihtb-pad",
      })
      .mockResolvedValueOnce({
        source: "browser",
        nodeId: "meet-node",
        targetId: "created-meet-tab-b",
        openedByPlugin: true,
        meetingUri: "https://meet.google.com/qwe-rtyu-iop",
      });
    const launchChromeMeetOnNode = vi
      .spyOn(chromeTransport, "launchChromeMeetOnNode")
      .mockResolvedValueOnce({
        nodeId: "meet-node",
        launched: true,
        tab: { targetId: "created-meet-tab-a", openedByPlugin: false },
        browser: { inCall: true, micMuted: true },
      })
      .mockResolvedValueOnce({
        nodeId: "meet-node",
        launched: true,
        tab: { targetId: "created-meet-tab-b", openedByPlugin: false },
        browser: { inCall: true, micMuted: true },
      });
    const leaveChromeMeet = vi
      .spyOn(chromeTransport, "leaveChromeMeet")
      .mockResolvedValue({ left: true, note: "left created tab" });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome-node",
          defaultMode: "transcribe",
        },
        noopLogger,
      );

      const createdA = await runtime.createViaBrowser();
      const createdB = await runtime.createViaBrowser();
      const joinedA = await runtime.join({
        url: createdA.meetingUri,
        transport: "chrome-node",
      });
      const joinedB = await runtime.join({
        url: createdB.meetingUri,
        transport: "chrome-node",
      });

      expect(joinedA.session.chrome?.browserTab).toEqual({
        targetId: "created-meet-tab-a",
        openedByPlugin: true,
      });
      expect(joinedB.session.chrome?.browserTab).toEqual({
        targetId: "created-meet-tab-b",
        openedByPlugin: true,
      });
      await runtime.leave(joinedA.session.id);
      await runtime.leave(joinedB.session.id);
      expect(leaveChromeMeet).toHaveBeenNthCalledWith(1, {
        runtime: expect.any(Object),
        transport: "chrome-node",
        nodeId: "meet-node",
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: "https://meet.google.com/drf-ihtb-pad",
        tab: { targetId: "created-meet-tab-a", openedByPlugin: true },
      });
      expect(leaveChromeMeet).toHaveBeenNthCalledWith(2, {
        runtime: expect.any(Object),
        transport: "chrome-node",
        nodeId: "meet-node",
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: "https://meet.google.com/qwe-rtyu-iop",
        tab: { targetId: "created-meet-tab-b", openedByPlugin: true },
      });
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeetOnNode.mockRestore();
      createMeet.mockRestore();
    }
  });

  it("stops the old Chrome bridge when the same agent changes talk-back mode", async () => {
    const stop = vi.fn(async () => {});
    const { launch: launchChromeMeet } = mockChromeMeetLifecycle({
      launches: [
        {
          launched: true,
          tab: { targetId: "shared-meet-tab", openedByPlugin: true },
          browser: { inCall: true, micMuted: false },
          audioBridge: meetAudioBridge(stop),
        },
        {
          launched: true,
          tab: { targetId: "shared-meet-tab", openedByPlugin: false },
          browser: { inCall: true, micMuted: false },
        },
      ],
    });
    try {
      const runtime = createChromeLifecycleRuntime();
      const first = await runtime.join({
        url: MEET_URL,
        agentId: "main",
        mode: "agent",
      });

      const second = await runtime.join({
        url: MEET_URL,
        agentId: "main",
        mode: "bidi",
      });

      expect(first.session.state).toBe("ended");
      expect(second.session.mode).toBe("bidi");
      expect(second.session.chrome?.browserTab).toEqual({
        targetId: "shared-meet-tab",
        openedByPlugin: true,
      });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      launchChromeMeet.mockRestore();
    }
  });

  it("reassigns an externally managed browser participant without requiring a tracked tab", async () => {
    const stop = vi.fn(async () => {});
    const { launch: launchChromeMeet, leave: leaveChromeMeet } = mockChromeMeetLifecycle({
      launches: [{ launched: false, audioBridge: meetAudioBridge(stop) }, { launched: false }],
      watchLeave: true,
    });
    try {
      const runtime = createChromeLifecycleRuntime({ chrome: { launch: false } });
      const first = await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });

      const second = await runtime.join({
        url: MEET_URL,
        agentId: "main",
      });

      expect(first.session.state).toBe("ended");
      expect(second.session.state).toBe("active");
      expect(stop).toHaveBeenCalledOnce();
      expect(leaveChromeMeet).not.toHaveBeenCalled();
    } finally {
      leaveChromeMeet?.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("leaves the old tab before reassignment when tab reuse is disabled", async () => {
    const stop = vi.fn(async () => {});
    const { launch: launchChromeMeet, leave: leaveChromeMeet } = mockChromeMeetLifecycle({
      launches: [
        {
          launched: true,
          tab: { targetId: "old-meet-tab", openedByPlugin: true },
          browser: { inCall: true, micMuted: false },
          audioBridge: meetAudioBridge(stop),
        },
        {
          launched: true,
          tab: { targetId: "new-meet-tab", openedByPlugin: true },
          browser: { inCall: true, micMuted: false },
        },
      ],
      leaveResults: [{ left: true, note: "left old browser tab" }],
    });
    try {
      const runtime = createChromeLifecycleRuntime({ chrome: { reuseExistingTab: false } });
      await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });

      const second = await runtime.join({
        url: MEET_URL,
        agentId: "main",
      });

      expect(stop).toHaveBeenCalledOnce();
      expect(leaveChromeMeet).toHaveBeenCalledOnce();
      expect(leaveChromeMeet).toHaveBeenCalledWith({
        runtime: expect.any(Object),
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: MEET_URL,
        tab: { targetId: "old-meet-tab", openedByPlugin: true },
      });
      expect(second.session.chrome?.browserTab?.targetId).toBe("new-meet-tab");
    } finally {
      leaveChromeMeet?.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("shares one in-flight browser leave and blocks a same-meeting join until it settles", async () => {
    const browserLeave = createDeferred<{ left: boolean; note: string }>();
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "leaving-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: true },
      })
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "replacement-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: true },
      });
    const leaveChromeMeet = vi
      .spyOn(chromeTransport, "leaveChromeMeet")
      .mockReturnValue(browserLeave.promise);
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "transcribe",
        },
        noopLogger,
      );
      const joined = await runtime.join({ url: MEET_URL });

      const firstLeave = runtime.leave(joined.session.id);
      const secondLeave = runtime.leave(joined.session.id);
      const replacementJoin = runtime.join({
        url: MEET_URL,
        agentId: "support",
      });
      await vi.waitFor(() => {
        expect(leaveChromeMeet).toHaveBeenCalledOnce();
      });
      expect(launchChromeMeet).toHaveBeenCalledOnce();
      browserLeave.resolve({ left: false, note: "browser leave failed" });

      const [firstResult, secondResult, replacement] = await Promise.all([
        firstLeave,
        secondLeave,
        replacementJoin,
      ]);
      expect(firstResult.browserLeft).toBe(false);
      expect(secondResult.browserLeft).toBe(false);
      expect(replacement.session.chrome?.browserTab?.targetId).toBe("replacement-meet-tab");
      expect(launchChromeMeet).toHaveBeenCalledTimes(2);
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("does not let a leave tear down a tab while another session adopts it", async () => {
    let resolveReplacementLaunch:
      | ((result: {
          launched: true;
          tab: { targetId: string; openedByPlugin: boolean };
          browser: { inCall: true; micMuted: true };
        }) => void)
      | undefined;
    const replacementLaunch = new Promise<{
      launched: true;
      tab: { targetId: string; openedByPlugin: boolean };
      browser: { inCall: true; micMuted: true };
    }>((resolve) => {
      resolveReplacementLaunch = resolve;
    });
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: true },
      })
      .mockReturnValueOnce(replacementLaunch);
    const leaveChromeMeet = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
      left: true,
      note: "left browser",
    });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "transcribe",
        },
        noopLogger,
      );
      const first = await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });

      const replacement = runtime.join({
        url: MEET_URL,
        agentId: "main",
      });
      await vi.waitFor(() => {
        expect(launchChromeMeet).toHaveBeenCalledTimes(2);
      });
      const oldLeave = runtime.leave(first.session.id);
      await Promise.resolve();
      expect(leaveChromeMeet).not.toHaveBeenCalled();

      resolveReplacementLaunch?.({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: false },
        browser: { inCall: true, micMuted: true },
      });
      const adopted = await replacement;
      await oldLeave;

      expect(adopted.session.chrome?.browserTab).toEqual({
        targetId: "shared-meet-tab",
        openedByPlugin: true,
      });
      expect(leaveChromeMeet).not.toHaveBeenCalled();

      await runtime.leave(adopted.session.id);
      expect(leaveChromeMeet).toHaveBeenCalledOnce();
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("reuses the stored session agent when a later Chrome bridge starts", async () => {
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        browser: { inCall: false, micMuted: false },
      })
      .mockResolvedValueOnce({
        launched: false,
        audioBridge: { type: "external-command" },
      });
    const recoverCurrentMeetTab = vi
      .spyOn(chromeTransport, "recoverCurrentMeetTab")
      .mockResolvedValue({
        transport: "chrome",
        found: true,
        message: "Existing Meet tab is in-call.",
        browser: {
          inCall: true,
          micMuted: false,
          audioInputRouted: true,
          audioOutputRouted: true,
        },
      });
    try {
      const runtime = createChromeLifecycleRuntime();

      const joined = await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });
      await runtime.speak(joined.session.id, "Say exactly: hello.");

      expect(joined.session.agentId).toBe("support");
      expect(launchChromeMeet).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          config: expect.objectContaining({
            realtime: expect.objectContaining({ agentId: "support" }),
          }),
        }),
      );
    } finally {
      recoverCurrentMeetTab.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("reports manual action when the browser profile needs Google login", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
      },
      {
        browserActResult: {
          inCall: false,
          manualAction: {
            reason: "google-login-required",
            message: "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.",
          },
          title: "Sign in - Google Accounts",
          url: "https://accounts.google.com/signin",
        },
        nodesInvokeResult: {
          payload: {
            launched: true,
          },
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "test_speech",
      url: MEET_URL,
      message: "Say exactly: hello.",
    });

    expect(result.details.manualAction).toEqual({
      reason: "google-login-required",
      message: "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.",
    });
    expect(result.details.spoken).toBe(false);
    expect(result.details.speechReady).toBe(false);
    expect(result.details.speechBlockedReason).toBe("google-login-required");
    const session = requireRecord(result.details.session, "manual action session");
    const chrome = requireRecord(session.chrome, "manual action session chrome");
    const health = requireRecord(chrome.health, "manual action chrome health");
    expect(health.manualAction).toEqual({
      reason: "google-login-required",
      message: "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.",
    });
    expect(health.speechReady).toBe(false);
    expect(health.speechBlockedReason).toBe("google-login-required");
  });

  it("recovers paired-node talkback without reopening the tracked tab", async () => {
    let openedTab = false;
    let browserReady = false;
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "agent",
        chrome: { reuseExistingTab: false, waitForInCallMs: 1 },
      },
      {
        nodesInvokeHandler: createNodeBrowserScenario({
          tabs: () => (openedTab ? [{ targetId: "tab-1", title: "Meet", url: MEET_URL_EN }] : []),
          targetId: "tab-1",
          open: (request) => {
            openedTab = true;
            return {
              targetId: "tab-1",
              title: "Meet",
              url: request.body?.url ?? MEET_URL_EN,
            };
          },
          focus: true,
          grantPermissions: true,
          navigate: (request) => ({
            targetId: request.body?.targetId ?? "tab-1",
            url: request.body?.url ?? MEET_URL_EN,
          }),
          inspect: () =>
            browserReady
              ? {
                  inCall: true,
                  micMuted: false,
                  audioInputRouted: true,
                  audioOutputRouted: true,
                  title: "Meet call",
                  url: MEET_URL,
                }
              : { inCall: true, title: "Meet call", url: MEET_URL },
          nodeCommand: () => ({ payload: { launched: true } }),
        }),
      },
    );

    const join = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
      url: MEET_URL,
      message: "Say exactly: hello.",
    })) as GoogleMeetJoinResult;
    expect(join.spoken).toBe(false);
    expect(join.session.chrome?.health?.speechBlockedReason).toBe("browser-unverified");

    browserReady = true;
    const retry = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.speak", {
      sessionId: join.session.id,
      message: "Say exactly: hello again.",
    })) as {
      found: boolean;
      spoken: boolean;
      session?: GoogleMeetSession;
    };

    expect(retry.found).toBe(true);
    expect(retry.spoken).toBe(false);
    const retrySession = requireRecord(retry.session, "retry session");
    const retryChrome = requireRecord(retrySession.chrome, "retry session chrome");
    const retryHealth = requireRecord(retryChrome.health, "retry chrome health");
    expect(retryHealth.inCall).toBe(true);
    expect(retryHealth.manualAction).toBeUndefined();
    expect(retryHealth.speechBlockedReason).toBe("audio-bridge-unavailable");
    const nodeStartCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "googlemeet.chrome" && params.action === "start";
    });
    expect(nodeStartCalls).toHaveLength(1);
    const focusCalls = nodesInvoke.mock.calls
      .map(([call]) => call)
      .filter(
        (call): call is { command: string; params: Record<string, unknown> } =>
          call.command === "browser.proxy" &&
          isRecord(call.params) &&
          call.params.path === "/tabs/focus",
      );
    expect(focusCalls.length).toBeGreaterThan(0);
    expect(focusCalls.at(-1)?.params.body).toStrictEqual({ targetId: "tab-1" });
    const openCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "browser.proxy" && params.path === "/tabs/open";
    });
    expect(openCalls).toHaveLength(1);
  });

  it("preserves telephony TTS output formats when routing Google Meet agent audio", () => {
    const ulaw = Buffer.from([0xff, 0x7f, 0x00]);
    const pcmBridgeConfig = resolveGoogleMeetConfig({ chrome: { audioFormat: "pcm16-24khz" } });
    const ulawBridgeConfig = resolveGoogleMeetConfig({ chrome: { audioFormat: "g711-ulaw-8khz" } });

    expect(
      convertMeetingTtsAudioForBridge(
        ulaw,
        8_000,
        ulawBridgeConfig.chrome.audioFormat,
        "raw-8khz-8bit-mono-mulaw",
        "Google Meet",
      ),
    ).toEqual(ulaw);
    const pcmForMeet = convertMeetingTtsAudioForBridge(
      ulaw,
      8_000,
      pcmBridgeConfig.chrome.audioFormat,
      "ulaw_8000",
      "Google Meet",
    );
    expect(pcmForMeet.byteLength).toBe(18);
    expect(pcmForMeet).not.toEqual(ulaw);
    expect(() =>
      convertMeetingTtsAudioForBridge(
        Buffer.from([1, 2, 3]),
        8_000,
        pcmBridgeConfig.chrome.audioFormat,
        "mp3",
        "Google Meet",
      ),
    ).toThrow("Unsupported telephony TTS output format");
  });

  it("defaults Chrome command-pair realtime to agent-driven talk-back", async () => {
    vi.useFakeTimers();
    try {
      const sendUserMessage = vi.fn();
      const { provider, requireRequest } = createTestMeetVoiceProvider({
        defaultModel: "gpt-realtime-2",
        sendUserMessage,
        triggerGreeting: vi.fn(),
      });
      const inputStdout = new PassThrough();
      const outputProcess = testBridgeProcess({
        stdin: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
        stdout: null,
      });
      const inputProcess = testBridgeProcess({ stdout: inputStdout, stdin: null });
      const spawnMock = vi
        .fn()
        .mockReturnValueOnce(outputProcess)
        .mockReturnValueOnce(inputProcess);
      const sessionStore: Record<string, unknown> = {};
      const runtime = {
        agent: {
          resolveAgentDir: vi.fn(() => "/tmp/agent"),
          resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
          ensureAgentWorkspace: vi.fn(async () => {}),
          session: createMockSessionRuntime(sessionStore),
          runEmbeddedAgent: vi.fn(async (_request: unknown) => ({
            payloads: [{ text: "The launch is still on track." }],
            meta: {},
          })),
          resolveAgentTimeoutMs: vi.fn(() => 1000),
        },
      };

      const handle = await startTestLocalRealtimeAudioBridge({
        config: resolveGoogleMeetConfig({ realtime: { provider: "openai", agentId: "jay" } }),
        fullConfig: {} as never,
        runtime: runtime as never,
        meetingSessionId: "meet-1",
        logger: noopLogger,
        providers: [provider],
        spawn: spawnMock,
      });
      const callbacks = requireRequest();

      expect(callbacks.autoRespondToAudio).toBe(false);
      expect(callbacks.tools).toStrictEqual([]);
      callbacks.onTranscript?.(
        "assistant",
        "Hi Molty, glad to have you here. Let me know if there's anything specific you'd like to cover or if you need any support during the meeting.",
        true,
      );
      callbacks.onTranscript?.(
        "user",
        "Let me know if there's anything specific you'd like to cover or if you need any support during the",
        true,
      );
      await vi.advanceTimersByTimeAsync(TEST_TALKBACK_DEBOUNCE_MS);
      expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();

      callbacks.onTranscript?.("user", "yes yes yes yes", true);
      callbacks.onTranscript?.("user", "Are we still on track?", true);
      callbacks.onTranscript?.("user", "Please include launch blockers.", true);

      await vi.advanceTimersByTimeAsync(TEST_TALKBACK_DEBOUNCE_MS);
      await vi.waitFor(() => {
        expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalledTimes(1);
      });
      const consultArgs = requireRecord(
        (runtime.agent.runEmbeddedAgent.mock.calls as unknown[][])[0]?.[0],
        "default talk-back agent request",
      );
      expect(consultArgs.agentId).toBe("jay");
      expect(consultArgs.spawnedBy).toBe("agent:jay:main");
      expect(consultArgs.sessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
      expect(consultArgs.sandboxSessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
      expect(JSON.stringify(consultArgs)).toContain("yes yes yes yes");
      expect(JSON.stringify(consultArgs)).toContain(
        "Are we still on track?\\nPlease include launch blockers.",
      );
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      const sentUserMessage: unknown = sendUserMessage.mock.calls[0]?.[0];
      expect(typeof sentUserMessage).toBe("string");
      expect(sentUserMessage).toContain(JSON.stringify("The launch is still on track."));
      expect(sessionStore).toHaveProperty("agent:jay:subagent:google-meet:meet-1");

      await handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a local barge-in input command to clear active Chrome playback", async () => {
    const { bridge, provider, requireRequest, sendAudio } = createTestMeetVoiceProvider({
      handleBargeIn: vi.fn(),
    });
    const inputStdout = new PassThrough();
    const bargeInStdout = new PassThrough();
    const outputStdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const replacementOutputStdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const outputProcess = testBridgeProcess({ stdin: outputStdin, stdout: null });
    const inputProcess = testBridgeProcess({ stdout: inputStdout, stdin: null });
    const bargeInProcess = testBridgeProcess({ stdout: bargeInStdout, stdin: null });
    const replacementOutputProcess = testBridgeProcess({
      stdin: replacementOutputStdin,
      stdout: null,
    });
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(outputProcess)
      .mockReturnValueOnce(inputProcess)
      .mockReturnValueOnce(bargeInProcess)
      .mockReturnValueOnce(replacementOutputProcess);

    const handle = await startTestLocalRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        chrome: {
          bargeInInputCommand: ["capture-human"],
          bargeInRmsThreshold: 10,
          bargeInPeakThreshold: 10,
          bargeInCooldownMs: 1,
        },
        realtime: { provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: {} as never,
      runtime: {} as never,
      meetingSessionId: "meet-1",
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });
    const callbacks = requireRequest();

    callbacks.onAudio(Buffer.alloc(48_000));
    inputStdout.write(Buffer.from([1, 2, 3, 4]));
    bargeInStdout.write(Buffer.from([0xff, 0x7f, 0xff, 0x7f]));

    expect(spawnMock).toHaveBeenNthCalledWith(3, "capture-human", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(bridge.handleBargeIn).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(outputProcess.kill).toHaveBeenCalledWith("SIGKILL");
    });
    expect(sendAudio).not.toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]));
    const health = handle.getHealth();
    expect(health.clearCount).toBe(1);
    expect(health.suppressedInputBytes).toBe(4);

    await handle.stop();
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(bargeInProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(replacementOutputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("pipes paired-node audio and clears playback through the realtime provider", async () => {
    const { bridge, provider, requireRequest, sendAudio } = createTestMeetVoiceProvider();
    let pullCount = 0;
    const idlePull = createDeferred<{ bridgeId: string }>();
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string; base64?: string } }) => {
          if (params?.action === "pullAudio") {
            pullCount += 1;
            return pullCount === 1
              ? { bridgeId: "bridge-1", base64: Buffer.from([9, 8, 7]).toString("base64") }
              : await idlePull.promise;
          }
          if (params?.action === "stop") {
            idlePull.resolve({ bridgeId: "bridge-1" });
          }
          return { ok: true };
        }),
      },
    };
    const handle = await startTestNodeRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { strategy: "bidi", provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: {} as never,
      runtime: runtime as never,
      meetingSessionId: "meet-1",
      nodeId: "node-1",
      bridgeId: "bridge-1",
      logger: noopLogger,
      providers: [provider],
    });
    try {
      const callbacks = requireRequest();
      await vi.waitFor(() => {
        expect(sendAudio).toHaveBeenCalledWith(Buffer.from([9, 8, 7]));
      });
      callbacks.onAudio(Buffer.from([1, 2, 3]));
      await vi.waitFor(() => {
        expect(runtime.nodes.invoke).toHaveBeenCalledWith({
          nodeId: "node-1",
          command: "googlemeet.chrome",
          params: {
            action: "pushAudio",
            bridgeId: "bridge-1",
            base64: Buffer.from([1, 2, 3]).toString("base64"),
            outputGeneration: 0,
          },
          timeoutMs: 5_000,
        });
      });
      callbacks.onClearAudio();
      await vi.waitFor(() => {
        expect(runtime.nodes.invoke).toHaveBeenCalledWith({
          nodeId: "node-1",
          command: "googlemeet.chrome",
          params: { action: "clearAudio", bridgeId: "bridge-1", outputGeneration: 1 },
          timeoutMs: 5_000,
        });
      });
      expect(handle.getHealth()).toMatchObject({
        audioInputActive: true,
        audioOutputActive: true,
        lastInputBytes: 3,
        lastOutputBytes: 3,
        clearCount: 1,
      });
    } finally {
      await handle.stop();
      idlePull.resolve({ bridgeId: "bridge-1" });
    }
    expect(bridge.close).toHaveBeenCalledOnce();
    expect(runtime.nodes.invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "googlemeet.chrome",
      params: { action: "stop", bridgeId: "bridge-1" },
      timeoutMs: 5_000,
    });
  });

  it("keeps paired-node realtime audio alive after transient input pull failures", async () => {
    vi.useFakeTimers();
    const { bridge, provider, sendAudio } = createTestMeetVoiceProvider({
      triggerGreeting: vi.fn(),
    });
    let pullCount = 0;
    let idlePullStarted = false;
    let releaseIdlePull: (() => void) | undefined;
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string } }) => {
          if (params?.action === "pullAudio") {
            pullCount += 1;
            if (pullCount === 1) {
              throw new Error("transient node timeout");
            }
            if (pullCount === 2) {
              return { bridgeId: "bridge-1", base64: Buffer.from([5, 4, 3]).toString("base64") };
            }
            idlePullStarted = true;
            await new Promise<void>((resolve) => {
              releaseIdlePull = resolve;
            });
            return { bridgeId: "bridge-1" };
          }
          releaseIdlePull?.();
          releaseIdlePull = undefined;
          return { ok: true };
        }),
      },
    };
    let handle: Awaited<ReturnType<typeof startTestNodeRealtimeAudioBridge>> | undefined;

    try {
      handle = await startTestNodeRealtimeAudioBridge({
        config: resolveGoogleMeetConfig({
          realtime: { provider: "openai", model: "gpt-realtime" },
        }),
        fullConfig: {} as never,
        runtime: runtime as never,
        meetingSessionId: "meet-1",
        nodeId: "node-1",
        bridgeId: "bridge-1",
        logger: noopLogger,
        providers: [provider],
      });

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => {
        expect(sendAudio).toHaveBeenCalledWith(Buffer.from([5, 4, 3]));
      });
      expect(bridge.close).not.toHaveBeenCalled();
      const health = handle.getHealth();
      expect(health.audioInputActive).toBe(true);
      expect(health.lastInputBytes).toBe(3);
      expect(health.consecutiveInputErrors).toBe(0);

      await vi.waitFor(() => {
        expect(idlePullStarted).toBe(true);
      });
      await handle.stop();
    } finally {
      await handle?.stop();
      vi.useRealTimers();
    }
  });

  it("stops paired-node realtime audio after repeated input pull failures", async () => {
    vi.useFakeTimers();
    const { bridge, provider } = createTestMeetVoiceProvider({ triggerGreeting: vi.fn() });
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string } }) => {
          if (params?.action === "pullAudio") {
            throw new Error("node invoke timeout");
          }
          return { ok: true };
        }),
      },
    };

    try {
      const handle = await startTestNodeRealtimeAudioBridge({
        config: resolveGoogleMeetConfig({
          realtime: { provider: "openai", model: "gpt-realtime" },
        }),
        fullConfig: {} as never,
        runtime: runtime as never,
        meetingSessionId: "meet-1",
        nodeId: "node-1",
        bridgeId: "bridge-1",
        logger: noopLogger,
        providers: [provider],
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(
        () => {
          expect(bridge.close).toHaveBeenCalled();
        },
        { timeout: 3_000 },
      );
      const health = handle.getHealth();
      expect(health.bridgeClosed).toBe(true);
      expect(health.consecutiveInputErrors).toBe(5);
      expect(health.lastInputError).toBe("node invoke timeout");
      const stopCall = runtime.nodes.invoke.mock.calls
        .map(([call]) => call)
        .find((call) => isRecord(call.params) && call.params.action === "stop");
      const stop = requireRecord(stopCall, "failed pull stop call");
      expect(stop.nodeId).toBe("node-1");
      expect(stop.command).toBe("googlemeet.chrome");
      expect(stop.params).toStrictEqual({ action: "stop", bridgeId: "bridge-1" });
      expect(stop.timeoutMs).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("CLI create can configure API-created space access", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      return Response.json(
        url.includes("oauth2.googleapis.com")
          ? { access_token: "new-access-token", expires_in: 3600, token_type: "Bearer" }
          : { name: "spaces/new-space", meetingCode: "new-abcd-xyz", meetingUri: MEETING_URL },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const stdout = captureStdout();
    const program = new Command();
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({
        oauth: { clientId: "client-id", refreshToken: "refresh-token" },
      }),
      ensureRuntime: async () => {
        throw new Error("URL-only creation must not start the runtime");
      },
    });

    try {
      await program.parseAsync(
        [
          "googlemeet",
          "create",
          "--no-join",
          "--access-type",
          "OPEN",
          "--entry-point-access",
          "ALL",
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain(`meeting uri: ${MEETING_URL}`);
      expect(stdout.output()).toContain("space: spaces/new-space");
      expect(stdout.output()).toContain("meeting code: new-abcd-xyz");
      const { fetchWithSsrFGuard } = await import("openclaw/plugin-sdk/ssrf-runtime");
      expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://meet.googleapis.com/v2/spaces",
          init: {
            method: "POST",
            headers: {
              Authorization: "Bearer new-access-token",
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ config: { accessType: "OPEN", entryPointAccess: "ALL" } }),
          },
          policy: { allowedHostnames: ["meet.googleapis.com"] },
        }),
      );
    } finally {
      stdout.restore();
    }
  });

  it("rejects access policy flags when tool create would use browser fallback", async () => {
    const { methods, nodesInvoke } = setupBrowser({ act: browserCreateResult });
    nodesInvoke.mockRejectedValue(new Error("browser fallback should not run"));

    await expect(
      invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.create", {
        join: false,
        accessType: "OPEN",
      }),
    ).rejects.toThrow("access policy options require OAuth/API room creation");
    expect(nodesInvoke).not.toHaveBeenCalled();
  });

  it("creates and joins a Meet through the create tool action by default", async () => {
    const { tools, nodesInvoke } = setupBrowser(
      {
        handleChromeStart: true,
        openedTargetId: (url) => (url === CREATE_URL ? "create-tab" : "join-tab"),
        act: (body) =>
          body.fn?.includes("meetUrlPattern")
            ? browserCreateResult()
            : JSON.stringify({
                inCall: true,
                micMuted: false,
                title: "Meet call",
                url: MEETING_URL,
              }),
      },
      { defaultMode: "transcribe" },
    );
    const result = await tools[0]?.execute("id", { action: "create" });

    expect(result?.details).toMatchObject({
      source: "browser",
      joined: true,
      meetingUri: MEETING_URL,
      join: { session: { url: MEETING_URL } },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(browserCall("/tabs/open", { url: CREATE_URL }));
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "googlemeet.chrome",
        params: expect.objectContaining({
          action: "start",
          url: MEETING_URL,
          launch: false,
        }),
      }),
    );
  });

  it("returns structured manual action from the create tool action", async () => {
    const browser = {
      browserUrl: "https://meet.google.com/new",
      browserTitle: "Meet",
      notes: ["Permission prompt detected."],
    };
    const { tools } = setupBrowser({
      openedTargetId: "permission-tab",
      act: () => ({ manualAction: PERMISSION_ACTION, ...browser }),
    });
    const result = await tools[0]?.execute("id", { action: "create" });
    expect(result?.details).toMatchObject({
      source: "browser",
      error: `${PERMISSION_ACTION.reason}: ${PERMISSION_ACTION.message}`,
      manualAction: PERMISSION_ACTION,
      browser: { nodeId: "node-1", targetId: "permission-tab", ...browser },
    });
  });

  it.each([false, true])(
    "reuses the create tab without opening duplicates (English: %s)",
    async (english) => {
      const targetId = english ? "existing-create-tab" : "navigated-create-tab";
      const { methods, nodesInvoke } = setupBrowser({
        tabs: [
          {
            targetId: "existing-create-tab",
            title: "Meet",
            url: english ? CREATE_URL : "https://meet.google.com/new",
          },
        ],
        ...(!english ? { navigateTo: { targetId, url: CREATE_URL } } : {}),
        act: browserCreateResult,
      });
      const result = await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.create", {
        join: false,
      });
      expect(result).toMatchObject({
        source: "browser",
        meetingUri: MEETING_URL,
        joined: false,
        browser: { nodeId: "node-1", targetId },
      });
      expect(nodesInvoke).toHaveBeenCalledWith(
        browserCall("/tabs/focus", { targetId: "existing-create-tab" }),
      );
      expect(nodesInvoke).toHaveBeenCalledWith(browserCall("/act", { targetId }));
      expect(nodesInvoke).not.toHaveBeenCalledWith(browserCall("/tabs/open"));
      if (english) {
        expect(nodesInvoke).not.toHaveBeenCalledWith(browserCall("/navigate"));
      } else {
        expect(nodesInvoke).toHaveBeenCalledWith(
          browserCall("/navigate", {
            targetId: "existing-create-tab",
            url: CREATE_URL,
          }),
        );
      }
    },
  );

  it.each([
    ["Use microphone", "Accepted Meet microphone prompt with browser automation."],
    [
      "Continue without microphone",
      "Continued through Meet microphone prompt with browser automation.",
    ],
  ])(
    "uses browser automation for Meet's %s choice during browser creation",
    async (buttonText, note) => {
      const location = { href: "https://meet.google.com/new", hostname: "meet.google.com" };
      const button = {
        disabled: false,
        innerText: buttonText,
        getAttribute: (name: string) => (name === "aria-label" ? buttonText : null),
        click: vi.fn(() => {
          location.href = MEETING_URL;
        }),
      };
      let result: unknown;
      const { tools } = setupBrowser({
        act: async ({ fn }) => {
          if (typeof fn !== "string") {
            throw new Error("expected browser create script");
          }
          result = await runInNewContext(`(${fn})()`, {
            location,
            document: {
              title: "Meet",
              body: { innerText: "Do you want people to hear you in the meeting?" },
              querySelectorAll: (selector: string) => (selector === "button" ? [button] : []),
            },
          });
          return { manualAction: PERMISSION_ACTION };
        },
      });
      await tools[0]?.execute("browser-script", { action: "create", join: false });
      expect(result).toMatchObject({ retryAfterMs: 1000, notes: [note] });
      expect(button.click).toHaveBeenCalledTimes(1);
      expect(result).not.toHaveProperty("meetingUri");
      expect(result).not.toHaveProperty("manualAction");
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
