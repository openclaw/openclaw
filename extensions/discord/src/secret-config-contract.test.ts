import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createResolverContext } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./secret-config-contract.js";

const { canonicalizeRealtimeVoiceProviderIdMock } = vi.hoisted(() => ({
  canonicalizeRealtimeVoiceProviderIdMock: vi.fn((providerId: string | undefined) =>
    providerId === "codex-realtime" ? "codex" : providerId,
  ),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  canonicalizeRealtimeVoiceProviderId: canonicalizeRealtimeVoiceProviderIdMock,
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

  it("collects the canonical provider API key when selected through an alias", () => {
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
});
