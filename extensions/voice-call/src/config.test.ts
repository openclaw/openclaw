import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  resolveTwilioAuthToken,
  resolveVoiceCallEffectiveConfig,
  resolveVoiceCallNumberRouteKeyForCall,
  resolveVoiceCallSessionKey,
  resolveVoiceCallStreamExposurePaths,
  validateProviderConfig,
  normalizeVoiceCallConfig,
  resolveVoiceCallConfig,
  type VoiceCallConfig,
} from "./config.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";

describe("errand features config", () => {
  it("keeps delivery, callbacks and machine detection disabled unless configured", () => {
    const config = normalizeVoiceCallConfig({});
    expect(config.reports).toEqual({ enabled: false, includeTranscript: true });
    expect(config.live).toEqual({ transcript: false, minIntervalMs: 5000 });
    expect(config.callbacks).toEqual({ enabled: false, windowMinutes: 60 });
    expect(config.voicemail).toEqual({
      detection: "off",
      onMachine: "leave-message",
      holdOpeningMaxMs: 30000,
      machineDetectionSpeechThresholdMs: 6000,
      machineDetectionSpeechEndThresholdMs: 1200,
      machineDetectionSilenceTimeoutMs: 5000,
      machineDetectionTimeoutMs: 30000,
    });
    const normalized = normalizeVoiceCallConfig({
      reports: { enabled: true },
      live: { transcript: true },
      callbacks: { enabled: true, brief: { task: "Take a message" } },
      voicemail: { detection: "twilio", holdOpeningMaxMs: 45000 },
    });
    expect(normalized).toMatchObject({
      reports: { includeTranscript: true },
      live: { minIntervalMs: 5000 },
      callbacks: { windowMinutes: 60 },
      voicemail: { onMachine: "leave-message", holdOpeningMaxMs: 45000 },
    });
    expect(() => normalizeVoiceCallConfig({ voicemail: { holdOpeningMaxMs: 0 } })).toThrow();
    expect(() => normalizeVoiceCallConfig({ callbacks: { windowMinutes: 0 } })).toThrow();
    expect(() => normalizeVoiceCallConfig({ live: { minIntervalMs: 0 } })).toThrow();
    expect(() => normalizeVoiceCallConfig({ voicemail: { detection: "unsupported" } })).toThrow();
  });

  it.each([
    ["machineDetectionSpeechThresholdMs", 1000, 6000, 1],
    ["machineDetectionSpeechEndThresholdMs", 500, 5000, 1],
    ["machineDetectionSilenceTimeoutMs", 2000, 10000, 1],
    ["machineDetectionTimeoutMs", 3000, 59000, 1000],
  ] as const)("accepts only Twilio's supported range for %s", (key, minimum, maximum, step) => {
    for (const value of [minimum, maximum]) {
      const config = normalizeVoiceCallConfig({ voicemail: { detection: "twilio", [key]: value } });
      expect(config.voicemail[key]).toBe(value);
    }
    for (const value of [minimum - step, maximum + step, minimum + 0.5]) {
      expect(() => normalizeVoiceCallConfig({ voicemail: { [key]: value } })).toThrow();
    }
    if (step > 1) {
      expect(() => normalizeVoiceCallConfig({ voicemail: { [key]: minimum + 1 } })).toThrow();
    }
  });
});

function createBaseConfig(
  provider: "telnyx" | "twilio" | "plivo" | "mock",
  overrides: Partial<VoiceCallConfig> = {},
): VoiceCallConfig {
  return { ...createVoiceCallBaseConfig({ provider }), ...overrides };
}

function sessionConfig(overrides: Record<string, unknown> = {}) {
  return normalizeVoiceCallConfig({ enabled: true, provider: "mock", ...overrides });
}

function resolveSession(
  config: VoiceCallConfig,
  options: Omit<
    Parameters<typeof resolveVoiceCallSessionKey>[0],
    "config" | "callId" | "phone"
  > = {},
) {
  return resolveVoiceCallSessionKey({
    config,
    callId: "call-123",
    phone: "+1 (555) 000-1111",
    ...options,
  });
}

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

