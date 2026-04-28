import { describe, expect, it } from "vitest";
import { resolveDiscordGatewayIntents } from "./gateway-plugin.js";

// Discord gateway intent bit values from the Discord API. We assert against
// the bitmask result rather than importing the SDK enum so the test does not
// need the carbon-gateway runtime — the values are public protocol constants.
const GUILDS = 1 << 0;
const GUILD_MEMBERS = 1 << 1;
const GUILD_VOICE_STATES = 1 << 7;
const GUILD_PRESENCES = 1 << 8;
const GUILD_MESSAGES = 1 << 9;
const GUILD_MESSAGE_REACTIONS = 1 << 10;
const DIRECT_MESSAGES = 1 << 12;
const DIRECT_MESSAGE_REACTIONS = 1 << 13;
const MESSAGE_CONTENT = 1 << 15;

const BASE_TEXT_INTENTS =
  GUILDS |
  GUILD_MESSAGES |
  MESSAGE_CONTENT |
  DIRECT_MESSAGES |
  GUILD_MESSAGE_REACTIONS |
  DIRECT_MESSAGE_REACTIONS;

describe("resolveDiscordGatewayIntents", () => {
  it("includes GuildVoiceStates by default (no voice config provided)", () => {
    const intents = resolveDiscordGatewayIntents();
    expect(intents & GUILD_VOICE_STATES).toBe(GUILD_VOICE_STATES);
    expect(intents & BASE_TEXT_INTENTS).toBe(BASE_TEXT_INTENTS);
  });

  it("includes GuildVoiceStates when voice.enabled is explicitly true", () => {
    const intents = resolveDiscordGatewayIntents(undefined, { enabled: true });
    expect(intents & GUILD_VOICE_STATES).toBe(GUILD_VOICE_STATES);
  });

  it("omits GuildVoiceStates when voice.enabled is explicitly false (#73709)", () => {
    // Regression for #73709: subscribing to the GuildVoiceStates gateway
    // intent when the operator has set `channels.discord.voice.enabled =
    // false` produced a sustained ~100% CPU spin in the gateway process
    // on Linux (~20-33% on macOS Apple Silicon) at idle. The intent must
    // follow the voice-config opt-out so a text-only Discord channel
    // really is text-only.
    const intents = resolveDiscordGatewayIntents(undefined, { enabled: false });
    expect(intents & GUILD_VOICE_STATES).toBe(0);
    // Base text-channel intents stay on so chat keeps working.
    expect(intents & BASE_TEXT_INTENTS).toBe(BASE_TEXT_INTENTS);
  });

  it("layers privileged intents (presence, guildMembers) independently of voice", () => {
    const intents = resolveDiscordGatewayIntents(
      { presence: true, guildMembers: true },
      { enabled: false },
    );
    expect(intents & GUILD_PRESENCES).toBe(GUILD_PRESENCES);
    expect(intents & GUILD_MEMBERS).toBe(GUILD_MEMBERS);
    expect(intents & GUILD_VOICE_STATES).toBe(0);
  });
});
