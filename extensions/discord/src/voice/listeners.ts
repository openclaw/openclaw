import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  type APIVoiceState,
  type Client,
  GatewayDispatchEvents,
  type GatewayGuildCreateDispatchData,
} from "../internal/discord.js";
import type { DiscordVoiceManager } from "./voice-runtime.js";

const logger = createSubsystemLogger("discord/voice");

function startAutoJoin(operation: () => Promise<unknown>, context = "") {
  void operation().catch((err: unknown) =>
    logger.warn(`discord voice: autoJoin${context} failed: ${formatErrorMessage(err)}`),
  );
}

export class DiscordVoiceReadyListener {
  readonly type: GatewayDispatchEvents.Ready | GatewayDispatchEvents.Resumed =
    GatewayDispatchEvents.Ready;

  constructor(private manager: DiscordVoiceManager) {}

  async handle(_data: unknown, _client: Client): Promise<void> {
    startAutoJoin(() => this.manager.autoJoin());
  }
}

export class DiscordVoiceResumedListener extends DiscordVoiceReadyListener {
  override readonly type = GatewayDispatchEvents.Resumed;
}

export class DiscordVoiceGuildCreateListener {
  readonly type = GatewayDispatchEvents.GuildCreate;

  constructor(private manager: DiscordVoiceManager) {}

  async handle(data: GatewayGuildCreateDispatchData, _client: Client): Promise<void> {
    if (!data.unavailable) {
      this.manager.refreshGuildRoster(data.id);
      startAutoJoin(
        () => this.manager.reconcileAutoJoinGuild(data.id),
        ` occupancy reconciliation guild=${data.id}`,
      );
    }
  }
}

export class DiscordVoiceStateUpdateListener {
  readonly type = GatewayDispatchEvents.VoiceStateUpdate;
  constructor(private manager: DiscordVoiceManager) {}

  async handle(data: APIVoiceState, client: Client): Promise<void> {
    const transition = client.getPlugin("gateway")?.takeVoiceStateTransition(data);
    await this.manager.handleVoiceStateUpdate(
      data,
      transition ? (transition.previous ?? null) : undefined,
    );
  }
}
