import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext, Script } from "node:vm";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import {
  convertMeetingTtsAudioForBridge,
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
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { createRequireRecord, useMeetingTestState } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { registerGoogleMeetCli } from "./src/cli.js";
import { resolveGoogleMeetConfig, type GoogleMeetConfig } from "./src/config.js";
import { normalizeMeetUrl } from "./src/meet-url.js";
import { buildGoogleMeetPreflightReport, fetchGoogleMeetArtifacts } from "./src/meet.js";
import {
  createTestMeetRealtimeAudioTransport,
  meetAudioBridge,
  meetBrowserState,
  meetRuntime as buildMeetRuntime,
  meetSession,
  MEET_URL,
  MEET_URL_EN,
  stubMeetArtifactsApi,
} from "./src/test-support/fixtures.test-helpers.js";
import {
  captureStdout,
  createGoogleMeetToolGatewayForTest,
  getMeetTool,
  invokeGoogleMeetGatewayMethodForTest as invokeGateway,
  noopLogger,
  setupGoogleMeetPlugin,
  withPlatform,
} from "./src/test-support/plugin-harness.js";
import * as chromeTransport from "./src/transports/chrome.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./src/transports/google-meet-platform-adapter.js";
import {
  buildMeetDtmfSequence,
  normalizeDialInNumber,
  prefixDtmfWait,
} from "./src/transports/twilio.js";

type GoogleMeetJoinResult = Awaited<ReturnType<ReturnType<typeof meetRuntime>["join"]>>;

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

function meetRuntime(config: Parameters<typeof buildMeetRuntime>[0] = {}) {
  return buildMeetRuntime(config, noopLogger);
}

const testTempDirs = new Set<string>();

function createIsolatedTestDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  testTempDirs.add(dir);
  return dir;
}

type TestMeetVoiceBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

function createTestMeetVoiceProvider(
  options: {
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
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    ...(options.triggerGreeting ? { triggerGreeting: options.triggerGreeting } : {}),
    isConnected: vi.fn(() => true),
  };
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "OpenAI",
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

function createGoogleMeetTestEngineBindings(
  params: Pick<
    Parameters<typeof createMeetingRealtimeEngineBindings>[0],
    "config" | "fullConfig" | "runtime" | "logger"
  >,
) {
  return createMeetingRealtimeEngineBindings({ platform: GOOGLE_MEET_PLATFORM_ADAPTER, ...params });
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
    }> => ({ found: true, call: { callId: "call-1" } }),
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

function requestUrl(input: RequestInfo | URL): URL {
  return input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
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
      ? { gatewayAvailable: true, gatewayRequestHandler: localBrowserGatewayRequestHandler }
      : {}),
  });
  vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(
    createGoogleMeetToolGatewayForTest(harness.methods),
  );
  return { ...harness, tool: getMeetTool(harness) };
}

type GoogleMeetSetupOptions = NonNullable<Parameters<typeof setupGoogleMeetPlugin>[2]>;
type NodeInvokeHandler = NonNullable<GoogleMeetSetupOptions["nodesInvokeHandler"]>;
type NodeBrowserRequest = { path?: string; body?: BrowserProxyBody };
type NodeBrowserTab = { targetId: string; title: string; url: string };

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
  return mockBrowserProxy(
    {
      "/tabs": () => {
        const tabs = typeof params.tabs === "function" ? params.tabs() : params.tabs;
        return { running: true, tabs };
      },
      "/tabs/open": params.open,
      "/tabs/focus": params.focus ? () => ({ ok: true }) : undefined,
      "/permissions/grant": params.grantPermissions ? () => ({ ok: true }) : undefined,
      "/navigate": params.navigate,
      "/act": params.inspect
        ? (request) => ({
            ok: true,
            targetId: request.body?.targetId ?? params.targetId,
            result: JSON.stringify(params.inspect?.(request)),
          })
        : undefined,
    },
    params.nodeCommand,
  );
}

function openingNodeBrowser(inspect: () => Record<string, unknown>, launchBeforeOpen = false) {
  let opened = false;
  const markOpened = () => {
    opened = true;
  };
  return {
    markOpened,
    nodesInvokeHandler: createNodeBrowserScenario({
      tabs: () => (opened ? [browserTab("tab-1")] : []),
      targetId: "tab-1",
      open: (request) => {
        markOpened();
        return browserTab("tab-1", request.body?.url ?? MEET_URL_EN);
      },
      focus: true,
      grantPermissions: true,
      navigate: (request) => ({
        targetId: request.body?.targetId ?? "tab-1",
        url: request.body?.url ?? MEET_URL_EN,
      }),
      inspect,
      nodeCommand: () => ({ payload: { launched: launchBeforeOpen || opened } }),
    }),
  };
}

function nodeBrowserRequests(nodesInvoke: ReturnType<typeof setup>["nodesInvoke"]) {
  return nodesInvoke.mock.calls
    .map(([raw]) => requireRecord(raw, "node invoke"))
    .filter((call) => call.command === "browser.proxy")
    .map((call) => requireRecord(call.params, "node invoke params"));
}

function requireBrowserRequest(
  nodesInvoke: ReturnType<typeof setup>["nodesInvoke"],
  requestPath: string,
) {
  const request = nodeBrowserRequests(nodesInvoke).find((params) => params.path === requestPath);
  if (!request) {
    throw new Error(`Expected browser request ${requestPath}`);
  }
  return request;
}

function browserTab(targetId: string, url = MEET_URL_EN, title = "Meet") {
  return { targetId, title, url };
}

function chromeLaunch(
  targetId: string,
  openedByPlugin = true,
  extra: Partial<Awaited<ReturnType<typeof chromeTransport.launchChromeMeet>>> = {},
) {
  return {
    launched: true,
    tab: { targetId, openedByPlugin },
    browser: { inCall: true, micMuted: true },
    ...extra,
  };
}

function createChromeLifecycleRuntime(config: Record<string, unknown> = {}) {
  return meetRuntime({
    defaultTransport: "chrome",
    defaultMode: "agent",
    realtime: { introMessage: "" },
    ...config,
  });
}