const providerCredentials = [
  {
    provider: "twilio",
    values: { accountSid: "AC123", authToken: "secret" },
    env: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  },
  {
    provider: "telnyx",
    values: { apiKey: "KEY123", connectionId: "CONN456", publicKey: "public-key" },
    env: ["TELNYX_API_KEY", "TELNYX_CONNECTION_ID", "TELNYX_PUBLIC_KEY"],
  },
  {
    provider: "plivo",
    values: { authId: "MA123", authToken: "secret" },
    env: ["PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN"],
  },
] as const;
const providerEnv = [
  ...providerCredentials.flatMap(({ env }): readonly string[] => env),
  "TWILIO_FROM_NUMBER",
  "NGROK_AUTHTOKEN",
  "NGROK_DOMAIN",
];

describe("validateProviderConfig", () => {
  const clearProviderEnv = () => {
    for (const name of providerEnv) {
      vi.stubEnv(name, undefined);
    }
  };

  beforeEach(clearProviderEnv);
  afterEach(() => vi.unstubAllEnvs());

  it("passes validation when credentials come from config or environment", () => {
    for (const { provider, values, env } of providerCredentials) {
      clearProviderEnv();
      const fromConfig = { ...createBaseConfig(provider), [provider]: values };
      expect(validateProviderConfig(fromConfig)).toEqual({ valid: true, errors: [] });
      clearProviderEnv();
      env.forEach((name, index) => vi.stubEnv(name, Object.values(values)[index]));
      if (provider === "twilio") {
        vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001234");
      }
      const fromEnv = resolveVoiceCallConfig({
        ...createBaseConfig(provider),
        ...(provider === "twilio" ? { fromNumber: undefined } : {}),
      });
      if (provider === "twilio") {
        expect(fromEnv.fromNumber).toBe("+15550001234");
      }
      expect(validateProviderConfig(fromEnv)).toEqual({ valid: true, errors: [] });
    }
  });

  it("ignores blank provider and tunnel environment values", () => {
    for (const { provider, values, env } of providerCredentials) {
      clearProviderEnv();
      for (const name of providerEnv) {
        vi.stubEnv(name, "   ");
      }

      const config = resolveVoiceCallConfig(
        normalizeVoiceCallConfig({
          ...createBaseConfig(provider),
          fromNumber: undefined,
          tunnel: { provider: "ngrok" },
        }),
      );
      const result = validateProviderConfig(config);

      expect(result.valid).toBe(false);
      expect([config.tunnel.ngrokAuthToken, config.tunnel.ngrokDomain]).toEqual([
        undefined,
        undefined,
      ]);
      for (const key of Object.keys(values)) {
        expect(Reflect.get(config[provider] ?? {}, key)).toBeUndefined();
      }
      Object.keys(values).forEach((key, index) => {
        if (key !== "publicKey") {
          expect(result.errors).toContain(
            `plugins.entries.voice-call.config.${provider}.${key} is required (or set ${env[index]} env)`,
          );
        }
      });
      if (provider === "twilio") {
        expect(config.fromNumber).toBeUndefined();
        expect(result.errors).toContain(
          "plugins.entries.voice-call.config.fromNumber is required (or set TWILIO_FROM_NUMBER env)",
        );
      }
    }
  });
  it("accepts supported Twilio Regions and rejects unknown ones", () => {
    const withRegion = (region: string) =>
      normalizeVoiceCallConfig({
        ...createBaseConfig("twilio"),
        twilio: { accountSid: "AC123", authToken: "secret", region },
      });
    const regional = withRegion("ie1");
    expect(regional.twilio?.region).toBe("ie1");
    expect(() => withRegion("de1")).toThrow();
  });

  it("accepts SecretRef-backed auth tokens before runtime resolution", () => {
    const config = normalizeVoiceCallConfig({
      ...createBaseConfig("twilio"),
      twilio: {
        accountSid: "AC123",
        authToken: envRef("TWILIO_AUTH_TOKEN"),
      },
    });

    expect(config.twilio?.authToken).toEqual(envRef("TWILIO_AUTH_TOKEN"));
    expect(validateProviderConfig(config)).toEqual({ valid: true, errors: [] });
    expect(() => resolveTwilioAuthToken(config)).toThrow(
      'plugins.entries.voice-call.config.twilio.authToken: unresolved SecretRef "env:default:TWILIO_AUTH_TOKEN"',
    );
  });

  it("passes validation with mixed config and env vars", () => {
    process.env.TWILIO_AUTH_TOKEN = "secret";
    const config = resolveVoiceCallConfig(
      createBaseConfig("twilio", { twilio: { accountSid: "AC123" } }),
    );
    expect(validateProviderConfig(config)).toEqual({ valid: true, errors: [] });
  });
  it("requires a public key unless signature verification is skipped", () => {
    const missingPublicKey = createBaseConfig("telnyx", {
      inboundPolicy: "allowlist",
      telnyx: { apiKey: "KEY123", connectionId: "CONN456" },
    });
    const missingPublicKeyResult = validateProviderConfig(missingPublicKey);
    expect(missingPublicKeyResult.valid).toBe(false);
    expect(missingPublicKeyResult.errors).toContain(
      "plugins.entries.voice-call.config.telnyx.publicKey is required (or set TELNYX_PUBLIC_KEY env)",
    );

    const withPublicKey = {
      ...missingPublicKey,
      telnyx: { ...missingPublicKey.telnyx, publicKey: "public-key" },
    };
    expect(validateProviderConfig(withPublicKey)).toEqual({ valid: true, errors: [] });

    const skippedVerification = {
      ...missingPublicKey,
      inboundPolicy: "disabled" as const,
      skipSignatureVerification: true,
    };
    expect(validateProviderConfig(skippedVerification)).toEqual({
      valid: true,
      errors: [],
    });
  });
  it("skips validation when enabled is false", () => {
    expect(validateProviderConfig(createBaseConfig("twilio", { enabled: false }))).toEqual({
      valid: true,
      errors: [],
    });
  });
  it.each([
    [
      "disabled inbound policy for realtime mode",
      { realtime: { enabled: true }, inboundPolicy: "disabled" },
      'inboundPolicy must not be "disabled" when realtime.enabled is true',
    ],
    [
      "enabling realtime and streaming together",
      { realtime: { enabled: true }, streaming: { enabled: true }, inboundPolicy: "allowlist" },
      "realtime.enabled and plugins.entries.voice-call.config.streaming.enabled cannot both be true",
    ],
    [
      "realtime.enabled with unsupported providers",
      { provider: "plivo", realtime: { enabled: true }, inboundPolicy: "allowlist" },
      'provider must be "twilio", "telnyx", or "mock" when realtime.enabled is true',
    ],
    [
      "streaming.enabled with an unsupported provider",
      { provider: "plivo", streaming: { enabled: true } },
      'provider must be "twilio" when streaming.enabled is true',
    ],
  ] as const)("rejects %s", (_name, input, error) => {
    const config = normalizeVoiceCallConfig({ ...createBaseConfig("twilio"), ...input });
    const result = validateProviderConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`plugins.entries.voice-call.config.${error}`);
  });

  it("accepts realtime.enabled with provider=telnyx", () => {
    const config = createBaseConfig("telnyx");
    config.realtime.enabled = true;
    config.inboundPolicy = "allowlist";

    const result = validateProviderConfig(config);

    expect(result.errors).not.toContain(
      'plugins.entries.voice-call.config.provider must be "twilio", "telnyx", or "mock" when realtime.enabled is true',
    );
  });

  it("accepts realtime.enabled with provider=mock", () => {
    const config = createBaseConfig("mock");
    config.realtime.enabled = true;
    config.inboundPolicy = "allowlist";

    const result = validateProviderConfig(config);

    expect(result).toEqual({ valid: true, errors: [] });
  });
  it("accepts streaming.enabled with provider=twilio", () => {
    const config = createBaseConfig("twilio");
    config.streaming.enabled = true;
    config.twilio = {
      accountSid: "AC123",
      authToken: { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" },
    };

    expect(validateProviderConfig(config)).toEqual({ valid: true, errors: [] });
  });
});

