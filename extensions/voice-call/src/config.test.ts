import { readFileSync } from "node:fs";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import setup from "../setup-api.js";
import { migrateVoiceCallLegacyConfigInput } from "./config-migration.js";
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
    expect(config.voicemail).toMatchObject({
      detection: "off",
      onMachine: "leave-message",
      holdOpeningMaxMs: 30000,
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
  options: Partial<Omit<Parameters<typeof resolveVoiceCallSessionKey>[0], "config">> = {},
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
const valid = { valid: true, errors: [] };
const errorPrefix = "plugins.entries.voice-call.config.";

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
      fromConfig.realtime.enabled = provider !== "plivo";
      fromConfig.inboundPolicy = "allowlist";
      expect(validateProviderConfig(fromConfig)).toEqual(valid);
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
      expect(validateProviderConfig(fromEnv)).toEqual(valid);
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
            `${errorPrefix}${provider}.${key} is required (or set ${env[index]} env)`,
          );
        }
      });
      if (provider === "twilio") {
        expect(config.fromNumber).toBeUndefined();
        expect(result.errors).toContain(
          `${errorPrefix}fromNumber is required (or set TWILIO_FROM_NUMBER env)`,
        );
      }
    }
  });
  it("accepts supported Twilio Regions and rejects unknown ones", () => {
    expect(normalizeVoiceCallConfig({ twilio: { region: "ie1" } }).twilio?.region).toBe("ie1");
    expect(() => normalizeVoiceCallConfig({ twilio: { region: "de1" } })).toThrow();
  });

  it("accepts SecretRef-backed auth tokens before runtime resolution", () => {
    const config = normalizeVoiceCallConfig({
      ...createBaseConfig("twilio"),
      twilio: { accountSid: "AC123", authToken: envRef("TWILIO_AUTH_TOKEN") },
    });

    expect(config.twilio?.authToken).toEqual(envRef("TWILIO_AUTH_TOKEN"));
    expect(validateProviderConfig(config)).toEqual(valid);
    expect(() => resolveTwilioAuthToken(config)).toThrow(
      'plugins.entries.voice-call.config.twilio.authToken: unresolved SecretRef "env:default:TWILIO_AUTH_TOKEN"',
    );
  });

  it("requires a public key unless signature verification is skipped", () => {
    const missingPublicKey = createBaseConfig("telnyx", {
      inboundPolicy: "allowlist",
      telnyx: { apiKey: "KEY123", connectionId: "CONN456" },
    });
    const missingPublicKeyResult = validateProviderConfig(missingPublicKey);
    expect(missingPublicKeyResult.valid).toBe(false);
    expect(missingPublicKeyResult.errors).toContain(
      `${errorPrefix}telnyx.publicKey is required (or set TELNYX_PUBLIC_KEY env)`,
    );

    const skippedVerification = {
      ...missingPublicKey,
      inboundPolicy: "disabled" as const,
      skipSignatureVerification: true,
    };
    expect(validateProviderConfig(skippedVerification)).toEqual(valid);
  });
  it("skips validation when enabled is false", () => {
    expect(validateProviderConfig(createBaseConfig("twilio", { enabled: false }))).toEqual(valid);
  });
  it.each([
    [{ realtime: { enabled: true } }, /inboundPolicy/],
    [
      { realtime: { enabled: true }, streaming: { enabled: true }, inboundPolicy: "allowlist" },
      /cannot both be true/,
    ],
    [
      { provider: "plivo", realtime: { enabled: true }, inboundPolicy: "allowlist" },
      /provider must.*realtime/,
    ],
    [{ provider: "plivo", streaming: { enabled: true } }, /provider must.*streaming/],
  ] as const)("rejects incompatible modes %j", (input, error) => {
    const config = normalizeVoiceCallConfig({ ...createBaseConfig("twilio"), ...input });
    const result = validateProviderConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(error));
  });

  it("accepts credential-free realtime with the mock provider", () => {
    const config = sessionConfig({ realtime: { enabled: true }, inboundPolicy: "allowlist" });
    expect(validateProviderConfig(config)).toEqual(valid);
  });
  it("accepts streaming.enabled with provider=twilio", () => {
    const config = createBaseConfig("twilio");
    config.streaming.enabled = true;
    config.twilio = { accountSid: "AC123", authToken: envRef("TWILIO_AUTH_TOKEN") };

    expect(validateProviderConfig(config)).toEqual(valid);
  });
});

