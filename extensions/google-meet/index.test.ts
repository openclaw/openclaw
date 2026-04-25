import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { Command } from "commander";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { registerGoogleMeetCli } from "./src/cli.js";
import { resolveGoogleMeetConfig, resolveGoogleMeetConfigWithEnv } from "./src/config.js";
import {
  buildGoogleMeetPreflightReport,
  createGoogleMeetSpace,
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
  fetchGoogleMeetSpace,
  normalizeGoogleMeetSpaceName,
} from "./src/meet.js";
import {
  buildGoogleMeetAuthUrl,
  refreshGoogleMeetAccessToken,
  resolveGoogleMeetAccessToken,
} from "./src/oauth.js";
import { startNodeRealtimeAudioBridge } from "./src/realtime-node.js";
import { startCommandRealtimeAudioBridge } from "./src/realtime.js";
import { normalizeMeetUrl } from "./src/runtime.js";
import type { GoogleMeetRuntime } from "./src/runtime.js";
import {
  captureStdout,
  noopLogger,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import { buildMeetDtmfSequence, normalizeDialInNumber } from "./src/transports/twilio.js";

const voiceCallMocks = vi.hoisted(() => ({
  joinMeetViaVoiceCallGateway: vi.fn(async () => ({ callId: "call-1", dtmfSent: true })),
  endMeetVoiceCallGatewayCall: vi.fn(async () => {}),
}));

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
    }): Promise<{
      response: Response;
      release: () => Promise<void>;
    }> => ({
      response: await fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
}));

vi.mock("./src/voice-call-gateway.js", () => ({
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
  endMeetVoiceCallGatewayCall: voiceCallMocks.endMeetVoiceCallGatewayCall,
}));