describe("Tailscale external HTTPS port", () => {
  it.each([
    ["Serve on an arbitrary valid port", { tailscale: { mode: "serve", port: 4545 } }],
    ["legacy Funnel on 8443", { tailscale: { mode: "funnel", port: 8443 } }],
    [
      "unified Funnel on 10000",
      { tailscale: { port: 10000 }, tunnel: { provider: "tailscale-funnel" } },
    ],
  ] as const)("accepts %s", (_name, input) => {
    expect(() => normalizeVoiceCallConfig(input)).not.toThrow();
  });

  it.each([0, 1.5, 65_536])("rejects invalid HTTPS port %s", (port) => {
    expect(() => normalizeVoiceCallConfig({ tailscale: { port } })).toThrow();
  });

  it.each([
    { name: "legacy mode", input: { tailscale: { mode: "funnel", port: 4545 } } },
    {
      name: "unified provider",
      input: {
        tailscale: { port: 4545 },
        tunnel: { provider: "tailscale-funnel" },
      },
    },
  ])("rejects unsupported Funnel port for $name", ({ input }) => {
    expect.assertions(2);
    try {
      normalizeVoiceCallConfig(input);
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      if (!(error instanceof z.ZodError)) {
        throw error;
      }
      expect(error.issues).toContainEqual(
        expect.objectContaining({
          path: ["tailscale", "port"],
          message: "Tailscale Funnel HTTPS port must be one of 443, 8443, 10000",
        }),
      );
    }
  });
});