describe("Tailscale external HTTPS port", () => {
  it.each([
    { tailscale: { mode: "serve", port: 4545 } },
    { tailscale: { mode: "funnel", port: 8443 } },
    { tailscale: { port: 10000 }, tunnel: { provider: "tailscale-funnel" } },
  ] as const)("accepts supported HTTPS port configuration %j", (input) => {
    expect(() => normalizeVoiceCallConfig(input)).not.toThrow();
  });

  it.each([0, 1.5, 65_536])("rejects invalid HTTPS port %s", (port) => {
    expect(() => normalizeVoiceCallConfig({ tailscale: { port } })).toThrow();
  });

  it.each([
    { name: "legacy mode", input: { tailscale: { mode: "funnel", port: 4545 } } },
    {
      name: "unified provider",
      input: { tailscale: { port: 4545 }, tunnel: { provider: "tailscale-funnel" } },
    },
  ])("rejects unsupported Funnel port for $name", ({ input }) => {
    expect(() => normalizeVoiceCallConfig(input)).toThrow(z.ZodError);
    expect(() => normalizeVoiceCallConfig(input)).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["tailscale", "port"],
            message: "Tailscale Funnel HTTPS port must be one of 443, 8443, 10000",
          }),
        ]),
      }),
    );
  });
});

