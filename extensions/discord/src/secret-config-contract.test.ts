import type { ResolverContext } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { describe, expect, it } from "vitest";
import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./secret-config-contract.js";

const secretRef = (id: string) => ({ source: "env", provider: "default", id }) as const;

function createContext(): ResolverContext {
  return {
    sourceConfig: {},
    env: {},
    cache: {},
    warnings: [],
    warningKeys: new Set(),
    assignments: [],
  };
}

function voice(keys: Record<string, string>, mode?: "stt-tts") {
  const providers = Object.fromEntries(
    Object.entries(keys).map(([provider, id]) => [provider, { apiKey: secretRef(id) }]),
  );
  return { enabled: true, mode, realtime: { providers } };
}

function collectVoiceAssignments(
  root: ReturnType<typeof voice>,
  work: ReturnType<typeof voice>,
  accountId = "Work",
) {
  const context = createContext();
  collectRuntimeConfigAssignments({
    config: {
      channels: {
        discord: {
          voice: root,
          accounts: {
            inherited: { enabled: true },
            [accountId]: { enabled: true, voice: work },
          },
        },
      },
    },
    context,
  });
  return context;
}

describe("Discord secret target registry", () => {
  it.each([
    ["channels.discord.voice.realtime.providers.*.apiKey", 5],
    ["channels.discord.voice.tts.providers.*.apiKey", 5],
    ["channels.discord.voice.tts.personas.*.providers.*.apiKey", 7],
    ["channels.discord.accounts.*.voice.tts.personas.*.providers.*.apiKey", 9],
    ["channels.discord.accounts.*.voice.realtime.providers.*.apiKey", 7],
    ["channels.discord.accounts.*.voice.tts.providers.*.apiKey", 7],
  ] as const)("identifies the provider segment for %s", (targetId, providerIndex) => {
    const entry = secretTargetRegistryEntries.find((candidate) => candidate.id === targetId);
    expect(entry?.providerIdPathSegmentIndex).toBe(providerIndex);
  });

  it("partitions realtime owners by account and provider", () => {
    const context = collectVoiceAssignments(
      voice({ openai: "ROOT_OPENAI", mistral: "ROOT_MISTRAL" }),
      voice({ openai: "WORK_OPENAI" }),
    );

    expect(
      context.assignments
        .filter((assignment) => assignment.path.includes("voice.realtime"))
        .map(({ ownerId, path }) => ({ ownerId, path })),
    ).toStrictEqual([
      {
        ownerId: "discord:voice:realtime:inherited:openai",
        path: "channels.discord.voice.realtime.providers.openai.apiKey",
      },
      {
        ownerId: "discord:voice:realtime:inherited:mistral",
        path: "channels.discord.voice.realtime.providers.mistral.apiKey",
      },
      {
        ownerId: "discord:voice:realtime:work:openai",
        path: "channels.discord.accounts.Work.voice.realtime.providers.openai.apiKey",
      },
    ]);
  });

  it("skips realtime provider refs when Discord voice uses stt-tts mode", () => {
    const context = collectVoiceAssignments(
      voice({ openai: "UNUSED_REALTIME_KEY" }, "stt-tts"),
      voice({ openai: "UNUSED_WORK_REALTIME_KEY" }, "stt-tts"),
      "work",
    );

    expect(context.assignments).toStrictEqual([]);
    expect(context.warnings).toMatchObject([
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.discord.voice.realtime.providers.openai.apiKey",
      },
      {
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "channels.discord.accounts.work.voice.realtime.providers.openai.apiKey",
      },
    ]);
  });
});
