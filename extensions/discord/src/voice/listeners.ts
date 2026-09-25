import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  type APIVoiceState,
  type Client,
  GatewayDispatchEvents,
  type GatewayGuildCreateDispatchData,
  ReadyListener,
  ResumedListener,
  VoiceStateUpdateListener,
} from "../internal/discord.js";
import type { GatewayPlugin } from "../internal/gateway.js";
import type { DiscordVoiceListenerManager } from "./listener-contract.js";

const logger = createSubsystemLogger("discord/voice");

function startAutoJoin(operation: () => Promise<unknown>, context = "") {
  void operation().catch((err: unknown) =>
    logger.warn(`discord voice: autoJoin${context} failed: ${formatErrorMessage(err)}`),
  );
}

export class DiscordVoiceReadyListener extends ReadyListener {
  constructor(private manager: DiscordVoiceListenerManager) {
    super();
  }

  async handle(_data: unknown, _client: Client): Promise<void> {
    startAutoJoin(() => this.manager.autoJoin());
  }
}

export class DiscordVoiceResumedListener extends ResumedListener {
  constructor(private manager: DiscordVoiceListenerManager) {
    super();
  }

  async handle(_data: unknown, _client: Client): Promise<void> {
    startAutoJoin(() => this.manager.autoJoin());
  }
}

export class DiscordVoiceGuildCreateListener {
  readonly type = GatewayDispatchEvents.GuildCreate;

  constructor(private manager: DiscordVoiceListenerManager) {}

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

export class DiscordVoiceStateUpdateListener extends VoiceStateUpdateListener {
  constructor(private manager: DiscordVoiceListenerManager) {
    super();
  }

  async handle(data: APIVoiceState, client: Client): Promise<void> {
    const transition = client.getPlugin<GatewayPlugin>("gateway")?.takeVoiceStateTransition(data);
    await this.manager.handleVoiceStateUpdate(
      data,
      transition ? (transition.previous ?? null) : undefined,
    );
  }
}
