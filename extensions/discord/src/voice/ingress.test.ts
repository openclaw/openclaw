// Discord tests cover voice ingress session reuse behavior.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

const { agentCommandMock } = vi.hoisted(() => ({
  agentCommandMock: vi.fn(
    async (
      _opts?: unknown,
      _runtime?: unknown,
    ): Promise<{ payloads?: Array<{ text?: string }> }> => ({
      payloads: [{ text: "ok" }],
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/agent-runtime")>(
    "openclaw/plugin-sdk/agent-runtime",
  );
  return {
    ...actual,
    agentCommandFromIngress: agentCommandMock,
  };
});

const { runDiscordVoiceAgentTurn } = await import("./ingress.js");

const GUILD_ID = "100000000000000001";
const CHANNEL_ID = "200000000000000002";
const USER_ID = "300000000000000003";
const SESSION_KEY = `agent:agent-1:discord:${GUILD_ID}:${CHANNEL_ID}`;
const STORED_SESSION_ID = "stored-session-id-uuid";

let tmpRoot: string;

function writeStoreEntry(storePath: string, sessionKey: string, sessionId: string): void {
  const now = Date.now();
  const store = {
    [sessionKey]: { sessionId, updatedAt: now, sessionStartedAt: now },
  };
  writeFileSync(storePath, JSON.stringify(store));
}

function createSpeakerContext(): DiscordVoiceSpeakerContextResolver {
  return {
    resolveContext: vi.fn(async () => ({
      id: USER_ID,
      label: "Ada",
      senderIsOwner: true,
    })),
    resolveIdentity: vi.fn(async () => ({
      id: USER_ID,
      label: "Ada",
      name: "ada",
      tag: "Ada#0001",
      memberRoleIds: [],
    })),
  } as unknown as DiscordVoiceSpeakerContextResolver;
}

function createEntry(sessionKey: string) {
  return {
    guildId: GUILD_ID,
    guildName: "Guild 1",
    channelId: CHANNEL_ID,
    channelName: "general",
    sessionChannelId: CHANNEL_ID,
    voiceSessionKey: "voice-1",
    route: { agentId: "agent-1", sessionKey },
  } as unknown as Parameters<typeof runDiscordVoiceAgentTurn>[0]["entry"];
}

function makeCfg(storePath: string): OpenClawConfig {
  return {
    session: { store: storePath },
  } as unknown as OpenClawConfig;
}

const discordConfig: DiscordAccountConfig = {
  guilds: { [GUILD_ID]: { channels: { [CHANNEL_ID]: {} } } },
} as unknown as DiscordAccountConfig;

const runtime: RuntimeEnv = {} as unknown as RuntimeEnv;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "discord-voice-ingress-"));
  agentCommandMock.mockClear();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runDiscordVoiceAgentTurn session continuity", () => {
  const context = {
    senderIsOwner: true,
    speakerLabel: "Ada",
  };

  it("passes the stored sessionId to agentCommandFromIngress so consecutive voice turns share state", async () => {
    const storePath = join(tmpRoot, "sessions.json");
    writeStoreEntry(storePath, SESSION_KEY, STORED_SESSION_ID);

    await runDiscordVoiceAgentTurn({
      entry: createEntry(SESSION_KEY),
      userId: USER_ID,
      message: "hello",
      cfg: makeCfg(storePath),
      discordConfig,
      runtime,
      context,
      fetchGuildName: vi.fn(async () => "Guild 1"),
      speakerContext: createSpeakerContext(),
    });

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const opts = agentCommandMock.mock.calls[0]?.[0] as { sessionId?: string; sessionKey?: string };
    expect(opts.sessionKey).toBe(SESSION_KEY);
    expect(opts.sessionId).toBe(STORED_SESSION_ID);
  });

  it("omits sessionId when no prior session entry exists, letting core mint a new one", async () => {
    const storePath = join(tmpRoot, "sessions.json");
    writeFileSync(storePath, JSON.stringify({}));

    await runDiscordVoiceAgentTurn({
      entry: createEntry(SESSION_KEY),
      userId: USER_ID,
      message: "hello",
      cfg: makeCfg(storePath),
      discordConfig,
      runtime,
      context,
      fetchGuildName: vi.fn(async () => "Guild 1"),
      speakerContext: createSpeakerContext(),
    });

    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    const opts = agentCommandMock.mock.calls[0]?.[0] as { sessionId?: string; sessionKey?: string };
    expect(opts.sessionKey).toBe(SESSION_KEY);
    expect(opts.sessionId).toBeUndefined();
  });
});