function twilioJoinRequest() {
  return { action: "join" as const, url: MEET_URL, dialInNumber: "+15551234567", pin: "123456" };
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

type TwilioSetupCredentials = { accountSid: string; authToken: string; fromNumber: string };

type TwilioVoiceCallEntry = {
  enabled: boolean;
  config?: { provider?: string; publicUrl?: string };
};

async function runTwilioSetupStatus(params: {
  env?: TwilioSetupCredentials;
  googleMeetConfig?: NonNullable<Parameters<typeof setup>[0]>;
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
          config: { provider: "twilio", publicUrl: "https://voice.example.com/voice/webhook" },
        }
      : params.voiceCallEntry;
  const { tool } = setup(params.googleMeetConfig ?? { defaultTransport: "chrome" }, {
    fullConfig: {
      plugins: {
        allow: ["google-meet", "voice-call"],
        entries: voiceCallEntry ? { "voice-call": voiceCallEntry } : {},
      },
    },
  });
  return await tool.execute("id", { action: "setup_status", ...params.request });
}

function createCapturedBrowserRuntime(
  request: (params: Record<string, unknown>) => Promise<unknown>,
) {
  return {
    gateway: {
      isAvailable: async () => true,
      request: async (_method: string, params: Record<string, unknown>) => await request(params),
      async readSessionFacts() {
        throw new Error("Unexpected session facts request");
      },
    },
    system: {
      runCommandWithTimeout: async () => ({ code: 0, stdout: "BlackHole 2ch", stderr: "" }),
    },
  } as never;
}

function mockLocalBrowser(
  handler: (request: NodeBrowserRequest & { method?: string }) => Promise<Record<string, unknown>>,
) {
  const calls = vi.fn(
    async (_method: string, _opts: unknown, params?: unknown, _extra?: unknown) =>
      await handler(params as NodeBrowserRequest & { method?: string }),
  );
  localBrowserGatewayRequestHandler = async (method, params, options) =>
    await calls(method, {}, params, options);
  return calls;
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

async function inspectMeetButtons(
  buttons: unknown[],
  autoJoin = false,
  mode: "agent" | "transcribe" = "agent",
  url = MEET_URL,
): Promise<{
  inCall?: boolean;
  clickedJoin?: boolean;
  micMuted?: boolean;
  notes?: string[];
  manualAction?: { reason: string; message: string };
}> {
  const script = await captureMeetStatusScript({ autoJoin, mode });
  const context = createCaptionPageContext(() => buttons);
  context.location.href = url;
  const inspect = new Script(`(${script})`).runInContext(context) as () => string | Promise<string>;
  return JSON.parse(await inspect());
}

async function captureMeetStatusScript(params: {
  autoJoin: boolean;
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
      const tab = browserTab("local-meet-tab");
      return request.path === "/tabs" ? { tabs: [tab] } : tab;
    }
    if (request.path === "/tabs/focus" || request.path === "/permissions/grant") {
      return { ok: true };
    }
    if (request.path === "/act") {
      script = requireRecord(request.body, "Meet status request body").fn as string;
      return {
        result: JSON.stringify({
          manualAction: { reason: "meet-admission-required", message: "Waiting for admission" },
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
      meetingSessionId: "session-1",
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
        return { tabs: [browserTab("local-meet-tab")] };
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

function browserProxyPayload(result: unknown) {
  return { payload: { result } };
}

function mockBrowserProxy(
  routes: Record<string, ((request: NodeBrowserRequest) => unknown) | undefined>,
  nodeCommand?: (command: string, request: NodeBrowserRequest) => unknown,
): NodeInvokeHandler {
  return async ({ command, params }) => {
    const request = params as NodeBrowserRequest;
    if (command !== "browser.proxy" && nodeCommand) {
      return nodeCommand(command, request);
    }
    if (command !== "browser.proxy") {
      throw new Error(`unexpected node command ${command}`);
    }
    const handler = routes[request.path ?? ""];
    if (!handler) {
      throw new Error(`unexpected browser proxy path ${request.path}`);
    }
    return browserProxyPayload(await handler(request));
  };
}

function setupCreate(
  browser: Parameters<typeof createBrowserProxyHandler>[0] | NodeInvokeHandler,
  config?: Parameters<typeof setup>[0],
) {
  return setup(
    { defaultTransport: "chrome-node", chromeNode: { node: "parallels-macos" }, ...config },
    {
      nodesInvokeHandler:
        typeof browser === "function" ? browser : createBrowserProxyHandler(browser),
    },
  );
}

type BrowserProxyBody = { fn?: string; targetId?: string; url?: string };

type BrowserProxyTab = { targetId: string; title?: string; url?: string };

function browserCreateResult(meetingUri: string) {
  return { meetingUri, browserUrl: meetingUri, browserTitle: "Meet" };
}

function createBrowserProxyHandler(options: {
  act: (body: BrowserProxyBody) => unknown;
  handleChromeStart?: boolean;
  navigateTo?: BrowserProxyTab;
  openedTargetId?: string | ((url: string | undefined) => string);
  tabs?: BrowserProxyTab[];
}) {
  return mockBrowserProxy(
    {
      "/tabs": () => ({ tabs: options.tabs ?? [] }),
      "/tabs/open": (proxy) => {
        const targetId =
          typeof options.openedTargetId === "function"
            ? options.openedTargetId(proxy.body?.url)
            : (options.openedTargetId ?? "tab-1");
        return { targetId, title: "Meet", url: proxy.body?.url };
      },
      "/tabs/focus": () => ({ ok: true }),
      "/permissions/grant": () => ({ ok: true }),
      "/navigate": options.navigateTo ? () => options.navigateTo : undefined,
      "/act": async (proxy) => ({
        ok: true,
        targetId: proxy.body?.targetId,
        result: await options.act(proxy.body ?? {}),
      }),
    },
    (command) => {
      if (command === "googlemeet.chrome" && options.handleChromeStart) {
        return { payload: { launched: true } };
      }
      throw new Error(`unexpected node command ${command}`);
    },
  );
}

function expectBrowserProxyCall(
  nodesInvoke: ReturnType<typeof setup>["nodesInvoke"],
  proxyPath: string,
  body: BrowserProxyBody,
) {
  expect(nodesInvoke).toHaveBeenCalledWith(
    expect.objectContaining({
      command: "browser.proxy",
      params: expect.objectContaining({ path: proxyPath, body: expect.objectContaining(body) }),
    }),
  );
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
    vi.restoreAllMocks();
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
      { ...voice.provider, id: "google", label: "Google", autoSelectOrder: 2 },
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
    const { cliRegistrations, methods, tools, tool } = setup(undefined, {
      registerPlatform: "linux",
    });
    const callGatewayFromCli = vi.fn(async () => ({ ok: true }));
    vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockImplementation(callGatewayFromCli);
    async function expectJoin(
      id: string,
      params: { mode?: "transcribe"; transport?: "chrome-node" },
      count: number,
    ) {
      const request = { action: "join" as const, ...params };
      expect((await tool.execute(id, request)).details).toEqual({ ok: true });
      expect(callGatewayFromCli).toHaveBeenCalledTimes(count);
      expect(callGatewayFromCli).toHaveBeenNthCalledWith(
        count,
        "googlemeet.join",
        expect.any(Object),
        request,
        { progress: false, scopes: ["operator.admin"] },
      );
    }

    expect(tools).toHaveLength(1);
    expect(cliRegistrations).toHaveLength(1);
    expect(methods.has("googlemeet.setup")).toBe(true);

    await withPlatform("linux", () => expectJoin("linux-agent", {}, 1));
    await expectJoin("linux-transcribe", { mode: "transcribe" }, 2);

    const blocked = await withPlatform("win32", () =>
      tool.execute("windows-agent", { action: "join" }),
    );
    expect(blocked.details).toEqual({
      error:
        "Google Meet local Chrome talk-back audio requires macOS with BlackHole 2ch or Linux with PipeWire-Pulse. On this host, use mode: transcribe, transport: twilio, or a supported chrome-node.",
    });
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);

    await expectJoin("linux-chrome-node", { transport: "chrome-node" }, 3);
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
    const record = "conferenceRecords/rec-1";
    const participant = (id: string) => `${record}/participants/${id}`;
    const participantSession = (id: string, start: string, end: string) => ({
      name: `${participant(id)}/participantSessions/s1`,
      startTime: `2026-04-25T${start}:00Z`,
      endTime: `2026-04-25T${end}:00Z`,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/v2/conferenceRecords/rec-1") {
        return Response.json({
          name: record,
          startTime: "2026-04-25T10:00:00Z",
          endTime: "2026-04-25T11:00:00Z",
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants") {
        return Response.json({
          participants: ["p1", "p2"].map((id) => ({
            name: participant(id),
            signedinUser: { user: "users/alice", displayName: "Alice" },
          })),
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants/p1/participantSessions") {
        return Response.json({ participantSessions: [participantSession("p1", "10:10", "10:30")] });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants/p2/participantSessions") {
        return Response.json({ participantSessions: [participantSession("p2", "10:40", "10:50")] });
      }
      return new Response(`unexpected ${url.pathname}`, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { details: result } = await setup().tool.execute("attendance", {
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
    expect(result.attendance).toMatchObject([
      {
        displayName: "Alice",
        participants: [participant("p1"), participant("p2")],
        firstJoinTime: "2026-04-25T10:10:00.000Z",
        lastLeaveTime: "2026-04-25T10:50:00.000Z",
        durationMs: 1_800_000,
        late: true,
        earlyLeave: true,
        sessions: [
          { name: "conferenceRecords/rec-1/participants/p1/participantSessions/s1" },
          { name: "conferenceRecords/rec-1/participants/p2/participantSessions/s1" },
        ],
      },
    ]);
  });

  it("surfaces Developer Preview acknowledgment blockers in preflight reports", () => {
    const report = buildGoogleMeetPreflightReport({
      input: "abc-defg-hij",
      space: { name: "spaces/abc-defg-hij" },
      previewAcknowledged: false,
      tokenSource: "cached-access-token",
    });
    expect(report).toMatchObject({
      resolvedSpaceName: "spaces/abc-defg-hij",
      previewAcknowledged: false,
      blockers: [expect.stringContaining("Developer Preview Program")],
    });
  });

  it("builds Twilio dial plans from a PIN", () => {
    expect(normalizeDialInNumber("+1 (555) 123-4567")).toBe("+15551234567");
    expect(buildMeetDtmfSequence({ pin: "123 456" })).toBe("123456#");
    expect(buildMeetDtmfSequence({ dtmfSequence: "ww123#" })).toBe("ww123#");
    expect(prefixDtmfWait("123456#", 12000)).toBe("wwwwwwwwwwwwwwwwwwwwwwww123456#");
  });

  it.each([
    {
      label: "the invoking session key",
      config: { defaultTransport: "twilio" },
      options: {
        gatewayAvailable: true,
        toolContext: { sessionKey: "agent:support:pr103522-live" },
      },
      request: {
        dialInNumber: "+15551234567",
        agentId: "spoofed",
        requesterSessionKey: "agent:main:wrong",
      },
      trusted: true,
    },
    {
      label: "unsupported standalone agent routing",
      config: {},
      options: { toolContext: { agentId: "support", sessionKey: "agent:support:main" } },
      request: {},
      trusted: false,
    },
  ])("enforces join ownership from $label", async ({ config, options, request, trusted }) => {
    const { tool, gatewayRequest } = setup(config, options);
    const result = await tool.execute("id", { action: "join", url: MEET_URL, ...request });
    if (!request.dialInNumber) {
      expect(result.details.error).toContain("requires a Gateway-hosted agent run");
      return;
    }
    if (trusted) {
      expect(gatewayRequest).toHaveBeenCalledWith(
        "googlemeet.join",
        expect.objectContaining({
          agentId: "support",
          requesterSessionKey: "agent:support:pr103522-live",
        }),
        { timeoutMs: 60_000, scopes: ["operator.admin"] },
      );
    }
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        sessionKey: `agent:support:google-meet:${result.details.session.id}`,
      }),
    );
  });

  it("keeps test-listen probes on the agent that invoked the tool", async () => {
    const { tool, gatewayRequest } = setup(
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

    const result = await tool.execute("id", {
      action: "test_listen",
      url: MEET_URL,
      timeoutMs: "100",
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "googlemeet.testListen",
      expect.objectContaining({ agentId: "support", requesterSessionKey: "agent:support:main" }),
      { timeoutMs: 60_000, scopes: ["operator.admin"] },
    );
    expect(result.details.session.agentId).toBe("support");
    expect(result.details.listenVerified).toBe(true);
  });

  it("does not accept agent routing from an external gateway caller", async () => {
    const { methods } = setup({ defaultTransport: "twilio" });

    await invokeGateway(methods, "googlemeet.join", {
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
    const { tool } = setup({ defaultTransport: "twilio" });

    const result = await tool.execute("id", { action: "join", url: MEET_URL });

    expect(result.details.error).toContain("Twilio transport requires a Meet dial-in phone number");
    expect(result.details.error).toContain("Google Meet URLs do not include dial-in details");
  });

  it.each([
    {
      label: "an authoritative end reason",
      status: {
        found: true,
        call: { callId: "call-1", state: "completed", endReason: "completed" },
      },
      redial: true,
    },
    {
      label: "a temporary status failure",
      status: new Error("temporary voice gateway failure"),
      redial: false,
    },
  ])("reconciles Twilio reuse after $label", async ({ status, redial }) => {
    if (status instanceof Error) {
      voiceCallMocks.getMeetingVoiceCallGatewayCall.mockRejectedValueOnce(status);
    } else {
      voiceCallMocks.getMeetingVoiceCallGatewayCall.mockResolvedValueOnce(status);
    }
    const { tool } = setup({ defaultTransport: "twilio" });
    const request = twilioJoinRequest();
    const first = await tool.execute("first", request);
    const second = await tool.execute("second", request);

    expect(first.details.session.state).toBe(redial ? "ended" : "active");
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledTimes(redial ? 2 : 1);
    if (redial) {
      expect(first.details.session.notes).toContain("Voice Call is no longer active.");
      expect(second.details.session.id).not.toBe(first.details.session.id);
    } else {
      expect(second.details.session.id).toBe(first.details.session.id);
    }
  });

  it("serializes concurrent identical Twilio joins", async () => {
    const dialing = createDeferred<{ callId: string; dtmfSent: boolean; introSent: boolean }>();
    voiceCallMocks.joinMeetViaVoiceCallGateway.mockReturnValueOnce(dialing.promise);
    const runtime = meetRuntime({ defaultTransport: "twilio" });
    const request = { url: MEET_URL, dialInNumber: "+15551234567", pin: "123456" };

    const firstJoin = runtime.join(request);
    await vi.waitFor(() =>
      expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce(),
    );
    const secondJoin = runtime.join(request);
    await Promise.resolve();
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();

    dialing.resolve({ callId: "call-1", dtmfSent: true, introSent: true });
    const [first, second] = await Promise.all([firstJoin, secondJoin]);

    expect(second.session.id).toBe(first.session.id);
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();
  });

  it("does not delegate Twilio speech after leave", async () => {
    const { tool } = setup({ defaultTransport: "twilio" });
    const joined = await tool.execute("id", twilioJoinRequest());
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
    expect(spoken.details).toMatchObject({ spoken: false, found: true });
    expect(voiceCallMocks.speakMeetingViaVoiceCallGateway).not.toHaveBeenCalled();
  });

  it.each([
    [
      "agent-mode external bridge",
      {
        defaultMode: "agent",
        chrome: {
          audioBridgeCommand: ["bridge", "start"],
          audioInputCommand: ["capture-meet"],
          audioOutputCommand: ["play-meet"],
        },
      },
      "audio-bridge",
      expect.stringContaining("chrome.audioBridgeCommand is bidi-only"),
      undefined,
      false,
    ],
    [
      "missing virtual audio device",
      {},
      "chrome-local-audio-device",
      expect.stringContaining("BlackHole 2ch audio device not found"),
      "system_profiler",
      false,
    ],
    [
      "missing capture command",
      { chrome: { bargeInInputCommand: ["missing-barge-capture"] } },
      "chrome-local-audio-commands",
      "Chrome audio command missing: missing-barge-capture",
      "missing-barge-capture",
      false,
    ],
    [
      "observe-only mode",
      { defaultMode: "transcribe" },
      "audio-bridge",
      "Chrome observe-only mode does not require a realtime audio bridge",
      undefined,
      true,
    ],
  ] as const)(
    "checks Chrome audio setup for %s",
    async (_label, config, checkId, message, failingCommand, observe) => {
      await withPlatform("darwin", async () => {
        const { tool, runCommandWithTimeout } = setup(
          { defaultTransport: "chrome", ...config },
          {
            runCommandWithTimeoutHandler: async (argv) => {
              if (observe) {
                return { code: 1, stdout: "Built-in Output", stderr: "" };
              }
              if (argv[0]?.endsWith("system_profiler")) {
                return {
                  code: 0,
                  stdout:
                    failingCommand === "system_profiler" ? "Built-in Output" : "BlackHole 2ch",
                  stderr: "",
                };
              }
              return {
                code: argv[0] === "/bin/sh" && argv.at(-1) === failingCommand ? 1 : 0,
                stdout: "",
                stderr: "",
              };
            },
          },
        );
        const result = await tool.execute("id", {
          action: "setup_status",
          transport: "chrome",
          ...(observe ? { mode: "transcribe" } : {}),
        });
        expect(result.details.ok).toBe(observe);
        const check = requireSetupCheck(result.details.checks, checkId);
        expect(check).toMatchObject({ ok: observe, message });
        if (observe) {
          expect(
            result.details.checks?.filter((item) => item.id === "chrome-local-audio-device"),
          ).toStrictEqual([]);
          expect(runCommandWithTimeout).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("exports artifact bundles through the tool", async () => {
    stubMeetArtifactsApi();
    const outputDir = path.join(createIsolatedTestDir("openclaw-google-meet-export-"), "bundle");
    const result = await setup().tool.execute("id", {
      action: "export",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      outputDir,
      meeting: "abc-defg-hij",
      includeDocumentBodies: true,
      zip: true,
    });
    const manifest = requireRecord(
      JSON.parse(readFileSync(path.join(outputDir, "manifest.json"), "utf8")),
      "export manifest",
    );
    expect(manifest?.files).toEqual([
      "summary.md",
      "attendance.csv",
      "transcript.md",
      "artifacts.json",
      "attendance.json",
      "manifest.json",
    ]);
    expect(result.details.files).toContain(path.join(outputDir, "manifest.json"));
    expect(result.details.zipFile).toBe(`${outputDir}.zip`);
    expect(manifest?.request).toEqual({
      meeting: "abc-defg-hij",
      includeDocumentBodies: true,
      includeTranscriptEntries: true,
      allConferenceRecords: false,
      mergeDuplicateParticipants: true,
    });
    expect(manifest?.counts).toEqual({
      conferenceRecords: 1,
      artifacts: 1,
      recordings: 1,
      transcripts: 1,
      transcriptEntries: 1,
      smartNotes: 1,
      attendanceRows: 1,
      warnings: 0,
    });
  });

  it.each(["latest", "calendar_events"] as const)(
    "reports today's Meet calendar data through %s",
    async (action) => {
      stubMeetArtifactsApi();
      const { tool } = setup();
      const request = { accessToken: "token", expiresAt: Date.now() + 120_000, today: true };
      if (action === "latest") {
        const result = await tool.execute("id", { action, ...request });
        expect(result.details.calendarEvent?.meetingUri).toBe(MEET_URL);
      } else {
        const result = await tool.execute("id", { action, ...request });
        expect(result.details.events).toMatchObject([{ selected: true, meetingUri: MEET_URL }]);
      }
    },
  );

  it("fails setup status when the configured Chrome node is not connected", async () => {
    const { tool } = setup(
      { defaultTransport: "chrome-node", chromeNode: { node: "parallels-macos" } },
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

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(false);
    const check = requireSetupCheck(result.details.checks, "chrome-node-connected");
    expect(check.ok).toBe(false);
    expect(check.message).toContain("parallels-macos");
    expect(check.message).toContain("offline");
    expect(check.message).toContain("missing googlemeet.chrome");
    expect(check.message).toContain("missing browser.proxy/browser capability");
  });

  it("reports a blank environment from number as missing", async () => {
    const result = await runTwilioSetupStatus({
      env: { accountSid: "AC123", authToken: "test-auth-token", fromNumber: "   " },
      googleMeetConfig: {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
    });
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-credentials").ok).toBe(
      false,
    );
  });

  it.each([
    [
      "missing plugin entry",
      { voiceCallEntry: null, request: { transport: "twilio" } },
      false,
      "twilio-voice-call-plugin",
    ],
    [
      "request-provided dial-in",
      { request: { transport: "twilio", dialInNumber: "+15551234567" } },
      true,
      "twilio-dial-plan",
    ],
    [
      "a private webhook",
      {
        googleMeetConfig: { defaultTransport: "twilio" },
        voiceCallEntry: {
          enabled: true,
          config: { provider: "twilio", publicUrl: "http://[fd00::1]/voice/webhook" },
        },
      },
      false,
      "twilio-voice-call-webhook",
    ],
  ] as const)("reports Twilio setup with %s", async (_label, params, ok, id) => {
    const result = await runTwilioSetupStatus(params);
    expect(result.details.ok).toBe(ok);
    const check = requireSetupCheck(result.details.checks, id);
    expect(check.ok).toBe(ok);
    if (id === "twilio-dial-plan") {
      expect(check.message).toContain("request includes");
    }
  });

  type TestTranscript = {
    droppedLines?: number;
    epoch?: string;
    lines: Array<{ at?: string; speaker?: string; text: string }>;
  };
  function mockLocalMeetBrowserRequestWithTabState(options?: {
    reused?: boolean;
    tabUrlAfterJoin?: string;
    nonFinalTranscriptGate?: Promise<void>;
    onNonFinalTranscriptRead?: () => void;
    shouldGateNonFinalTranscriptRead?: () => boolean;
    finalTranscript?: TestTranscript;
    transcript?: TestTranscript;
  }) {
    let joined = false;
    let leaveStep = 0;
    let openedTabUrl = options?.reused ? MEET_URL_EN : undefined;
    return mockLocalBrowser(async (request) => {
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
      if (request.path === "/tabs/focus" || request.path === "/permissions/grant") {
        return { ok: true };
      }
      if (request.path === "/navigate") {
        openedTabUrl = request.body?.url ?? openedTabUrl;
        return { targetId: request.body?.targetId, url: openedTabUrl };
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
          leaveStep += 1;
          if (leaveStep === 1) {
            return {
              result: JSON.stringify({ departed: false, leaveAction: "leave", urlMatched: true }),
            };
          }
          return { result: JSON.stringify({ departed: true, urlMatched: true }) };
        }
        joined = true;
        return { result: JSON.stringify(meetBrowserState({ micMuted: true })) };
      }
      throw new Error(`unexpected browser request path ${request.path}`);
    });
  }

  async function withLocalChromeMeetSession<T>(
    options: Parameters<typeof mockLocalMeetBrowserRequestWithTabState>[0],
    run: (
      context: {
        callGatewayFromCli: ReturnType<typeof mockLocalMeetBrowserRequestWithTabState>;
      } & ReturnType<typeof sessionCommands>,
    ) => Promise<T>,
  ): Promise<T> {
    // Durable state workers must observe the same native OS identity as their owner.
    const callGatewayFromCli = mockLocalMeetBrowserRequestWithTabState(options);
    const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
    const joined = (await invokeGateway(methods, "googlemeet.join", {
      url: MEET_URL,
    })) as GoogleMeetJoinResult;
    return await run({ callGatewayFromCli, ...sessionCommands(methods, joined.session.id) });
  }

  function sessionCommands(methods: ReturnType<typeof setup>["methods"], sessionId: string) {
    return {
      transcript: (params: { sinceIndex?: number } = {}) =>
        invokeGateway(methods, "googlemeet.transcript", { sessionId, ...params }) as Promise<
          Awaited<ReturnType<ReturnType<typeof meetRuntime>["transcript"]>>
        >,
      leave: () => invokeGateway(methods, "googlemeet.leave", { sessionId }),
    };
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
      async ({ callGatewayFromCli, transcript, leave }) => {
        const beforeRead = callGatewayFromCli.mock.calls.length;
        const result = await transcript({ sinceIndex: 3 });
        expect(result).toMatchObject({
          droppedLines: 2,
          startIndex: 3,
          nextIndex: 4,
          lines: [{ text: "fourth line" }],
        });
        const readCalls = callGatewayFromCli.mock.calls.slice(beforeRead);
        expect(readCalls).toHaveLength(1);
        expect(requireRecord(readCalls[0]?.[2], "transcript request")).toMatchObject({
          method: "POST",
          path: "/act",
          body: { targetId: "local-meet-tab" },
        });

        await leave();
        expect(noopLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining("durable transcript finalization queued for retry"),
        );
        const afterLeave = await transcript();
        expect(afterLeave.lines.map((line) => line.text)).toEqual(["third line", "fourth line"]);

        await expect(transcript({ sinceIndex: 1.5 })).rejects.toThrow(
          "sinceIndex must be a non-negative safe integer",
        );
      },
    );
  });

  it("refuses to read a tracked tab after it navigates away from the meeting", async () => {
    await withLocalChromeMeetSession(
      {
        tabUrlAfterJoin: "https://meet.google.com/lookup/unrelated",
        transcript: { lines: [{ text: "must not leak" }] },
      },
      async ({ transcript }) => {
        await expect(transcript()).rejects.toThrow(
          "tracked Meet tab no longer shows this session's meeting URL",
        );
      },
    );
  });

  it("does not let a late active read replace the finalized leave snapshot", async () => {
    const readGate = createDeferred<void>();
    const readStarted = createDeferred<void>();
    let activeReads = 0;
    let gateNonFinalTranscriptReads = false;
    await withLocalChromeMeetSession(
      {
        transcript: { lines: [{ text: "partial" }] },
        finalTranscript: { lines: [{ text: "partial" }, { text: "complete caption" }] },
        nonFinalTranscriptGate: readGate.promise,
        shouldGateNonFinalTranscriptRead: () => gateNonFinalTranscriptReads,
        onNonFinalTranscriptRead: () => {
          activeReads += 1;
          readStarted.resolve();
        },
      },
      async ({ callGatewayFromCli, transcript, leave }) => {
        gateNonFinalTranscriptReads = true;
        const lateRead = transcript();
        await readStarted.promise;
        const secondRead = transcript();
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
        expect(activeReads).toBe(1);
        const leaving = leave();
        const repeatedLeave = leave();
        readGate.resolve();
        await Promise.allSettled([lateRead, secondRead, leaving, repeatedLeave]);
        const finalCaptures = callGatewayFromCli.mock.calls.filter((call) => {
          const request = call[2] as { body?: { fn?: string } };
          const script = String(request.body?.fn);
          return script.includes("const expectedSessionId =") && script.includes("if (true &&");
        });
        expect(finalCaptures).toHaveLength(1);
        const result = await transcript();
        expect(result.lines.map((line) => line.text)).toEqual(["partial", "complete caption"]);
      },
    );
  });

  it("leaves a reused tab untouched after it moves to another meeting", async () => {
    await withLocalChromeMeetSession(
      { reused: true, tabUrlAfterJoin: "https://meet.google.com/xyz-abcd-efg?hl=en" },
      async ({ callGatewayFromCli, leave }) => {
        const left = await leave();
        expect(left).toMatchObject({
          browserLeft: true,
          session: {
            notes: expect.arrayContaining([
              "Meet tab moved away from this session; left its current page untouched.",
            ]),
          },
        });
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
      ...meetButton(label, disabled),
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
    const context = createContext({ JSON, String, URL, location: { href: MEET_URL_EN }, document });
    const leaveScript = await captureMeetLeaveScript();
    function expectLeave(
      buttons: ReturnType<typeof makeButton>[],
      result: Record<string, unknown>,
    ) {
      document.querySelectorAll.mockImplementation((selector) =>
        selector === "button" ? buttons : [],
      );
      expect(JSON.parse(new Script(`(${leaveScript})()`).runInContext(context))).toEqual(result);
    }
    expectLeave([makeButton("Turn on captions"), leaveButton], {
      departed: false,
      leaveAction: "leave",
      urlMatched: true,
    });
    expect(leaveButton.click).toHaveBeenCalledTimes(1);
    expectLeave([makeButton("Leave call", true)], { departed: false, urlMatched: true });
    // The icon ligature identifies localized leave controls without an English label.
    const localizedLeave = makeButton("Anruf verlassen", false, "call_end");
    expectLeave(
      [makeButton("Untertitel aktivieren", false, "closed_caption_off"), localizedLeave],
      { departed: false, leaveAction: "leave", urlMatched: true },
    );
    expect(localizedLeave.click).toHaveBeenCalledTimes(1);
    const confirmLeave = makeButton("Leave meeting");
    expectLeave([makeButton("End meeting for all"), confirmLeave], {
      departed: false,
      leaveAction: "confirm",
      urlMatched: true,
    });
    expect(confirmLeave.click).toHaveBeenCalledTimes(1);
    expectLeave([makeButton("Rejoin")], { departed: true, urlMatched: true });
    leaveButton.click.mockClear();
    context.location.href = "https://meet.google.com/xyz-abcd-efg?hl=en";
    expectLeave([leaveButton], { departed: true, urlMatched: false });
    expect(leaveButton.click).not.toHaveBeenCalled();
  });

  it("refreshes blocked realtime browser health read-only when status is requested", async () => {
    const { nodesInvokeHandler, markOpened } = openingNodeBrowser(() => ({
      inCall: false,
      title: "Meet",
      url: MEET_URL,
      manualAction: {
        reason: "meet-audio-choice-required",
        message: "Choose the Meet microphone path manually.",
      },
    }));
    const { methods, nodesInvoke } = setup(
      { defaultMode: "agent", defaultTransport: "chrome-node" },
      { nodesInvokeHandler },
    );

    const join = (await invokeGateway(methods, "googlemeet.join", { url: MEET_URL })) as {
      session: { id: string };
    };
    markOpened();
    nodesInvoke.mockClear();

    const status = (await invokeGateway(methods, "googlemeet.status", {
      sessionId: join.session.id,
    })) as { session?: { chrome?: { health?: { manualAction?: unknown } } } };

    expect(status.session?.chrome?.health?.manualAction).toEqual({
      reason: "meet-audio-choice-required",
      message: "Choose the Meet microphone path manually.",
    });
    const actParams = requireBrowserRequest(nodesInvoke, "/act");
    expect(requireRecord(actParams.body, "act body").targetId).toBe("tab-1");
    expect(nodeBrowserRequests(nodesInvoke).some((p) => p.path === "/permissions/grant")).toBe(
      false,
    );
  });

  it("reports in-call Meet audio permission problems from button labels", async () => {
    const result = await inspectMeetButtons([
      meetButton("Leave call"),
      meetButton("Microphone problem. Show more info"),
      meetButton("Microphone: Permission needed"),
      meetButton("Speaker: Permission needed"),
    ]);
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
    const result = await inspectMeetButtons([joinElsewhere], true, "transcribe", MEET_URL_EN);
    expect(result.clickedJoin).toBe(false);
    expect(result.manualAction?.reason).toBe("meet-session-conflict");
    expect(joinElsewhere.click).not.toHaveBeenCalled();
  });

  it("does not unmute local or remote microphones without a verified virtual input", async () => {
    const remoteMute = meetButton("You can't remotely mute Peter Steinberger's microphone", true);
    const localMic = meetButton("Turn on microphone");
    const result = await inspectMeetButtons([meetButton("Leave call"), remoteMute, localMic]);
    expect(result.micMuted).toBe(true);
    expect(localMic.click).not.toHaveBeenCalled();
    expect(remoteMute.click).not.toHaveBeenCalled();
    expect(result.notes).not.toContain(
      "Turned on the Meet microphone after verifying the virtual audio input.",
    );
  });

  it("opens an English replacement without touching an ambiguous matching tab", async () => {
    const requestedUrl = `${MEET_URL}?authuser=me@example.com`;
    const englishUrl = `${MEET_URL}?authuser=me%40example.com&hl=en`;
    const { methods, nodesInvoke } = setup(
      { defaultTransport: "chrome-node", defaultMode: "transcribe" },
      {
        nodesInvokeHandler: createNodeBrowserScenario({
          tabs: [
            browserTab(
              "wrong-account-english-tab",
              `${MEET_URL}?authuser=other%40example.com&hl=en`,
            ),
            browserTab("existing-meet-tab", requestedUrl),
          ],
          open: () => browserTab("english-meet-tab", englishUrl),
          grantPermissions: true,
          inspect: () => ({ inCall: true, title: "Meet", url: englishUrl }),
          nodeCommand: () => ({ payload: { launched: true } }),
        }),
      },
    );
    await invokeGateway(methods, "googlemeet.join", { url: requestedUrl });

    expect(requireBrowserRequest(nodesInvoke, "/tabs/open")).toEqual({
      method: "POST",
      path: "/tabs/open",
      timeoutMs: 30000,
      body: { url: englishUrl },
    });
    expect(
      nodeBrowserRequests(nodesInvoke).some(
        (p) => p.path === "/tabs/focus" || p.path === "/navigate",
      ),
    ).toBe(false);
    const actCalls = nodeBrowserRequests(nodesInvoke).filter((params) => params.path === "/act");
    expect(actCalls.length).toBeGreaterThanOrEqual(1);
    const actParams = actCalls.find((params) => {
      return requireRecord(params.body, "act body").targetId === "english-meet-tab";
    });
    if (!actParams) {
      throw new Error("Expected browser.proxy /act on the English replacement tab");
    }
    expect(actParams).toEqual({
      method: "POST",
      path: "/act",
      timeoutMs: expect.any(Number),
      body: { kind: "evaluate", targetId: "english-meet-tab", fn: expect.any(String) },
    });
    expect(actParams.timeoutMs).toBeGreaterThan(0);
    expect(actParams.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("recovers the sign-in diagnostic when no meeting tab is recoverable", async () => {
    const { tool } = setup(
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
    const result = await tool.execute("id", { action: "recover_current_tab" });
    expect(result.details.targetId).toBe("google-sign-in-tab");
    expect(requireRecord(result.details.browser, "recovered browser state").manualAction).toEqual({
      reason: "google-login-required",
      message: "Sign in to Google, then retry.",
    });
  });

  it("reports an ambiguous local Chrome Meet tab without reloading it", async () => {
    const callGatewayFromCli = mockLocalBrowser(async (request) => {
      if (request.path === "/tabs") {
        return {
          tabs: [browserTab("local-meet-tab", `${MEET_URL}?authuser=me@example.com`)],
        };
      }
      if (request.path === "/tabs/focus") {
        return { ok: true };
      }
      throw new Error(`unexpected browser request path ${request.path}`);
    });
    const { tool, nodesInvoke } = setup({
      defaultTransport: "chrome",
      chrome: { browserProfile: "meet-devtools" },
    });

    const result = await tool.execute("id", { action: "recover_current_tab", url: MEET_URL });

    expect(result.details).toMatchObject({
      transport: "chrome",
      found: true,
      targetId: "local-meet-tab",
      browser: {
        manualAction: {
          reason: "meet-locale-required",
          message: expect.stringContaining("not pinned to English"),
        },
      },
    });
    const focusCall = callGatewayFromCli.mock.calls.find(
      (call) => requireRecord(call[2], "browser request").path === "/tabs/focus",
    );
    if (!focusCall) {
      throw new Error("Expected browser /tabs/focus request");
    }
    expect(focusCall[0]).toBe("browser.request");
    expect(focusCall[2]).toMatchObject({ method: "POST", path: "/tabs/focus" });
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

  it("does not verify test speech from fresh output without fresh loopback", async () => {
    const runtime = meetRuntime({});
    const session = meetSession({
      chrome: {
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
    const result = await runtime.testSpeech({ url: MEET_URL, message: "Say exactly: hello." });
    expect(result).toMatchObject({ speechOutputVerified: false, speechOutputTimedOut: false });
  });

  it("rejects realtime and Twilio modes for test listen", async () => {
    const runtime = meetRuntime({});

    await expect(runtime.testListen({ url: MEET_URL, mode: "realtime" })).rejects.toThrow(
      "test_listen requires mode: transcribe",
    );

    await expect(runtime.testListen({ url: MEET_URL, transport: "twilio" })).rejects.toThrow(
      "test_listen supports chrome or chrome-node",
    );
  });

  it("preserves plugin ownership from browser create through join and leave", async () => {
    const meetings = [
      { targetId: "created-meet-tab-a", meetingUri: "https://meet.google.com/drf-ihtb-pad" },
      { targetId: "created-meet-tab-b", meetingUri: "https://meet.google.com/qwe-rtyu-iop" },
    ];
    const createMeet = vi.spyOn(GOOGLE_MEET_PLATFORM_ADAPTER.create!, "browser");
    const launchChromeMeetOnNode = vi.spyOn(chromeTransport, "launchChromeMeetOnNode");
    for (const { targetId, meetingUri } of meetings) {
      createMeet.mockResolvedValueOnce({
        source: "browser",
        nodeId: "meet-node",
        targetId,
        openedByPlugin: true,
        meetingUri,
      });
      launchChromeMeetOnNode.mockResolvedValueOnce({
        ...chromeLaunch(targetId, false),
        nodeId: "meet-node",
      });
    }
    const leaveChromeMeet = vi
      .spyOn(chromeTransport, "leaveChromeMeet")
      .mockResolvedValue({ left: true, note: "left created tab" });
    const runtime = meetRuntime({ defaultTransport: "chrome-node", defaultMode: "transcribe" });

    const created = [await runtime.createViaBrowser(), await runtime.createViaBrowser()];
    const joined: GoogleMeetJoinResult[] = [];
    for (const space of created) {
      joined.push(await runtime.join({ url: space.meetingUri, transport: "chrome-node" }));
    }
    expect(joined.map(({ session }) => session.chrome?.browserTab)).toEqual(
      meetings.map(({ targetId }) => ({ targetId, openedByPlugin: true })),
    );
    for (const { session } of joined) {
      await runtime.leave(session.id);
    }
    for (const [index, { targetId, meetingUri }] of meetings.entries()) {
      expect(leaveChromeMeet).toHaveBeenNthCalledWith(index + 1, {
        runtime: expect.any(Object),
        transport: "chrome-node",
        nodeId: "meet-node",
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: meetingUri,
        tab: { targetId, openedByPlugin: true },
      });
    }
  });

  it("settles the old Chrome bridge before changing meeting mode", async () => {
    const stop = vi.fn(async () => {});
    vi.spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce(
        chromeLaunch("shared-meet-tab", true, {
          browser: { inCall: true, micMuted: false },
          audioBridge: meetAudioBridge(stop),
        }),
      )
      .mockResolvedValueOnce(
        chromeLaunch("shared-meet-tab", false, { browser: { inCall: true, micMuted: false } }),
      );
    const runtime = createChromeLifecycleRuntime();
    const first = await runtime.join({ url: MEET_URL, agentId: "main", mode: "agent" });
    const second = await runtime.join({ url: MEET_URL, agentId: "main", mode: "bidi" });
    expect(stop).toHaveBeenCalledOnce();
    expect(first.session.state).toBe("ended");
    expect(second.session.mode).toBe("bidi");
    expect(second.session.chrome?.browserTab).toEqual({
      targetId: "shared-meet-tab",
      openedByPlugin: true,
    });
  });

  it("shares one in-flight browser leave and blocks a same-meeting join until it settles", async () => {
    const browserLeave = createDeferred<{ left: boolean; note: string }>();
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce(chromeLaunch("leaving-meet-tab"))
      .mockResolvedValueOnce(chromeLaunch("replacement-meet-tab"));
    const leaveChromeMeet = vi
      .spyOn(chromeTransport, "leaveChromeMeet")
      .mockReturnValue(browserLeave.promise);
    const runtime = meetRuntime({ defaultTransport: "chrome", defaultMode: "transcribe" });
    const joined = await runtime.join({ url: MEET_URL });

    const firstLeave = runtime.leave(joined.session.id);
    const secondLeave = runtime.leave(joined.session.id);
    const replacementJoin = runtime.join({ url: MEET_URL, agentId: "support" });
    await vi.waitFor(() => expect(leaveChromeMeet).toHaveBeenCalledOnce());
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
  });

  it("does not let a leave tear down a tab while another session adopts it", async () => {
    const replacementLaunch =
      createDeferred<Awaited<ReturnType<typeof chromeTransport.launchChromeMeet>>>();
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce(chromeLaunch("shared-meet-tab"))
      .mockReturnValueOnce(replacementLaunch.promise);
    const leaveChromeMeet = vi
      .spyOn(chromeTransport, "leaveChromeMeet")
      .mockResolvedValue({ left: true, note: "left browser" });
    const runtime = meetRuntime({ defaultTransport: "chrome", defaultMode: "transcribe" });
    const first = await runtime.join({ url: MEET_URL, agentId: "support" });

    const replacement = runtime.join({ url: MEET_URL, agentId: "main" });
    await vi.waitFor(() => expect(launchChromeMeet).toHaveBeenCalledTimes(2));
    const oldLeave = runtime.leave(first.session.id);
    await Promise.resolve();
    expect(leaveChromeMeet).not.toHaveBeenCalled();

    replacementLaunch.resolve(chromeLaunch("shared-meet-tab", false));
    const adopted = await replacement;
    await oldLeave;

    expect(adopted.session.chrome?.browserTab).toEqual({
      targetId: "shared-meet-tab",
      openedByPlugin: true,
    });
    expect(leaveChromeMeet).not.toHaveBeenCalled();

    await runtime.leave(adopted.session.id);
    expect(leaveChromeMeet).toHaveBeenCalledOnce();
  });

  it("reuses the stored session agent when a later Chrome bridge starts", async () => {
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({ launched: true, browser: { inCall: false, micMuted: false } })
      .mockResolvedValueOnce({ launched: false, audioBridge: { type: "external-command" } });
    vi.spyOn(chromeTransport, "recoverCurrentMeetTab").mockResolvedValue({
      transport: "chrome",
      found: true,
      message: "Existing Meet tab is in-call.",
      browser: { inCall: true, micMuted: false, audioInputRouted: true, audioOutputRouted: true },
    });
    const runtime = createChromeLifecycleRuntime();

    const joined = await runtime.join({ url: MEET_URL, agentId: "support" });
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
  });

  it("reports manual action when the browser profile needs Google login", async () => {
    const manualAction = {
      reason: "google-login-required",
      message: "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.",
    };
    const { tool } = setup(
      { defaultTransport: "chrome-node" },
      {
        browserActResult: {
          inCall: false,
          manualAction,
          title: "Sign in - Google Accounts",
          url: "https://accounts.google.com/signin",
        },
        nodesInvokeResult: { payload: { launched: true } },
      },
    );

    const result = await tool.execute("id", {
      action: "test_speech",
      url: MEET_URL,
      message: "Say exactly: hello.",
    });

    const blocked = { speechReady: false, speechBlockedReason: "google-login-required" };
    expect(result.details).toMatchObject({
      ...blocked,
      spoken: false,
      manualAction,
      session: { chrome: { health: { ...blocked, manualAction } } },
    });
    expect(result.details.manualAction).toEqual(manualAction);
    expect(result.details.session?.chrome?.health?.manualAction).toEqual(manualAction);
  });

  it("recovers paired-node talkback without reopening the tracked tab", async () => {
    let browserReady = false;
    const { nodesInvokeHandler } = openingNodeBrowser(
      () =>
        browserReady ? meetBrowserState() : { inCall: true, title: "Meet call", url: MEET_URL },
      true,
    );
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "agent",
        chrome: { reuseExistingTab: false, waitForInCallMs: 1 },
      },
      { nodesInvokeHandler },
    );

    const join = (await invokeGateway(methods, "googlemeet.join", {
      url: MEET_URL,
      message: "Say exactly: hello.",
    })) as GoogleMeetJoinResult;
    expect(join.spoken).toBe(false);
    expect(join.session.chrome?.health?.speechBlockedReason).toBe("browser-unverified");

    browserReady = true;
    const retry = (await invokeGateway(methods, "googlemeet.speak", {
      sessionId: join.session.id,
      message: "Say exactly: hello again.",
    })) as Awaited<ReturnType<ReturnType<typeof meetRuntime>["speak"]>>;
    expect(retry).toMatchObject({
      found: true,
      spoken: false,
      session: {
        chrome: { health: { inCall: true, speechBlockedReason: "audio-bridge-unavailable" } },
      },
    });
    expect(retry.session?.chrome?.health?.manualAction).toBeUndefined();
    const nodeStartCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "googlemeet.chrome" && params.action === "start";
    });
    expect(nodeStartCalls).toHaveLength(1);
    const focusCalls = nodeBrowserRequests(nodesInvoke).filter((p) => p.path === "/tabs/focus");
    expect(focusCalls.length).toBeGreaterThan(0);
    expect(focusCalls.at(-1)?.body).toStrictEqual({ targetId: "tab-1" });
    const openCalls = nodeBrowserRequests(nodesInvoke).filter(
      (params) => params.path === "/tabs/open",
    );
    expect(openCalls).toHaveLength(1);
  });

  it("preserves telephony TTS output formats when routing Google Meet agent audio", () => {
    const ulaw = Buffer.from([0xff, 0x7f, 0x00]);
    const pcmBridgeConfig = resolveGoogleMeetConfig({
      chrome: { audioFormat: "pcm16-24khz", audioBackend: "blackhole-2ch", audioBufferBytes: 1 },
    });
    const ulawBridgeConfig = resolveGoogleMeetConfig({ chrome: { audioFormat: "g711-ulaw-8khz" } });
    const convert = (
      format: GoogleMeetConfig["chrome"]["audioFormat"],
      outputFormat: string,
      audio = ulaw,
    ) => convertMeetingTtsAudioForBridge(audio, 8_000, format, outputFormat, "Google Meet");
    const commandPrefix = ["sox", "-q", "--buffer", "17"];
    expect(pcmBridgeConfig.chrome.audioInputCommand?.slice(0, 4)).toEqual(commandPrefix);
    expect(pcmBridgeConfig.chrome.audioOutputCommand?.slice(0, 4)).toEqual(commandPrefix);
    expect(pcmBridgeConfig.chrome.audioBufferBytes).toBe(17);

    expect(convert(ulawBridgeConfig.chrome.audioFormat, "raw-8khz-8bit-mono-mulaw")).toEqual(ulaw);
    const pcmForMeet = convert(pcmBridgeConfig.chrome.audioFormat, "ulaw_8000");
    expect(pcmForMeet.byteLength).toBe(18);
    expect(pcmForMeet).not.toEqual(ulaw);
    expect(() =>
      convert(pcmBridgeConfig.chrome.audioFormat, "mp3", Buffer.from([1, 2, 3])),
    ).toThrow("Unsupported telephony TTS output format");
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
    const engineParams = {
      config: resolveGoogleMeetConfig({
        realtime: { strategy: "bidi", provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: {} as never,
      runtime: runtime as never,
      logger: noopLogger,
    };
    const transport = createNodeMeetingRealtimeAudioTransport({
      ...engineParams,
      nodeId: "node-1",
      bridgeId: "bridge-1",
      commandName: "googlemeet.chrome",
      logScope: "[google-meet]",
      logPrefix: "node",
    });
    Reflect.set(transport, Symbol.for("openclaw.internal.meeting-node-output-generation.v1"), true);
    const handle = await startMeetingRealtimeEngine({
      ...engineParams,
      ...createGoogleMeetTestEngineBindings(engineParams),
      meetingSessionId: "meet-1",
      logPrefix: "node",
      talkSessionId: "google-meet:meet-1:bridge-1:node-realtime",
      talkContext: { nodeId: "node-1", bridgeId: "bridge-1" },
      transport,
      providers: [provider],
    });
    function expectNodeCommand(params: Record<string, unknown>) {
      expect(runtime.nodes.invoke).toHaveBeenCalledWith({
        nodeId: "node-1",
        command: "googlemeet.chrome",
        params: { bridgeId: "bridge-1", ...params },
        timeoutMs: 5_000,
      });
    }
    try {
      const callbacks = requireRequest();
      await vi.waitFor(() => expect(sendAudio).toHaveBeenCalledWith(Buffer.from([9, 8, 7])));
      callbacks.onAudio(Buffer.from([1, 2, 3]));
      await vi.waitFor(() =>
        expectNodeCommand({
          action: "pushAudio",
          base64: Buffer.from([1, 2, 3]).toString("base64"),
          outputGeneration: 0,
        }),
      );
      callbacks.onClearAudio();
      await vi.waitFor(() => expectNodeCommand({ action: "clearAudio", outputGeneration: 1 }));
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
    expectNodeCommand({ action: "stop" });
  });

  it("CLI create can configure API-created space access", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("oauth2.googleapis.com")) {
        return Response.json({
          access_token: "new-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      return Response.json({
        name: "spaces/new-space",
        meetingCode: "new-abcd-xyz",
        meetingUri: "https://meet.google.com/new-abcd-xyz",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const program = new Command();
    const stdout = captureStdout();
    const ensureRuntime = vi.fn(async () => {
      throw new Error("URL-only creation must not start the runtime");
    });
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({
        oauth: { clientId: "client-id", refreshToken: "refresh-token" },
      }),
      ensureRuntime,
    });

    await program.parseAsync(
      ["googlemeet", "create", "--no-join", "--access-type", "OPEN", "--entry-point-access", "ALL"],
      { from: "user" },
    );
    expect(ensureRuntime).not.toHaveBeenCalled();
    expect(stdout.output()).toContain("meeting uri: https://meet.google.com/new-abcd-xyz");
    expect(stdout.output()).toContain("space: spaces/new-space");
    expect(stdout.output()).toContain("meeting code: new-abcd-xyz");
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
  });

  it("rejects access policy flags when tool create would use browser fallback", async () => {
    const { methods, nodesInvoke } = setupCreate(async () => {
      throw new Error("browser fallback should not run");
    });

    await expect(
      invokeGateway(methods, "googlemeet.create", { join: false, accessType: "OPEN" }),
    ).rejects.toThrow("access policy options require OAuth/API room creation");
    expect(nodesInvoke).not.toHaveBeenCalled();
  });

  it("creates and joins a Meet through the create tool action by default", async () => {
    const { tools, nodesInvoke } = setupCreate(
      {
        handleChromeStart: true,
        openedTargetId: (url) =>
          url === "https://meet.google.com/new?hl=en" ? "create-tab" : "join-tab",
        act: (body) =>
          body.fn?.includes("meetUrlPattern")
            ? browserCreateResult("https://meet.google.com/new-abcd-xyz")
            : JSON.stringify({
                inCall: true,
                micMuted: false,
                title: "Meet call",
                url: "https://meet.google.com/new-abcd-xyz",
              }),
      },
      { defaultMode: "transcribe" },
    );
    const result = await tools[0]?.execute("id", { action: "create" });
    expect(result?.details).toMatchObject({
      source: "browser",
      joined: true,
      meetingUri: "https://meet.google.com/new-abcd-xyz",
      join: { session: { url: "https://meet.google.com/new-abcd-xyz" } },
    });
    expectBrowserProxyCall(nodesInvoke, "/tabs/open", { url: "https://meet.google.com/new?hl=en" });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "googlemeet.chrome",
        params: expect.objectContaining({
          action: "start",
          url: "https://meet.google.com/new-abcd-xyz",
          launch: false,
        }),
      }),
    );
  });

  it("returns structured manual action from the create tool action", async () => {
    const manualAction = {
      reason: "meet-permission-required",
      message:
        "Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
    };
    const { tools } = setupCreate({
      openedTargetId: "permission-tab",
      act: () => ({
        manualAction,
        browserUrl: "https://meet.google.com/new",
        browserTitle: "Meet",
        notes: ["Permission prompt detected."],
      }),
    });
    const details = requireRecord(
      (await tools[0]?.execute("id", { action: "create" }))?.details,
      "create details",
    );
    expect(details.source).toBe("browser");
    expect(details.error).toBe(
      "meet-permission-required: Allow microphone/camera permissions for Meet in the OpenClaw browser profile, then retry meeting creation.",
    );
    expect(details.manualAction).toEqual(manualAction);
    expect(details.browser).toMatchObject({
      nodeId: "node-1",
      targetId: "permission-tab",
      browserUrl: "https://meet.google.com/new",
      browserTitle: "Meet",
      notes: ["Permission prompt detected."],
    });
  });

  it("reuses an existing browser create tab instead of opening duplicates", async () => {
    const { methods, nodesInvoke } = setupCreate({
      tabs: [browserTab("existing-create-tab", "https://meet.google.com/new")],
      navigateTo: { targetId: "navigated-create-tab", url: "https://meet.google.com/new?hl=en" },
      act: () => browserCreateResult("https://meet.google.com/reu-sedx-tab"),
    });
    const payload = requireRecord(
      await invokeGateway(methods, "googlemeet.create", { join: false }),
      "response payload",
    );
    expect(payload).toMatchObject({
      source: "browser",
      meetingUri: "https://meet.google.com/reu-sedx-tab",
      joined: false,
      browser: { nodeId: "node-1", targetId: "navigated-create-tab" },
    });
    expectBrowserProxyCall(nodesInvoke, "/tabs/focus", { targetId: "existing-create-tab" });
    expectBrowserProxyCall(nodesInvoke, "/navigate", {
      targetId: "existing-create-tab",
      url: "https://meet.google.com/new?hl=en",
    });
    expectBrowserProxyCall(nodesInvoke, "/act", { targetId: "navigated-create-tab" });
    expect(nodesInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser.proxy",
        params: expect.objectContaining({ path: "/tabs/open" }),
      }),
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
