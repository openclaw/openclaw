import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./secret-config-contract.js";

const { canonicalizeRealtimeVoiceProviderIdMock, listRealtimeVoiceProvidersMock } = vi.hoisted(
  () => ({
    canonicalizeRealtimeVoiceProviderIdMock: vi.fn((providerId: string | undefined) =>
      providerId === "codex-realtime" ? "codex" : providerId,
    ),
    listRealtimeVoiceProvidersMock: vi.fn(() => {
      const isConfigured = ({ providerConfig }: { providerConfig: Record<string, unknown> }) =>
        typeof providerConfig.apiKey === "string";
      return [
        {
          id: "openai",
          autoSelectOrder: 10,
          isConfigured,
        },
        {
          id: "google",
          autoSelectOrder: 20,
          resolveConfig: ({
            cfg,
            rawConfig,
          }: {
            cfg: OpenClawConfig;
            rawConfig: Record<string, unknown>;
          }) => {
            const apiKey = rawConfig.apiKey ?? cfg.models?.providers?.google?.apiKey;
            if (apiKey !== undefined && typeof apiKey !== "string") {
              throw new Error("unresolved Google API key");
            }
            return { ...rawConfig, apiKey };
          },
          isConfigured,
        },
        {
          id: "codex",
          autoSelectOrder: 40,
          isConfigured,
        },
      ];
    }),
  }),
);

vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  canonicalizeRealtimeVoiceProviderId: canonicalizeRealtimeVoiceProviderIdMock,
  listRealtimeVoiceProviders: listRealtimeVoiceProvidersMock,
  normalizeRealtimeVoiceProviderId: (providerId: string | undefined) =>
    providerId?.trim().toLowerCase() || undefined,
}));