function setup(
  config?: Parameters<typeof setupGoogleMeetPlugin>[1],
  options?: Parameters<typeof setupGoogleMeetPlugin>[2],
) {
  return setupGoogleMeetPlugin(plugin, config, options);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

function stubMeetArtifactsApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.pathname === "/v2/spaces/abc-defg-hij") {
      return jsonResponse({
        name: "spaces/abc-defg-hij",
        meetingCode: "abc-defg-hij",
        meetingUri: "https://meet.google.com/abc-defg-hij",
      });
    }
    if (url.pathname === "/v2/conferenceRecords") {
      return jsonResponse({
        conferenceRecords: [
          {
            name: "conferenceRecords/rec-1",
            space: "spaces/abc-defg-hij",
            startTime: "2026-04-25T10:00:00Z",
            endTime: "2026-04-25T10:30:00Z",
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1") {
      return jsonResponse({
        name: "conferenceRecords/rec-1",
        space: "spaces/abc-defg-hij",
        startTime: "2026-04-25T10:00:00Z",
        endTime: "2026-04-25T10:30:00Z",
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1/participants") {
      return jsonResponse({
        participants: [
          {
            name: "conferenceRecords/rec-1/participants/p1",
            earliestStartTime: "2026-04-25T10:00:00Z",
            latestEndTime: "2026-04-25T10:30:00Z",
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
            startTime: "2026-04-25T10:00:00Z",
            endTime: "2026-04-25T10:30:00Z",
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1/recordings") {
      return jsonResponse({
        recordings: [
          {
            name: "conferenceRecords/rec-1/recordings/r1",
            driveDestination: { file: "drive/file-1" },
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1/transcripts") {
      return jsonResponse({
        transcripts: [
          {
            name: "conferenceRecords/rec-1/transcripts/t1",
            docsDestination: { document: "docs/doc-1" },
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1/smartNotes") {
      return jsonResponse({
        smartNotes: [
          {
            name: "conferenceRecords/rec-1/smartNotes/sn1",
            docsDestination: { document: "docs/doc-2" },
          },
        ],
      });
    }
    return new Response(`unexpected ${url.pathname}`, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type TestBridgeProcess = {
  stdin?: { write(chunk: unknown): unknown } | null;
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr: PassThrough;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  on: EventEmitter["on"];
};

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
      chrome: {
        audioBackend: "blackhole-2ch",
        launch: true,
        guestName: "OpenClaw Agent",
        reuseExistingTab: true,
        autoJoin: true,
        waitForInCallMs: 20000,
        audioInputCommand: [
          "rec",
          "-q",
          "-t",
          "raw",
          "-r",
          "8000",
          "-c",
          "1",
          "-e",
          "mu-law",
          "-b",
          "8",
          "-",
        ],
        audioOutputCommand: [
          "play",
          "-q",
          "-t",
          "raw",
          "-r",
          "8000",
          "-c",
          "1",
          "-e",
          "mu-law",
          "-b",
          "8",
          "-",
        ],
      },
      voiceCall: { enabled: true, requestTimeoutMs: 30000, dtmfDelayMs: 2500 },
      realtime: {
        provider: "openai",
        introMessage: "Say exactly: I'm here and listening.",
        toolPolicy: "safe-read-only",
      },
      oauth: {},
      auth: { provider: "google-oauth" },
    });
    expect(resolveGoogleMeetConfig({}).realtime.instructions).toContain("openclaw_agent_consult");
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

  it("registers the node-host command used by chrome-node transport", () => {
    const { nodeHostCommands } = setup();

    expect(nodeHostCommands).toContainEqual(
      expect.objectContaining({
        command: "googlemeet.chrome",
        cap: "google-meet",
        handle: expect.any(Function),
      }),
    );
  });

  it("uses a provider-safe flat tool parameter schema", () => {
    const { tools } = setup();
    const tool = tools[0] as { description?: string; parameters: unknown };

    expect(tool.description).toContain("recover_current_tab");
    expect(JSON.stringify(tool.parameters)).not.toContain("anyOf");
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "join",
            "create",
            "status",
            "setup_status",
            "resolve_space",
            "preflight",
            "artifacts",
            "attendance",
            "recover_current_tab",
            "leave",
            "speak",
            "test_speech",
          ],
          description: expect.stringContaining("recover_current_tab"),
        },
        transport: { type: "string", enum: ["chrome", "chrome-node", "twilio"] },
        mode: { type: "string", enum: ["realtime", "transcribe"] },
      },
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
    expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
        init: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer token" }),
        }),
        policy: { allowedHostnames: ["meet.googleapis.com"] },
        auditContext: "google-meet.spaces.get",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
  });

  it("creates Meet spaces and returns the meeting URL", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          name: "spaces/new-space",
          meetingCode: "new-abcd-xyz",
          meetingUri: "https://meet.google.com/new-abcd-xyz",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createGoogleMeetSpace({ accessToken: "token" })).resolves.toMatchObject({
      meetingUri: "https://meet.google.com/new-abcd-xyz",
      space: { name: "spaces/new-space" },
    });
    expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://meet.googleapis.com/v2/spaces",
        init: expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer token" }),
          body: "{}",
        }),
        policy: { allowedHostnames: ["meet.googleapis.com"] },
        auditContext: "google-meet.spaces.create",
      }),
    );
  });

  it("lists Meet artifact metadata for conference records", async () => {
    const fetchMock = stubMeetArtifactsApi();

    await expect(
      fetchGoogleMeetArtifacts({
        accessToken: "token",
        meeting: "abc-defg-hij",
        pageSize: 2,
      }),
    ).resolves.toMatchObject({
      input: "abc-defg-hij",
      space: { name: "spaces/abc-defg-hij" },
      conferenceRecords: [{ name: "conferenceRecords/rec-1" }],
      artifacts: [
        {
          conferenceRecord: { name: "conferenceRecords/rec-1" },
          participants: [{ name: "conferenceRecords/rec-1/participants/p1" }],
          recordings: [{ name: "conferenceRecords/rec-1/recordings/r1" }],
          transcripts: [{ name: "conferenceRecords/rec-1/transcripts/t1" }],
          smartNotes: [{ name: "conferenceRecords/rec-1/smartNotes/sn1" }],
        },
      ],
    });

    const listCall = fetchMock.mock.calls.find(([input]) => {
      const url = requestUrl(input);
      return url.pathname === "/v2/conferenceRecords";
    });
    if (!listCall) {
      throw new Error("Expected conferenceRecords.list fetch call");
    }
    const listUrl = requestUrl(listCall[0]);
    expect(listUrl.searchParams.get("filter")).toBe('space.name = "spaces/abc-defg-hij"');
    expect(listUrl.searchParams.get("pageSize")).toBe("2");
    expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://meet.googleapis.com/v2/conferenceRecords/rec-1/smartNotes?pageSize=2",
        auditContext: "google-meet.conferenceRecords.smartNotes.list",
      }),
    );
  });

  it("lists Meet attendance rows with participant sessions", async () => {
    const fetchMock = stubMeetArtifactsApi();

    await expect(
      fetchGoogleMeetAttendance({
        accessToken: "token",
        conferenceRecord: "rec-1",
        pageSize: 3,
      }),
    ).resolves.toMatchObject({
      input: "rec-1",
      conferenceRecords: [{ name: "conferenceRecords/rec-1" }],
      attendance: [
        {
          conferenceRecord: "conferenceRecords/rec-1",
          participant: "conferenceRecords/rec-1/participants/p1",
          displayName: "Alice",
          user: "users/alice",
          sessions: [
            {
              name: "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
            },
          ],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://meet.googleapis.com/v2/conferenceRecords/rec-1",
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
    expect(url.searchParams.get("scope")).toContain("meetings.space.created");
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

  it("hangs up delegated Twilio calls on leave", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { session: { id: string } } }>;
    };
    const joined = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    await tool.execute("id", { action: "leave", sessionId: joined.details.session.id });

    expect(voiceCallMocks.endMeetVoiceCallGatewayCall).toHaveBeenCalledWith({
      config: expect.objectContaining({ defaultTransport: "twilio" }),
      callId: "call-1",
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

  it("reports attendance through the tool", async () => {
    stubMeetArtifactsApi();
    const { tools } = setup();
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { attendance?: Array<{ displayName?: string }> } }>;
    };

    const result = await tool.execute("id", {
      action: "attendance",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      conferenceRecord: "rec-1",
      pageSize: 3,
    });

    expect(result.details.attendance).toEqual([expect.objectContaining({ displayName: "Alice" })]);
  });

  it("fails setup status when the configured Chrome node is not connected", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      { nodesListResult: { nodes: [] } },
    );
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
    };

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(false);
    expect(result.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "chrome-node-connected",
          ok: false,
          message: expect.stringContaining("No connected Google Meet-capable node"),
        }),
      ]),
    );
  });

  it("reports Twilio delegation readiness when voice-call is enabled", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secret");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001234");
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        fullConfig: {
          plugins: {
            allow: ["google-meet", "voice-call"],
            entries: {
              "voice-call": {
                enabled: true,
                config: { provider: "twilio" },
              },
            },
          },
        },
      },
    );
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
    };

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(true);
    expect(result.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "twilio-voice-call-plugin",
          ok: true,
        }),
        expect.objectContaining({
          id: "twilio-voice-call-credentials",
          ok: true,
        }),
      ]),
    );
  });

  it("reports missing voice-call wiring for Twilio transport", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_FROM_NUMBER", "");
    const { tools } = setup(
      { defaultTransport: "twilio" },
      {
        fullConfig: {
          plugins: {
            allow: ["google-meet"],
            entries: {
              "voice-call": { enabled: false },
            },
          },
        },
      },
    );
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
    };

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(false);
    expect(result.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "twilio-voice-call-plugin",
          ok: false,
        }),
        expect.objectContaining({
          id: "twilio-voice-call-credentials",
          ok: false,
        }),
      ]),
    );
  });

  it("CLI setup prints human-readable checks by default", async () => {
    const program = new Command();
    const stdout = captureStdout();
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({}),
      ensureRuntime: async () =>
        ({
          setupStatus: async () => ({
            ok: true,
            checks: [
              {
                id: "audio-bridge",
                ok: true,
                message: "Chrome command-pair realtime audio bridge configured",
              },
            ],
          }),
        }) as unknown as GoogleMeetRuntime,
    });

    try {
      await program.parseAsync(["googlemeet", "setup"], { from: "user" });
      expect(stdout.output()).toContain("Google Meet setup: OK");
      expect(stdout.output()).toContain(
        "[ok] audio-bridge: Chrome command-pair realtime audio bridge configured",
      );
      expect(stdout.output()).not.toContain('"checks"');
    } finally {
      stdout.restore();
    }
  });

  it("CLI setup preserves JSON output with --json", async () => {
    const program = new Command();
    const stdout = captureStdout();
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({}),
      ensureRuntime: async () =>
        ({
          setupStatus: async () => ({
            ok: false,
            checks: [{ id: "twilio-voice-call-plugin", ok: false, message: "missing" }],
          }),
        }) as unknown as GoogleMeetRuntime,
    });

    try {
      await program.parseAsync(["googlemeet", "setup", "--json"], { from: "user" });
      expect(JSON.parse(stdout.output())).toMatchObject({
        ok: false,
        checks: [{ id: "twilio-voice-call-plugin", ok: false }],
      });
    } finally {
      stdout.restore();
    }
  });

  it("CLI artifacts prints JSON output", async () => {
    stubMeetArtifactsApi();
    const program = new Command();
    const stdout = captureStdout();
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({}),
      ensureRuntime: async () => ({}) as unknown as GoogleMeetRuntime,
    });

    try {
      await program.parseAsync(
        [
          "googlemeet",
          "artifacts",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
          "--json",
        ],
        { from: "user" },
      );
      expect(JSON.parse(stdout.output())).toMatchObject({
        conferenceRecords: [{ name: "conferenceRecords/rec-1" }],
        artifacts: [
          {
            recordings: [{ name: "conferenceRecords/rec-1/recordings/r1" }],
            transcripts: [{ name: "conferenceRecords/rec-1/transcripts/t1" }],
            smartNotes: [{ name: "conferenceRecords/rec-1/smartNotes/sn1" }],
          },
        ],
        tokenSource: "cached-access-token",
      });
    } finally {
      stdout.restore();
    }
  });

  it("CLI attendance prints participant sessions by default", async () => {
    stubMeetArtifactsApi();
    const program = new Command();
    const stdout = captureStdout();
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({}),
      ensureRuntime: async () => ({}) as unknown as GoogleMeetRuntime,
    });

    try {
      await program.parseAsync(
        [
          "googlemeet",
          "attendance",
          "--access-token",
          "token",
          "--expires-at",
          String(Date.now() + 120_000),
          "--conference-record",
          "rec-1",
        ],
        { from: "user" },
      );
      expect(stdout.output()).toContain("attendance rows: 1");
      expect(stdout.output()).toContain("participant: Alice");
      expect(stdout.output()).toContain(
        "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
      );
    } finally {
      stdout.restore();
    }
  });

  it("CLI doctor prints human-readable session health", async () => {
    const program = new Command();
    const stdout = captureStdout();
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({}),
      ensureRuntime: async () =>
        ({
          status: () => ({
            found: true,
            session: {
              id: "meet_1",
              url: "https://meet.google.com/abc-defg-hij",
              state: "active",
              transport: "chrome-node",
              mode: "realtime",
              participantIdentity: "signed-in Google Chrome profile on a paired node",
              createdAt: "2026-04-25T00:00:00.000Z",
              updatedAt: "2026-04-25T00:00:01.000Z",
              realtime: { enabled: true, provider: "openai", toolPolicy: "safe-read-only" },
              chrome: {
                audioBackend: "blackhole-2ch",
                launched: true,
                nodeId: "node-1",
                audioBridge: { type: "node-command-pair", provider: "openai" },
                health: {
                  inCall: true,
                  providerConnected: true,
                  realtimeReady: true,
                  audioInputActive: true,
                  audioOutputActive: false,
                  lastInputAt: "2026-04-25T00:00:02.000Z",
                  lastInputBytes: 160,
                  lastOutputBytes: 0,
                },
              },
              notes: [],
            },
          }),
        }) as unknown as GoogleMeetRuntime,
    });

    try {
      await program.parseAsync(["googlemeet", "doctor", "meet_1"], { from: "user" });
      expect(stdout.output()).toContain("session: meet_1");
      expect(stdout.output()).toContain("node: node-1");
      expect(stdout.output()).toContain("provider connected: yes");
      expect(stdout.output()).toContain("audio input active: yes");
      expect(stdout.output()).toContain("audio output active: no");
    } finally {
      stdout.restore();
    }
  });

  it("CLI doctor verifies Google Meet OAuth refresh without printing secrets", async () => {
    const program = new Command();
    const stdout = captureStdout();
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

    const ensureRuntime = vi.fn(async () => {
      throw new Error("runtime should not be loaded for OAuth doctor");
    });
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          refreshToken: "rt-secret",
        },
      }),
      ensureRuntime: ensureRuntime as unknown as () => Promise<GoogleMeetRuntime>,
    });

    try {
      await program.parseAsync(["googlemeet", "doctor", "--oauth", "--json"], { from: "user" });
      const output = stdout.output();
      expect(output).not.toContain("new-access-token");
      expect(output).not.toContain("rt-secret");
      expect(output).not.toContain("client-secret");
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        configured: true,
        tokenSource: "refresh-token",
        checks: [
          { id: "oauth-config", ok: true },
          { id: "oauth-token", ok: true },
        ],
      });
      expect(ensureRuntime).not.toHaveBeenCalled();
      const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
    } finally {
      stdout.restore();
    }
  });

  it("CLI doctor can prove Google Meet API create access", async () => {
    const program = new Command();
    const stdout = captureStdout();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({
              access_token: "new-access-token",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === "https://meet.googleapis.com/v2/spaces") {
          return new Response(
            JSON.stringify({
              name: "spaces/new-space",
              meetingUri: "https://meet.google.com/new-abcd-xyz",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({
        oauth: {
          clientId: "client-id",
          refreshToken: "refresh-token",
        },
      }),
      ensureRuntime: async () => ({}) as GoogleMeetRuntime,
    });

    try {
      await program.parseAsync(["googlemeet", "doctor", "--oauth", "--create-space", "--json"], {
        from: "user",
      });
      expect(JSON.parse(stdout.output())).toMatchObject({
        ok: true,
        tokenSource: "refresh-token",
        createdSpace: "spaces/new-space",
        meetingUri: "https://meet.google.com/new-abcd-xyz",
        checks: [
          { id: "oauth-config", ok: true },
          { id: "oauth-token", ok: true },
          { id: "meet-spaces-create", ok: true },
        ],
      });
    } finally {
      stdout.restore();
    }
  });

  it("CLI recover-tab focuses and summarizes an existing Meet tab", async () => {
    const program = new Command();
    const stdout = captureStdout();
    registerGoogleMeetCli({
      program,
      config: resolveGoogleMeetConfig({ defaultTransport: "chrome-node" }),
      ensureRuntime: async () =>
        ({
          recoverCurrentTab: async () => ({
            nodeId: "node-1",
            found: true,
            targetId: "tab-1",
            tab: { targetId: "tab-1", url: "https://meet.google.com/abc-defg-hij" },
            browser: {
              inCall: false,
              manualActionRequired: true,
              manualActionReason: "meet-admission-required",
              manualActionMessage: "Admit the OpenClaw browser participant in Google Meet.",
              browserUrl: "https://meet.google.com/abc-defg-hij",
            },
            message: "Admit the OpenClaw browser participant in Google Meet.",
          }),
        }) as unknown as GoogleMeetRuntime,
    });

    try {
      await program.parseAsync(["googlemeet", "recover-tab"], { from: "user" });
      expect(stdout.output()).toContain("Google Meet current tab: found");
      expect(stdout.output()).toContain("target: tab-1");
      expect(stdout.output()).toContain("manual reason: meet-admission-required");
    } finally {
      stdout.restore();
    }
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
        ["/usr/sbin/system_profiler", "SPAudioDataType"],
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

  it("joins Chrome on a paired node without local Chrome or BlackHole", async () => {
    const { methods, nodesList, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeResult: { payload: { launched: true } },
      },
    );
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
    expect(nodesList).toHaveBeenCalledWith({ connected: true });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        command: "browser.proxy",
        params: expect.objectContaining({
          path: "/tabs/open",
          body: { url: "https://meet.google.com/abc-defg-hij" },
        }),
      }),
    );
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        command: "googlemeet.chrome",
        params: expect.objectContaining({
          action: "start",
          url: "https://meet.google.com/abc-defg-hij",
          mode: "transcribe",
          launch: false,
        }),
      }),
    );
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      session: {
        transport: "chrome-node",
        chrome: {
          nodeId: "node-1",
          launched: true,
        },
      },
    });
  });

  it("reuses an active Meet session for the same URL and transport", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesInvokeResult: {
          payload: {
            launched: true,
            browser: { inCall: true, micMuted: false },
          },
        },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const first = vi.fn();
    const second = vi.fn();

    await handler?.({
      params: { url: "https://meet.google.com/abc-defg-hij" },
      respond: first,
    });
    await handler?.({
      params: { url: "https://meet.google.com/abc-defg-hij" },
      respond: second,
    });

    expect(
      nodesInvoke.mock.calls.filter(([call]) => call.command === "googlemeet.chrome"),
    ).toHaveLength(1);
    expect(second.mock.calls[0]?.[1]).toMatchObject({
      session: {
        chrome: { health: { inCall: true, micMuted: false } },
        notes: expect.arrayContaining(["Reused existing active Meet session."]),
      },
    });
  });

  it("reuses active Meet sessions across URL query differences", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesInvokeResult: {
          payload: {
            launched: true,
            browser: { inCall: true, micMuted: false },
          },
        },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const first = vi.fn();
    const second = vi.fn();

    await handler?.({
      params: { url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com" },
      respond: first,
    });
    await handler?.({
      params: { url: "https://meet.google.com/abc-defg-hij" },
      respond: second,
    });

    expect(
      nodesInvoke.mock.calls.filter(([call]) => call.command === "googlemeet.chrome"),
    ).toHaveLength(1);
    expect(second.mock.calls[0]?.[1]).toMatchObject({
      session: {
        notes: expect.arrayContaining(["Reused existing active Meet session."]),
      },
    });
  });

  it("reuses existing Meet browser tabs across URL query differences", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesInvokeHandler: async (params) => {
          if (params.command !== "browser.proxy") {
            return { payload: { launched: true } };
          }
          const proxy = params.params as {
            path?: string;
            body?: { targetId?: string; url?: string };
          };
          if (proxy.path === "/tabs") {
            return {
              payload: {
                result: {
                  running: true,
                  tabs: [
                    {
                      targetId: "existing-meet-tab",
                      title: "Meet",
                      url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
                    },
                  ],
                },
              },
            };
          }
          if (proxy.path === "/tabs/focus") {
            return { payload: { result: { ok: true } } };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  result: JSON.stringify({
                    inCall: true,
                    title: "Meet",
                    url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
                  }),
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
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

    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          path: "/tabs/focus",
          body: { targetId: "existing-meet-tab" },
        }),
      }),
    );
    expect(nodesInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ path: "/tabs/open" }),
      }),
    );
  });

  it("recovers and inspects an existing Meet tab without opening a new one", async () => {
    const { tools, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
      },
      {
        nodesInvokeHandler: async (params) => {
          if (params.command !== "browser.proxy") {
            throw new Error(`unexpected command ${params.command}`);
          }
          const proxy = params.params as { path?: string; body?: { targetId?: string } };
          if (proxy.path === "/tabs") {
            return {
              payload: {
                result: {
                  tabs: [
                    {
                      targetId: "existing-meet-tab",
                      title: "Meet",
                      url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
                    },
                  ],
                },
              },
            };
          }
          if (proxy.path === "/tabs/focus") {
            return { payload: { result: { ok: true } } };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  result: JSON.stringify({
                    inCall: false,
                    manualActionRequired: true,
                    manualActionReason: "meet-admission-required",
                    manualActionMessage: "Admit the OpenClaw browser participant in Google Meet.",
                    title: "Meet",
                    url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
                  }),
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { found?: boolean; browser?: unknown } }>;
    };

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details).toMatchObject({
      found: true,
      targetId: "existing-meet-tab",
      browser: {
        manualActionRequired: true,
        manualActionReason: "meet-admission-required",
      },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          path: "/tabs/focus",
          body: { targetId: "existing-meet-tab" },
        }),
      }),
    );
    expect(nodesInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ path: "/tabs/open" }),
      }),
    );
  });

  it("exposes a test-speech action that joins the requested meeting", async () => {
    const { tools, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
      },
      {
        nodesInvokeResult: {
          payload: {
            launched: true,
            browser: { inCall: true },
          },
        },
      },
    );
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { createdSession?: boolean } }>;
    };

    const result = await tool.execute("id", {
      action: "test_speech",
      url: "https://meet.google.com/abc-defg-hij",
      message: "Say exactly: hello.",
    });

    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "googlemeet.chrome",
        params: expect.objectContaining({ action: "start" }),
      }),
    );
    expect(result.details).toMatchObject({ createdSession: true });
  });

  it("reports manual action when the browser profile needs Google login", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
      },
      {
        browserActResult: {
          inCall: false,
          manualActionRequired: true,
          manualActionReason: "google-login-required",
          manualActionMessage:
            "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.",
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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{
        details: {
          manualActionRequired?: boolean;
          manualActionReason?: string;
          session?: { chrome?: { health?: { manualActionRequired?: boolean } } };
        };
      }>;
    };

    const result = await tool.execute("id", {
      action: "test_speech",
      url: "https://meet.google.com/abc-defg-hij",
      message: "Say exactly: hello.",
    });

    expect(result.details).toMatchObject({
      manualActionRequired: true,
      manualActionReason: "google-login-required",
      session: {
        chrome: {
          health: {
            manualActionRequired: true,
            manualActionReason: "google-login-required",
          },
        },
      },
    });
  });

  it("explains when chrome-node has no capable paired node", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesListResult: { nodes: [] },
      },
    );
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { error?: string } }>;
    };

    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details.error).toContain("No connected Google Meet-capable node");
    expect(result.details.error).toContain("openclaw node run");
  });

  it("requires chromeNode.node when multiple capable nodes are connected", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesListResult: {
          nodes: [
            {
              nodeId: "node-1",
              displayName: "parallels-macos",
              connected: true,
              caps: ["browser"],
              commands: ["browser.proxy", "googlemeet.chrome"],
            },
            {
              nodeId: "node-2",
              displayName: "mac-studio-vm",
              connected: true,
              caps: ["browser"],
              commands: ["browser.proxy", "googlemeet.chrome"],
            },
          ],
        },
      },
    );
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { error?: string } }>;
    };

    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details.error).toContain("Multiple Google Meet-capable nodes connected");
    expect(result.details.error).toContain("chromeNode.node");
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
          onToolCall?: (event: {
            itemId: string;
            callId: string;
            name: string;
            args: unknown;
          }) => void;
          onReady?: () => void;
          tools?: unknown[];
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
      triggerGreeting: vi.fn(),
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
    const sessionStore: Record<string, unknown> = {};
    const runtime = {
      agent: {
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          loadSessionStore: vi.fn(() => sessionStore),
          saveSessionStore: vi.fn(async () => {}),
          resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
        },
        runEmbeddedPiAgent: vi.fn(async () => ({
          payloads: [{ text: "Use the Portugal launch data." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startCommandRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: {} as never,
      runtime: runtime as never,
      meetingSessionId: "meet-1",
      inputCommand: ["capture-meet"],
      outputCommand: ["play-meet"],
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });

    inputStdout.write(Buffer.from([1, 2, 3]));
    callbacks?.onAudio(Buffer.from([4, 5]));
    callbacks?.onMark?.("mark-1");
    callbacks?.onReady?.();
    callbacks?.onToolCall?.({
      itemId: "item-1",
      callId: "tool-call-1",
      name: "openclaw_agent_consult",
      args: { question: "What should I say about launch timing?" },
    });

    expect(spawnMock).toHaveBeenNthCalledWith(1, "play-meet", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, "capture-meet", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(outputStdinWrites).toEqual([Buffer.from([4, 5])]);
    expect(bridge.acknowledgeMark).toHaveBeenCalled();
    expect(bridge.triggerGreeting).not.toHaveBeenCalled();
    handle.speak("Say exactly: hello from the meeting.");
    expect(bridge.triggerGreeting).toHaveBeenLastCalledWith("Say exactly: hello from the meeting.");
    expect(handle.getHealth()).toMatchObject({
      providerConnected: true,
      realtimeReady: true,
      audioInputActive: true,
      audioOutputActive: true,
      lastInputBytes: 3,
      lastOutputBytes: 2,
    });
    expect(callbacks).toMatchObject({
      tools: [
        expect.objectContaining({
          name: "openclaw_agent_consult",
        }),
      ],
    });
    await vi.waitFor(() => {
      expect(bridge.submitToolResult).toHaveBeenCalledWith("tool-call-1", {
        text: "Use the Portugal launch data.",
      });
    });
    expect(runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageProvider: "google-meet",
        thinkLevel: "high",
        toolsAllow: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
      }),
    );

    await handle.stop();
    expect(bridge.close).toHaveBeenCalled();
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("pipes paired-node command-pair audio through the realtime provider", async () => {
    let callbacks:
      | {
          onAudio: (audio: Buffer) => void;
          onToolCall?: (event: {
            itemId: string;
            callId: string;
            name: string;
            args: unknown;
          }) => void;
          onReady?: () => void;
          tools?: unknown[];
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
      triggerGreeting: vi.fn(),
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
    let pullCount = 0;
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string; base64?: string } }) => {
          if (params?.action === "pullAudio") {
            pullCount += 1;
            if (pullCount === 1) {
              return { bridgeId: "bridge-1", base64: Buffer.from([9, 8, 7]).toString("base64") };
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            return { bridgeId: "bridge-1" };
          }
          return { ok: true };
        }),
      },
      agent: {
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          loadSessionStore: vi.fn(() => ({})),
          saveSessionStore: vi.fn(async () => {}),
          resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
        },
        runEmbeddedPiAgent: vi.fn(async () => ({
          payloads: [{ text: "Use the launch update." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startNodeRealtimeAudioBridge({
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

    callbacks?.onAudio(Buffer.from([1, 2, 3]));
    callbacks?.onReady?.();
    callbacks?.onToolCall?.({
      itemId: "item-1",
      callId: "tool-call-1",
      name: "openclaw_agent_consult",
      args: { question: "What should I say?" },
    });

    await vi.waitFor(() => {
      expect(sendAudio).toHaveBeenCalledWith(Buffer.from([9, 8, 7]));
    });
    await vi.waitFor(() => {
      expect(runtime.nodes.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "node-1",
          command: "googlemeet.chrome",
          params: expect.objectContaining({
            action: "pushAudio",
            bridgeId: "bridge-1",
            base64: Buffer.from([1, 2, 3]).toString("base64"),
          }),
        }),
      );
    });
    await vi.waitFor(() => {
      expect(bridge.submitToolResult).toHaveBeenCalledWith("tool-call-1", {
        text: "Use the launch update.",
      });
    });
    expect(bridge.triggerGreeting).not.toHaveBeenCalled();
    handle.speak("Say exactly: hello from the node.");
    expect(bridge.triggerGreeting).toHaveBeenLastCalledWith("Say exactly: hello from the node.");
    expect(callbacks).toMatchObject({
      tools: [
        expect.objectContaining({
          name: "openclaw_agent_consult",
        }),
      ],
    });
    expect(handle).toMatchObject({
      type: "node-command-pair",
      providerId: "openai",
      nodeId: "node-1",
      bridgeId: "bridge-1",
    });
    expect(handle.getHealth()).toMatchObject({
      providerConnected: true,
      realtimeReady: true,
      audioInputActive: true,
      audioOutputActive: true,
      lastInputBytes: 3,
      lastOutputBytes: 3,
    });

    await handle.stop();

    expect(bridge.close).toHaveBeenCalled();
    expect(runtime.nodes.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        command: "googlemeet.chrome",
        params: { action: "stop", bridgeId: "bridge-1" },
        timeoutMs: 5_000,
      }),
    );
  });
});