describe("resolveVoiceCallConfig session routing", () => {
  it.each([
    ["phone by default", {}, "per-phone", "call-123", "agent:main:voice:15550001111"],
    [
      "configured agent",
      { agentId: "Voice" },
      "per-phone",
      "CALL-123",
      "agent:voice:voice:15550001111",
    ],
    [
      "each call",
      { sessionScope: "per-call" },
      "per-call",
      "call-123",
      "agent:main:voice:call:call-123",
    ],
  ] as const)(
    "scopes generated voice sessions to %s",
    (_name, input, sessionScope, callId, expected) => {
      const config = normalizeVoiceCallConfig({ enabled: true, provider: "mock", ...input });
      expect(config.staleCallReaperSeconds).toBe(120);
      expect(config.responseModel).toBeUndefined();
      expect(config.sessionScope).toBe(sessionScope);
      expect(resolveVoiceCallSessionKey({ config, callId, phone: "+1 (555) 000-1111" })).toBe(
        expected,
      );
    },
  );

  it.each([
    ["the default core session", undefined, undefined, "agent:main:main"],
    ["a custom core main key", undefined, { mainKey: "work" }, "agent:main:work"],
    ["global core scope", undefined, { scope: "global" }, "global"],
    ["a configured agent", "ops", undefined, "agent:ops:main"],
  ] as const)("routes main-scoped calls to %s", (_name, agentId, coreSession, expected) => {
    const config = sessionConfig({ sessionScope: "main", agentId });
    expect(resolveSession(config, { coreSession })).toBe(expected);
  });

  it("lets an explicit session key override main scope", () => {
    const config = sessionConfig({ sessionScope: "main" });
    expect(resolveSession(config, { explicitSessionKey: "Meet-Room-1" })).toBe(
      "agent:main:meet-room-1",
    );
  });

  it("scopes persisted and explicit keys at the agent session boundary", () => {
    const config = sessionConfig({ agentId: "Voice" });
    for (const [sessionKey, expected] of [
      ["voice:call:legacy-call", "agent:voice:voice:call:legacy-call"],
      ["meet-room-1", "agent:voice:meet-room-1"],
      ["agent:main:shared-room", "agent:voice:agent:main:shared-room"],
      [
        "agent:other:Matrix:Channel:!RoomAbC:example.org",
        "agent:voice:agent:other:matrix:channel:!RoomAbC:example.org",
      ],
      [
        "agent:voice:agent:other:matrix:channel:!RoomAbC:example.org",
        "agent:voice:agent:other:matrix:channel:!RoomAbC:example.org",
      ],
      ["Signal:Group:AbC123=", "agent:voice:signal:group:AbC123="],
      ["agent:broken", "agent:voice:agent:broken"],
      ["agent::broken", "agent:voice:agent::broken"],
      [
        "agent::Matrix:Channel:!RoomAbC:example.org",
        "agent:voice:agent::matrix:channel:!RoomAbC:example.org",
      ],
      ["agent:other:room::part", "agent:voice:agent:other:room::part"],
      ["agent:voice:room::part", "agent:voice:room::part"],
      [
        "agent:voice::Matrix:Channel:!RoomAbC:example.org",
        "agent:voice:agent:voice::matrix:channel:!RoomAbC:example.org",
      ],
      ["agent:bad/id:room", "agent:voice:agent:bad/id:room"],
    ] as const) {
      expect(resolveSession(config, { explicitSessionKey: sessionKey })).toBe(expected);
    }
  });

  it("canonicalizes raw and scoped main aliases with the core session config", () => {
    const config = sessionConfig({ agentId: "Voice" });
    for (const [key, coreSession, expected] of [
      ["main", { mainKey: "work" }, "agent:voice:work"],
      ["agent:voice:main", { mainKey: "work" }, "agent:voice:work"],
      ["main", { scope: "global" }, "global"],
      ["agent:main:main", { mainKey: "work" }, "agent:voice:agent:main:main"],
      ["agent:main:main", { scope: "global" }, "agent:voice:agent:main:main"],
    ] as const) {
      expect(resolveSession(config, { explicitSessionKey: key, coreSession })).toBe(expected);
    }
  });

  it("resolves per-number inbound route overrides over global voice settings", () => {
    const config = sessionConfig({
      inboundGreeting: "Hello from global.",
      agentId: "main",
      responseModel: "openai/gpt-5.4-mini",
      responseSystemPrompt: "Global voice assistant.",
      responseTimeoutMs: 10000,
      tts: {
        provider: "openai",
        providers: {
          openai: { voice: "coral", speed: 1 },
        },
      },
      numbers: {
        "+15550001111": {
          inboundGreeting: "Silver Fox Cards, how can I help?",
          agentId: "cards",
          responseModel: "openai/gpt-5.5",
          responseSystemPrompt: "You are a baseball card expert.",
          responseTimeoutMs: 20000,
          tts: {
            providers: {
              openai: { voice: "alloy" },
            },
          },
        },
      },
    });

    const effective = resolveVoiceCallEffectiveConfig(config, "+1 (555) 000-1111");
    expect(effective).toMatchObject({
      numberRouteKey: "+15550001111",
      config: {
        inboundGreeting: "Silver Fox Cards, how can I help?",
        agentId: "cards",
        responseModel: "openai/gpt-5.5",
        responseSystemPrompt: "You are a baseball card expert.",
        responseTimeoutMs: 20000,
        tts: { provider: "openai" },
      },
    });
    expect(effective.config.tts?.providers?.openai).toEqual({ voice: "alloy", speed: 1 });
  });

  it("falls back to global voice settings when no per-number route matches", () => {
    const config = sessionConfig({
      inboundGreeting: "Hello from global.",
      numbers: {
        "+15550001111": {
          inboundGreeting: "Hello from route.",
        },
      },
    });

    const effective = resolveVoiceCallEffectiveConfig(config, "+15550002222");
    expect(effective.numberRouteKey).toBeUndefined();
    expect(effective.config).toBe(config);
    expect(effective.config.inboundGreeting).toBe("Hello from global.");
  });

  it("uses dialed-number fallback only for inbound calls", () => {
    for (const [direction, metadata, expected] of [
      ["inbound", undefined, "+15550001111"],
      ["outbound", undefined, undefined],
      ["inbound", { numberRouteKey: "+15550002222" }, "+15550002222"],
      ["outbound", { numberRouteKey: "+15550002222" }, undefined],
    ] as const) {
      expect(
        resolveVoiceCallNumberRouteKeyForCall({ direction, to: "+15550001111", metadata }),
      ).toBe(expected);
    }
  });
});