describe("Discord secret config contract", () => {
  it("registers root and account voice provider API keys with provider ids", () => {
    expect(
      secretTargetRegistryEntries
        .filter((entry) => entry.id.includes("voice.") && entry.id.includes(".providers."))
        .map((entry) => [entry.id, entry.providerIdPathSegmentIndex]),
    ).toEqual([
      ["channels.discord.accounts.*.voice.realtime.providers.*.apiKey", 7],
      ["channels.discord.accounts.*.voice.tts.providers.*.apiKey", 7],
      ["channels.discord.voice.realtime.providers.*.apiKey", 5],
      ["channels.discord.voice.tts.providers.*.apiKey", 5],
    ]);
  });

  it("collects active root and account realtime provider API keys", () => {
    const sourceConfig = {
      channels: {
        discord: {
          voice: {
            realtime: {
              providers: {
                codex: {
                  apiKey: { source: "env", provider: "default", id: "DISCORD_REALTIME_CODEX" },
                },
              },
            },
          },
          accounts: {
            inherited: { enabled: true },
            work: {
              enabled: true,
              voice: {
                realtime: {
                  providers: {
                    codex: {
                      apiKey: {
                        source: "env",
                        provider: "default",
                        id: "DISCORD_WORK_REALTIME_CODEX",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments.map(({ path, ref }) => ({ path, ref }))).toEqual([
      {
        path: "channels.discord.voice.realtime.providers.codex.apiKey",
        ref: { source: "env", provider: "default", id: "DISCORD_REALTIME_CODEX" },
      },
      {
        path: "channels.discord.accounts.work.voice.realtime.providers.codex.apiKey",
        ref: { source: "env", provider: "default", id: "DISCORD_WORK_REALTIME_CODEX" },
      },
    ]);
    expect(context.assignments.map(({ path, ownerId }) => ({ path, ownerId }))).toEqual([
      {
        path: "channels.discord.voice.realtime.providers.codex.apiKey",
        ownerId: "channels.discord.voice.realtime.providers.codex",
      },
      {
        path: "channels.discord.accounts.work.voice.realtime.providers.codex.apiKey",
        ownerId: "channels.discord.accounts.work.voice.realtime.providers.codex",
      },
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("skips API keys for explicitly unselected realtime providers", () => {
    const sourceConfig = {
      channels: {
        discord: {
          voice: {
            realtime: {
              provider: "codex",
              providers: {
                codex: {
                  apiKey: { source: "env", provider: "default", id: "ROOT_CODEX" },
                },
                openai: {
                  apiKey: { source: "env", provider: "default", id: "ROOT_OPENAI" },
                },
              },
            },
          },
          accounts: {
            inherited: { enabled: true },
            work: {
              enabled: true,
              voice: {
                realtime: {
                  provider: "openai",
                  providers: {
                    codex: {
                      apiKey: { source: "env", provider: "default", id: "WORK_CODEX" },
                    },
                    openai: {
                      apiKey: { source: "env", provider: "default", id: "WORK_OPENAI" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments.map(({ path }) => path)).toEqual([
      "channels.discord.voice.realtime.providers.codex.apiKey",
      "channels.discord.accounts.work.voice.realtime.providers.openai.apiKey",
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("keeps realtime API keys inactive in stt-tts mode", () => {
    const sourceConfig = {
      channels: {
        discord: {
          voice: {
            mode: "stt-tts",
            realtime: {
              providers: {
                openai: {
                  apiKey: { source: "env", provider: "default", id: "ROOT_OPENAI" },
                },
              },
            },
          },
          accounts: {
            work: {
              voice: {
                mode: "stt-tts",
                realtime: {
                  providers: {
                    google: {
                      apiKey: { source: "env", provider: "default", id: "WORK_GOOGLE" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings.map(({ code, path }) => ({ code, path }))).toEqual([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.discord.voice.realtime.providers.openai.apiKey",
      },
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.discord.accounts.work.voice.realtime.providers.google.apiKey",
      },
    ]);
  });

  it("auto-selects the first configured realtime provider", () => {
    const sourceConfig = {
      channels: {
        discord: {
          voice: {
            realtime: {
              providers: {
                google: {
                  apiKey: { source: "env", provider: "default", id: "LOWER_GOOGLE" },
                },
                openai: {
                  apiKey: { source: "env", provider: "default", id: "FIRST_OPENAI" },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: { FIRST_OPENAI: "available" } });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments.map(({ path }) => path)).toEqual([
      "channels.discord.voice.realtime.providers.openai.apiKey",
    ]);
    expect(context.warnings).toStrictEqual([]);
  });

  it("auto-selects a global provider SecretRef before a lower local provider", () => {
    const sourceConfig = {
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com",
            models: [],
            apiKey: { source: "env", provider: "default", id: "GLOBAL_GOOGLE" },
          },
        },
      },
      channels: {
        discord: {
          voice: {
            realtime: {
              providers: {
                codex: {
                  apiKey: { source: "env", provider: "default", id: "LOWER_CODEX" },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({
      sourceConfig,
      env: { GLOBAL_GOOGLE: "available" },
    });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toStrictEqual([]);
    expect(sourceConfig.models?.providers?.google?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "GLOBAL_GOOGLE",
    });
  });

  it("collects the canonical provider API key when an alias does not override it", () => {
    const sourceConfig = {
      channels: {
        discord: {
          voice: {
            realtime: {
              provider: "codex-realtime",
              providers: {
                codex: {
                  apiKey: { source: "env", provider: "default", id: "ROOT_CODEX" },
                },
                "codex-realtime": { voice: "arbor" },
                openai: {
                  apiKey: { source: "env", provider: "default", id: "ROOT_OPENAI" },
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments.map(({ path }) => path)).toEqual([
      "channels.discord.voice.realtime.providers.codex.apiKey",
    ]);
    expect(canonicalizeRealtimeVoiceProviderIdMock).toHaveBeenCalledWith(
      "codex-realtime",
      sourceConfig,
    );
    expect(context.warnings).toStrictEqual([]);
  });

  it("skips a canonical provider API key shadowed by an alias override", () => {
    const sourceConfig = {
      channels: {
        discord: {
          voice: {
            realtime: {
              provider: "codex-realtime",
              providers: {
                codex: {
                  apiKey: { source: "env", provider: "default", id: "ROOT_CODEX" },
                },
                "codex-realtime": {
                  apiKey: { source: "env", provider: "default", id: "ROOT_CODEX_ALIAS" },
                  voice: "arbor",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: structuredClone(sourceConfig),
      defaults: undefined,
      context,
    });

    expect(context.assignments.map(({ path, ref }) => ({ path, ref }))).toEqual([
      {
        path: "channels.discord.voice.realtime.providers.codex-realtime.apiKey",
        ref: { source: "env", provider: "default", id: "ROOT_CODEX_ALIAS" },
      },
    ]);
    expect(context.warnings).toStrictEqual([]);
  });
});
