import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlowInput, runtimeEnv } from "./discord-flow.test-support.js";
import * as testing from "./discord-live.runtime.js";
import { discordQaVoiceAutojoinScenario } from "./discord-live.runtime.js";
import { discordQaTranscriptsVoiceAuthorizationScenario } from "./discord-transcripts-authorization.runtime.js";
import { createDiscordQaScenarioEnvironment } from "./scenario-environment.js";

const { guildId, channelId: textChannelId, sutApplicationId: sutId } = runtimeEnv;
const driverId = "423456789012345678";
const voiceChannelId = "523456789012345678";

function expectChannelUsers(patch: OpenClawConfig | undefined, voiceUser: string) {
  const channels = patch?.channels?.discord?.accounts?.sut?.guilds?.[guildId]?.channels;
  expect(channels?.[textChannelId]?.users).toEqual([driverId]);
  expect(channels?.[voiceChannelId]?.users).toEqual([voiceUser]);
}

async function prepareScenario(voiceDestination?: string) {
  const patches: OpenClawConfig[] = [];
  const call = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return {
        config: {},
        hash: "config-hash",
        appliedConfigHash: "runtime-hash",
        configRevisionHash: "runtime-hash",
      };
    }
    if (method === "config.patch") {
      patches.push(JSON.parse((params as { raw: string }).raw) as OpenClawConfig);
      return { hash: "config-hash" };
    }
    if (method === "channels.status") {
      return {
        channelAccounts: { discord: [{ accountId: "sut", running: true, connected: true }] },
      };
    }
    throw new Error(`unexpected gateway call: ${method}`);
  });
  const { prepareFlow } = createDiscordQaScenarioEnvironment({
    accountId: "sut",
    driverIdentity: { id: driverId, bot: true },
    sutIdentity: { id: sutId, bot: true },
    runtimeEnv: { ...runtimeEnv, voiceChannelId: voiceDestination },
  });
  const prepared = await prepareFlow(createFlowInput(undefined, call));
  return { call, patches, configureScenario: prepared.discordScenarioContext.configureScenario };
}

describe("Discord QA scenario environment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects transcript capture without an explicit destination before discovery or gateway access", async () => {
    const resolveVoiceChannel = vi
      .spyOn(testing, "resolveDiscordQaVoiceChannel")
      .mockRejectedValue(new Error("must not discover a voice destination"));
    const { call, configureScenario } = await prepareScenario();

    await expect(configureScenario(discordQaTranscriptsVoiceAuthorizationScenario)).rejects.toThrow(
      "requires an explicit QA voiceChannelId",
    );
    expect(resolveVoiceChannel).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([true, false])("configures the voice channel (explicit: %s)", async (explicit) => {
    const voiceChannel = { id: voiceChannelId, guild_id: guildId, type: 2 };
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(explicit ? voiceChannel : [{ id: textChannelId, type: 0 }, voiceChannel]),
    );
    vi.stubGlobal("fetch", request);
    const { configureScenario, patches } = await prepareScenario(
      explicit ? voiceChannelId : undefined,
    );
    const configured = await configureScenario(
      explicit ? discordQaTranscriptsVoiceAuthorizationScenario : discordQaVoiceAutojoinScenario,
    );

    expect(configured.voiceChannel).toEqual(voiceChannel);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(
      `https://discord.com/api/v10/${explicit ? `channels/${voiceChannelId}` : `guilds/${guildId}/channels`}`,
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]?.channels?.discord?.voice).toEqual({
      enabled: true,
      mode: "stt-tts",
      autoJoin: explicit ? [] : [{ guildId, channelId: voiceChannelId }],
    });
    if (explicit) {
      expect(patches[0]?.tools?.alsoAllow).toContain("transcripts");
      expect(patches[0]?.agents?.entries?.qa?.tools?.alsoAllow).toContain("transcripts");
      expectChannelUsers(patches[0], sutId);
      await configured.configureTranscriptVoiceAccess?.(true);
      expect(patches).toHaveLength(2);
      expectChannelUsers(patches[1], driverId);
      expect(request).toHaveBeenCalledOnce();
    }
  });
});