describe("normalizeVoiceCallConfig", () => {
  it("drops undefined map entries without dropping configured routes or provider secrets", () => {
    const normalized = normalizeVoiceCallConfig({
      numbers: {
        "+15550001111": { inboundGreeting: "Hello from route." },
        "+15550002222": undefined,
      },
      streaming: { providers: { absent: undefined, custom: { apiKey: "synthetic-token" } } },
      realtime: { providers: { absent: undefined, custom: { model: "test-model" } } },
    });

    expect(normalized.numbers).toEqual({
      "+15550001111": { inboundGreeting: "Hello from route." },
    });
    expect(normalized.streaming.providers).toEqual({ custom: { apiKey: "synthetic-token" } });
    expect(normalized.realtime.providers).toEqual({ custom: { model: "test-model" } });
  });

  it.each([
    { streaming: "invalid" },
    { realtime: null },
    { streaming: { providers: [] } },
    { numbers: [] },
  ])("rejects malformed config instead of replacing it with defaults: %j", (config) => {
    expect(() => normalizeVoiceCallConfig(config)).toThrow();
  });

  it("keeps default containers owned by each normalized configuration", () => {
    const first = normalizeVoiceCallConfig({});
    first.realtime.fastContext.sources.push("memory");
    first.realtime.agentContext.files.push("CUSTOM.md");
    first.webhookSecurity.allowedHosts.push("synthetic.example");
    first.streaming.providers.custom = { model: "test-model" };

    const second = normalizeVoiceCallConfig({});
    expect(second.realtime.fastContext.sources).toEqual(["memory", "sessions"]);
    expect(second.realtime.agentContext.files).toEqual(["SOUL.md", "IDENTITY.md", "USER.md"]);
    expect(second.webhookSecurity.allowedHosts).toEqual([]);
    expect(second.streaming.providers).toEqual({});
  });

  it("fills nested runtime defaults from a partial config boundary", () => {
    const normalized = sessionConfig({
      streaming: { enabled: true, streamPath: "/custom-stream" },
    });
    expect(normalized).toMatchObject({
      serve: { path: "/voice/webhook" },
      streaming: { streamPath: "/custom-stream" },
      realtime: {
        streamPath: "/voice/stream/realtime",
        toolPolicy: "safe-read-only",
        consultPolicy: "auto",
      },
      tailscale: { port: 443 },
      tunnel: { provider: "none" },
    });
    expect([
      normalized.streaming.provider,
      normalized.realtime.idleHangupMs,
      normalized.realtime.consultThinkingLevel,
      normalized.realtime.consultFastMode,
    ]).toEqual([undefined, undefined, undefined, undefined]);
    expect(normalized.streaming.providers).toStrictEqual({});
    expect(normalized.realtime.fastContext).toEqual({
      enabled: false,
      timeoutMs: 800,
      maxResults: 3,
      sources: ["memory", "sessions"],
      fallbackToConsult: false,
    });
    expect(normalized.realtime.agentContext).toEqual({
      enabled: false,
      maxChars: 6000,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      files: ["SOUL.md", "IDENTITY.md", "USER.md"],
    });
    expect(normalized.realtime.instructions).toContain("openclaw_agent_consult");
    expect(normalized.realtime.instructions).toContain("openclaw_end_call");
    expect(normalized.realtime.instructions).toContain("speak any final words first");
    expect(normalized.webhookSecurity.allowedHosts).toStrictEqual([]);
  });

  it("accepts partial nested TTS overrides and preserves nested objects", () => {
    const apiKey = { source: "env", provider: "elevenlabs", id: "ELEVENLABS_API_KEY" };
    const { tts } = normalizeVoiceCallConfig({
      tts: {
        provider: "elevenlabs",
        providers: { elevenlabs: { apiKey: { ...apiKey }, voiceSettings: { speed: 1.1 } } },
      },
    });
    expect(tts?.provider).toBe("elevenlabs");
    expect(tts?.providers?.elevenlabs).toEqual(
      expect.objectContaining({ apiKey, voiceSettings: { speed: 1.1 } }),
    );
  });
});