describe("resolveVoiceCallConfig session routing", () => {
  it.each([
    [{}, {}, "agent:main:voice:15550001111"],
    [{ agentId: "Voice" }, { callId: "CALL-123" }, "agent:voice:voice:15550001111"],
    [{ sessionScope: "per-call" }, {}, "agent:main:voice:call:call-123"],
    [{ sessionScope: "main" }, {}, "agent:main:main"],
    [{ sessionScope: "main" }, { coreSession: { mainKey: "work" } }, "agent:main:work"],
    [{ sessionScope: "main" }, { coreSession: { scope: "global" } }, "global"],
    [{ sessionScope: "main", agentId: "ops" }, {}, "agent:ops:main"],
    [{ sessionScope: "main" }, { explicitSessionKey: "Meet-Room-1" }, "agent:main:meet-room-1"],
  ] as const)("routes session config %j with %j", (input, options, expected) => {
    const config = sessionConfig(input);
    expect(resolveSession(config, { callId: "call-123", ...options })).toBe(expected);
  });

  it("scopes persisted and explicit keys at the agent session boundary", () => {
    const config = sessionConfig({ agentId: "Voice" });
    for (const [sessionKey, expected] of [
      ["meet-room-1", "agent:voice:meet-room-1"],
      ["agent:other:Matrix:Channel:!AbC:x", "agent:voice:agent:other:matrix:channel:!AbC:x"],
      [
        "agent:voice:agent:other:matrix:channel:!AbC:x",
        "agent:voice:agent:other:matrix:channel:!AbC:x",
      ],
      ["Signal:Group:AbC123=", "agent:voice:signal:group:AbC123="],
      ["agent:broken", "agent:voice:agent:broken"],
      ["agent:other:room::part", "agent:voice:agent:other:room::part"],
      ["agent:voice::Matrix:Channel:!AbC:x", "agent:voice:agent:voice::matrix:channel:!AbC:x"],
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
    ] as const) {
      expect(
        resolveSession(config, { callId: "call-123", explicitSessionKey: key, coreSession }),
      ).toBe(expected);
    }
  });

  it("resolves per-number inbound route overrides over global voice settings", () => {
    const apiKey = envRef("VOICE_API_KEY");
    const route = {
      inboundGreeting: "Silver Fox Cards, how can I help?",
      agentId: "cards",
      responseModel: "openai/gpt-5.5",
      responseSystemPrompt: "You are a baseball card expert.",
      responseTimeoutMs: 20000,
    };
    const config = sessionConfig({
      inboundGreeting: "Hello from global.",
      agentId: "main",
      responseModel: "openai/gpt-5.4-mini",
      responseSystemPrompt: "Global voice assistant.",
      responseTimeoutMs: 10000,
      tts: { provider: "openai", providers: { openai: { voice: "coral", speed: 1 } } },
      numbers: {
        "+15550001111": {
          ...route,
          tts: { providers: { openai: { apiKey, voice: "alloy", voiceSettings: { speed: 1.1 } } } },
        },
      },
    });

    const effective = resolveVoiceCallEffectiveConfig(config, "+1 (555) 000-1111");
    expect(effective).toMatchObject({
      numberRouteKey: "+15550001111",
      config: { ...route, tts: { provider: "openai" } },
    });
    expect(effective.config.tts?.providers?.openai).toEqual({
      apiKey,
      voice: "alloy",
      speed: 1,
      voiceSettings: { speed: 1.1 },
    });
  });

  it("falls back to global voice settings when no per-number route matches", () => {
    const config = sessionConfig({ numbers: { "+15550001111": { inboundGreeting: "Hello." } } });

    const effective = resolveVoiceCallEffectiveConfig(config, "+15550002222");
    expect(effective.numberRouteKey).toBeUndefined();
    expect(effective.config).toBe(config);
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
    const numbers = { "+15550001111": { inboundGreeting: "Hello." } };
    const streaming = { custom: { apiKey: "synthetic-token" } };
    const realtime = { custom: { model: "test-model" } };
    const normalized = normalizeVoiceCallConfig({
      numbers: { ...numbers, "+15550002222": undefined },
      streaming: { providers: { ...streaming, absent: undefined } },
      realtime: { providers: { ...realtime, absent: undefined } },
    });
    expect(normalized.numbers).toEqual(numbers);
    expect(normalized.streaming.providers).toEqual(streaming);
    expect(normalized.realtime.providers).toEqual(realtime);
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
    expect(first).toMatchObject({
      serve: { path: "/voice/webhook" },
      tailscale: { port: 443 },
      tunnel: { provider: "none" },
      realtime: {
        toolPolicy: "safe-read-only",
        consultPolicy: "auto",
        fastContext: { enabled: false, fallbackToConsult: false },
        agentContext: { enabled: false, includeIdentity: true, includeWorkspaceFiles: true },
      },
    });
    expect(first.realtime.instructions).toContain("openclaw_agent_consult");
    expect(first.realtime.instructions).toContain("openclaw_end_call");
    expect(first.realtime.instructions).toContain("speak any final words first");
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
});

describe("resolveVoiceCallStreamExposurePaths", () => {
  const enabledPath = (streamPath: string) => ({ enabled: true, streamPath });
  const exposed = (localPath: string, publicPath = localPath) => ({ localPath, publicPath });
  it.each([
    [{}, []],
    [
      { serve: { path: "/custom/webhook" }, realtime: { enabled: true } },
      [exposed("/custom/stream/realtime")],
    ],
    [
      { realtime: enabledPath("custom/realtime"), streaming: enabledPath("custom/stream") },
      [exposed("/custom/realtime"), exposed("/custom/stream")],
    ],
    [
      { realtime: enabledPath("/voice/stream"), streaming: enabledPath("/voice/stream") },
      [exposed("/voice/stream")],
    ],
    [
      {
        serve: { path: "/voice/webhook" },
        tailscale: { path: "/edge/voice/webhook" },
        realtime: { enabled: true },
        streaming: enabledPath("/voice/stream"),
      },
      [exposed("/voice/stream/realtime", "/edge/voice/stream/realtime"), exposed("/voice/stream")],
    ],
  ] as const)("exposes the configured stream paths for %j", (input, expected) => {
    expect(resolveVoiceCallStreamExposurePaths(normalizeVoiceCallConfig(input))).toEqual(expected);
  });
});

describe("resolveVoiceCallConfig realtime settings", () => {
  it("preserves explicit realtime settings through normalization and resolution", () => {
    const realtime = {
      enabled: true,
      instructions: "Stay concise.",
      idleHangupMs: 45_000,
      consultThinkingLevel: "ultra",
      consultFastMode: true,
    };
    const config = normalizeVoiceCallConfig({ enabled: true, provider: "twilio", realtime });
    expect(resolveVoiceCallConfig(config).realtime).toMatchObject({
      ...realtime,
      toolPolicy: "safe-read-only",
      consultPolicy: "auto",
    });
    expect(config.realtime.provider).toBeUndefined();
  });
  it.each([
    [{ idleHangupMs: 0 }, undefined],
    [{ consultThinkingLevel: "turbo" }, /Invalid option/],
  ] as const)("rejects invalid realtime settings %j", (realtime, error) => {
    expect(() => sessionConfig({ realtime })).toThrow(error);
  });
});

function migrate(value: unknown, configPathPrefix?: string) {
  return migrateVoiceCallLegacyConfigInput({ value, configPathPrefix });
}

describe("voice-call config migration", () => {
  it("declares the setup entry needed to migrate installed packages", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson).toMatchObject({ openclaw: { setupEntry: "./setup-api.ts" } });
  });

  it("maps deprecated provider and twilio.from fields into canonical config", () => {
    const migration = migrate({ provider: "log", twilio: { from: "+15550001234" } });
    expect(migration.config).toMatchObject({ provider: "mock", fromNumber: "+15550001234" });
  });

  it("migrates through the setup hook without changing its input or sibling plugins", () => {
    const registerConfigMigration = vi.fn<OpenClawPluginApi["registerConfigMigration"]>();
    setup.register(createTestPluginApi({ registerConfigMigration }));
    const other = { config: { nested: { keep: true } } };
    const pluginConfig = (provider: string) => ({
      plugins: { entries: { "voice-call": { enabled: true, config: { provider } }, other } },
    });
    const config = pluginConfig("log");
    const before = structuredClone(config);
    const migration = registerConfigMigration.mock.calls[0]?.[0](config);

    expect(config).toEqual(before);
    expect(migration?.config).toEqual(pluginConfig("mock"));
  });

  it("fills only missing streaming provider fields while preserving canonical values", () => {
    const current = {
      apiKey: { source: "env", provider: "default", id: "SYNTHETIC_VOICE_KEY" },
      model: "",
      vadThreshold: 0,
      keep: "current",
    };
    const value = {
      streaming: {
        enabled: true,
        sttProvider: "openai",
        openaiApiKey: "synthetic-legacy-key",
        sttModel: "synthetic-legacy-model",
        silenceDurationMs: 700,
        vadThreshold: 0.4,
        providers: { openai: current, other: { keep: "other-provider" } },
      },
    };
    const before = structuredClone(value);
    const migration = migrate(value);

    expect(migration.config.streaming).toEqual({
      enabled: true,
      provider: "openai",
      providers: {
        other: { keep: "other-provider" },
        openai: { ...before.streaming.providers.openai, silenceDurationMs: 700 },
      },
    });
    expect(value).toEqual(before);
    expect(() => normalizeVoiceCallConfig(migration.config)).not.toThrow();
    expect(migrate(migration.config)).toEqual({ config: migration.config, changes: [] });
  });

  it("reports removal of legacy selectors while retaining canonical settings", () => {
    const migration = migrate(
      {
        fromNumber: "+15550005678",
        twilio: { from: "+15550001234", accountSid: "synthetic-account" },
        streaming: { provider: "other", sttProvider: "openai" },
      },
      "voice-config",
    );

    expect(migration.config.fromNumber).toBe("+15550005678");
    expect(migration.config.twilio).toEqual({ accountSid: "synthetic-account" });
    expect(migration.config.streaming).toEqual({ provider: "other" });
    expect(migration.changes).toEqual([
      "Removed voice-config.twilio.from (kept voice-config.fromNumber).",
      "Removed voice-config.streaming.sttProvider (kept voice-config.streaming.provider).",
    ]);
  });

  it("does not migrate non-finite legacy streaming numbers", () => {
    const migration = migrate({
      streaming: { silenceDurationMs: Number.NaN, vadThreshold: Number.POSITIVE_INFINITY },
    });
    expect(migration.config.streaming).toEqual({ provider: undefined });
  });

  it("returns doctor migration change lines", () => {
    const migration = migrate({
      provider: "log",
      streaming: { sttProvider: "openai" },
      realtime: { agentContext: { includeSystemPrompt: true } },
    });

    expect(migration.changes).toEqual([
      'Moved plugins.entries.voice-call.config.provider "log" → "mock".',
      "Moved plugins.entries.voice-call.config.streaming.sttProvider → plugins.entries.voice-call.config.streaming.provider.",
      "Removed plugins.entries.voice-call.config.realtime.agentContext.includeSystemPrompt.",
    ]);
  });
});

it("validates the realtime input transcription model in runtime and manifest schemas", () => {
  const { configSchema } = JSON.parse(
    readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );
  const providers = { openai: { inputTranscriptionModel: "transcribe-prod" } };
  expect(normalizeVoiceCallConfig({ realtime: { providers } }).realtime.providers).toEqual(
    providers,
  );
  expect(
    validateJsonSchemaValue({ schema: configSchema, value: { realtime: { providers } } }).ok,
  ).toBe(true);
  const invalid = { realtime: { providers: { openai: { inputTranscriptionModel: 123 } } } };
  expect(() => normalizeVoiceCallConfig(invalid)).toThrow(/inputTranscriptionModel/);
  expect(validateJsonSchemaValue({ schema: configSchema, value: invalid }).ok).toBe(false);
});
