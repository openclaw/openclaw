import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.ts";
import plugin from "./index.js";
import { resolveGoogleMeetConfig, resolveGoogleMeetConfigWithEnv } from "./src/config.js";
import {
  buildGoogleMeetPreflightReport,
  fetchGoogleMeetSpace,
  normalizeGoogleMeetSpaceName,
} from "./src/meet.js";
import {
  buildGoogleMeetAuthUrl,
  refreshGoogleMeetAccessToken,
  resolveGoogleMeetAccessToken,
} from "./src/oauth.js";
import { startCommandRealtimeAudioBridge } from "./src/realtime.js";
import { normalizeMeetUrl } from "./src/runtime.js";
import { buildMeetDtmfSequence, normalizeDialInNumber } from "./src/transports/twilio.js";

const voiceCallMocks = vi.hoisted(() => ({
  joinMeetViaVoiceCallGateway: vi.fn(async () => ({ callId: "call-1", dtmfSent: true })),
}));

vi.mock("./src/voice-call-gateway.js", () => ({
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
}));

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type TestBridgeProcess = {
  stdin?: { write(chunk: unknown): unknown } | null;
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr: PassThrough;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  on: EventEmitter["on"];
};

function setup(config: Record<string, unknown> = {}) {
  const methods = new Map<string, unknown>();
  const tools: unknown[] = [];
  const cliRegistrations: unknown[] = [];
  const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
    if (argv[0] === "system_profiler") {
      return { code: 0, stdout: "BlackHole 2ch", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const api = createTestPluginApi({
    id: "google-meet",
    name: "Google Meet",
    description: "test",
    version: "0",
    source: "test",
    pluginConfig: config,
    runtime: {
      system: {
        runCommandWithTimeout,
        formatNativeDependencyHint: vi.fn(() => "Install with brew install blackhole-2ch."),
      },
    } as unknown as OpenClawPluginApi["runtime"],
    logger: noopLogger,
    registerGatewayMethod: (method: string, handler: unknown) => methods.set(method, handler),
    registerTool: (tool: unknown) => tools.push(tool),
    registerCli: (_registrar: unknown, opts: unknown) => cliRegistrations.push(opts),
  });
  plugin.register(api);
  return { cliRegistrations, methods, tools, runCommandWithTimeout };
}

describe("google-meet plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to chrome realtime with safe read-only tools", () => {
    expect(resolveGoogleMeetConfig({})).toMatchObject({
      enabled: true,
      defaults: {},
      preview: { enrollmentAcknowledged: false },
      defaultTransport: "chrome",
      defaultMode: "realtime",
      chrome: { audioBackend: "blackhole-2ch", launch: true },
      voiceCall: { enabled: true, requestTimeoutMs: 30000, dtmfDelayMs: 2500 },
      realtime: { toolPolicy: "safe-read-only" },
      oauth: {},
      auth: { provider: "google-oauth" },
    });
  });

  it("uses env fallbacks for OAuth, preview, and default meeting values", () => {
    expect(
      resolveGoogleMeetConfigWithEnv(
        {},
        {
          OPENCLAW_GOOGLE_MEET_CLIENT_ID: "client-id",
          GOOGLE_MEET_CLIENT_SECRET: "client-secret",
          OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN: "refresh-token",
          GOOGLE_MEET_ACCESS_TOKEN: "access-token",
          OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: "123456",
          GOOGLE_MEET_DEFAULT_MEETING: "https://meet.google.com/abc-defg-hij",
          OPENCLAW_GOOGLE_MEET_PREVIEW_ACK: "true",
        },
      ),
    ).toMatchObject({
      defaults: { meeting: "https://meet.google.com/abc-defg-hij" },
      preview: { enrollmentAcknowledged: true },
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
        accessToken: "access-token",
        expiresAt: 123456,
      },
    });
  });

  it("requires explicit Meet URLs", () => {
    expect(normalizeMeetUrl("https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(() => normalizeMeetUrl("https://example.com/abc-defg-hij")).toThrow("meet.google.com");
  });

  it("advertises only the googlemeet CLI descriptor", () => {
    const { cliRegistrations } = setup();

    expect(cliRegistrations).toContainEqual({
      commands: ["googlemeet"],
      descriptors: [
        {
          name: "googlemeet",
          description: "Join and manage Google Meet calls",
          hasSubcommands: true,
        },
      ],
    });
  });

  it("normalizes Meet URLs, codes, and space names for the Meet API", () => {
    expect(normalizeGoogleMeetSpaceName("spaces/abc-defg-hij")).toBe("spaces/abc-defg-hij");
    expect(normalizeGoogleMeetSpaceName("abc-defg-hij")).toBe("spaces/abc-defg-hij");
    expect(normalizeGoogleMeetSpaceName("https://meet.google.com/abc-defg-hij")).toBe(
      "spaces/abc-defg-hij",
    );
    expect(() => normalizeGoogleMeetSpaceName("https://example.com/abc-defg-hij")).toThrow(
      "meet.google.com",
    );
  });

  it("fetches Meet spaces without percent-encoding the spaces path separator", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          name: "spaces/abc-defg-hij",
          meetingCode: "abc-defg-hij",
          meetingUri: "https://meet.google.com/abc-defg-hij",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchGoogleMeetSpace({
        accessToken: "token",
        meeting: "spaces/abc-defg-hij",
      }),
    ).resolves.toMatchObject({ name: "spaces/abc-defg-hij" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });

  it("surfaces Developer Preview acknowledgment blockers in preflight reports", () => {
    expect(
      buildGoogleMeetPreflightReport({
        input: "abc-defg-hij",
        space: { name: "spaces/abc-defg-hij" },
        previewAcknowledged: false,
        tokenSource: "cached-access-token",
      }),
    ).toMatchObject({
      resolvedSpaceName: "spaces/abc-defg-hij",
      previewAcknowledged: false,
      blockers: [expect.stringContaining("Developer Preview Program")],
    });
  });

  it("builds Meet OAuth URLs and prefers fresh cached access tokens", async () => {
    const url = new URL(
      buildGoogleMeetAuthUrl({
        clientId: "client-id",
        challenge: "challenge",
        state: "state",
      }),
    );
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("meetings.conference.media.readonly");

    await expect(
      resolveGoogleMeetAccessToken({
        accessToken: "cached-token",
        expiresAt: Date.now() + 120_000,
      }),
    ).resolves.toEqual({
      accessToken: "cached-token",
      expiresAt: expect.any(Number),
      refreshed: false,
    });
  });

  it("refreshes Google Meet access tokens with a refresh-token grant", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          access_token: "new-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      refreshGoogleMeetAccessToken({
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
      }),
    ).resolves.toMatchObject({
      accessToken: "new-access-token",
      tokenType: "Bearer",
    });
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const params = body as URLSearchParams;
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-token");
  });

  it("builds Twilio dial plans from a PIN", () => {
    expect(normalizeDialInNumber("+1 (555) 123-4567")).toBe("+15551234567");
    expect(buildMeetDtmfSequence({ pin: "123 456" })).toBe("123456#");
    expect(buildMeetDtmfSequence({ dtmfSequence: "ww123#" })).toBe("ww123#");
  });

  it("joins a Twilio session through the tool without page parsing", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { session: unknown } }>;
    };
    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    expect(result.details.session).toMatchObject({
      transport: "twilio",
      mode: "realtime",
      twilio: {
        dialInNumber: "+15551234567",
        pinProvided: true,
        dtmfSequence: "123456#",
        voiceCallId: "call-1",
        dtmfSent: true,
      },
    });
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith({
      config: expect.objectContaining({ defaultTransport: "twilio" }),
      dialInNumber: "+15551234567",
      dtmfSequence: "123456#",
    });
  });

  it("reports setup status through the tool", async () => {
    const { tools } = setup({
      chrome: {
        audioInputCommand: ["openclaw-audio-bridge", "capture"],
        audioOutputCommand: ["openclaw-audio-bridge", "play"],
      },
    });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { ok?: boolean } }>;
    };

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(true);
  });

  it("launches Chrome after the BlackHole check", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { methods, runCommandWithTimeout } = setup({
        defaultMode: "transcribe",
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
        1,
        ["system_profiler", "SPAudioDataType"],
        { timeoutMs: 10000 },
      );
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(
        2,
        ["open", "-a", "Google Chrome", "https://meet.google.com/abc-defg-hij"],
        { timeoutMs: 30000 },
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("runs configured Chrome audio bridge commands before launch", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { methods, runCommandWithTimeout } = setup({
        chrome: {
          audioBridgeHealthCommand: ["bridge", "status"],
          audioBridgeCommand: ["bridge", "start"],
        },
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(2, ["bridge", "status"], {
        timeoutMs: 30000,
      });
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(3, ["bridge", "start"], {
        timeoutMs: 30000,
      });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("pipes Chrome command-pair audio through the realtime provider", async () => {
    let callbacks:
      | {
          onAudio: (audio: Buffer) => void;
          onMark?: (markName: string) => void;
        }
      | undefined;
    const sendAudio = vi.fn();
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio,
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createBridge: (req) => {
        callbacks = req;
        return bridge;
      },
    };
    const inputStdout = new PassThrough();
    const outputStdinWrites: Buffer[] = [];
    const makeProcess = (stdio: {
      stdin?: { write(chunk: unknown): unknown } | null;
      stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
    }): TestBridgeProcess => {
      const proc = new EventEmitter() as unknown as TestBridgeProcess;
      proc.stdin = stdio.stdin;
      proc.stdout = stdio.stdout;
      proc.stderr = new PassThrough();
      proc.killed = false;
      proc.kill = vi.fn(() => {
        proc.killed = true;
        return true;
      });
      return proc;
    };
    const outputStdin = new Writable({
      write(chunk, _encoding, done) {
        outputStdinWrites.push(Buffer.from(chunk));
        done();
      },
    });
    const inputProcess = makeProcess({ stdout: inputStdout, stdin: null });
    const outputProcess = makeProcess({ stdin: outputStdin, stdout: null });
    const spawnMock = vi.fn().mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);

    const handle = await startCommandRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: {} as never,
      inputCommand: ["capture-meet"],
      outputCommand: ["play-meet"],
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });

    inputStdout.write(Buffer.from([1, 2, 3]));
    callbacks?.onAudio(Buffer.from([4, 5]));
    callbacks?.onMark?.("mark-1");

    expect(spawnMock).toHaveBeenNthCalledWith(1, "play-meet", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, "capture-meet", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(outputStdinWrites).toEqual([Buffer.from([4, 5])]);
    expect(bridge.acknowledgeMark).toHaveBeenCalled();

    await handle.stop();
    expect(bridge.close).toHaveBeenCalled();
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