describe("resolveVoiceCallStreamExposurePaths", () => {
  const enabledPath = (streamPath: string) => ({ enabled: true, streamPath });
  const exposed = (localPath: string, publicPath = localPath) => ({ localPath, publicPath });
  it.each([
    ["returns no paths when both audio modes are disabled", {}, []],
    [
      "derives the default realtime path from the webhook path",
      { serve: { path: "/custom/webhook" }, realtime: { enabled: true } },
      [exposed("/custom/stream/realtime")],
    ],
    [
      "normalizes explicit realtime and streaming paths",
      { realtime: enabledPath("custom/realtime"), streaming: enabledPath("custom/stream") },
      [exposed("/custom/realtime"), exposed("/custom/stream")],
    ],
    [
      "deduplicates equal realtime and streaming paths",
      { realtime: enabledPath("/voice/stream"), streaming: enabledPath("/voice/stream") },
      [exposed("/voice/stream")],
    ],
    [
      "maps stream paths through a distinct public Tailscale prefix",
      {
        serve: { path: "/voice/webhook" },
        tailscale: { path: "/edge/voice/webhook" },
        realtime: { enabled: true },
        streaming: enabledPath("/voice/stream"),
      },
      [exposed("/voice/stream/realtime", "/edge/voice/stream/realtime"), exposed("/voice/stream")],
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(resolveVoiceCallStreamExposurePaths(normalizeVoiceCallConfig(input))).toEqual(expected);
  });
});

describe("resolveVoiceCallConfig realtime settings", () => {
  const realtimeConfig = (realtime: Record<string, unknown>, provider = "mock") =>
    normalizeVoiceCallConfig({ enabled: true, provider, realtime });

  it("preserves configured realtime instructions without env indirection", () => {
    const { realtime } = realtimeConfig({ enabled: true, instructions: "Stay concise." }, "twilio");
    expect(realtime).toMatchObject({
      instructions: "Stay concise.",
      toolPolicy: "safe-read-only",
      consultPolicy: "auto",
    });
    expect(realtime.provider).toBeUndefined();
  });

  it("preserves configured realtime consult overrides", () => {
    expect(
      realtimeConfig({ consultThinkingLevel: "ultra", consultFastMode: true }).realtime,
    ).toMatchObject({
      consultThinkingLevel: "ultra",
      consultFastMode: true,
    });
  });

  it("accepts only positive integer realtime idle hangup values", () => {
    const parsed = realtimeConfig({ idleHangupMs: 45_000 });
    expect(resolveVoiceCallConfig(parsed).realtime.idleHangupMs).toBe(45_000);
    expect(() => realtimeConfig({ idleHangupMs: 0 })).toThrow();
  });

  it("rejects invalid realtime consult thinking levels", () => {
    expect(() => realtimeConfig({ consultThinkingLevel: "turbo" })).toThrow(/Invalid option/);
  });
});
