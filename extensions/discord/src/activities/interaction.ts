import { logError } from "openclaw/plugin-sdk/logging-core";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import {
  buildDiscordActivityCustomId,
  parseDiscordActivityCustomIdForInteraction,
} from "../component-custom-id.js";
import type { BaseComponentInteraction, ComponentData } from "../internal/discord.js";
import { Button } from "../internal/discord.js";
import { replySilently } from "../monitor/agent-components-reply.js";
import type { AgentComponentContext } from "../monitor/agent-components.types.js";
import { getDiscordActivitiesRuntime } from "./runtime.js";

const REGISTRATION_WIDGET_ID = "AAAAAAAAAAAAAAAAAAAAAA";

const PENDING_LAUNCH_WRITE_BUDGET_MS = 250;

class DiscordActivityButton extends Button {
  label = "Open widget";
  customId = buildDiscordActivityCustomId(REGISTRATION_WIDGET_ID);
  override customIdParser = parseDiscordActivityCustomIdForInteraction;

  constructor(private readonly ctx: AgentComponentContext) {
    super();
  }

  private pendingLaunchFailureLogged = false;

  private logPendingLaunchFailure(error: unknown): void {
    if (this.pendingLaunchFailureLogged) {
      return;
    }
    this.pendingLaunchFailureLogged = true;
    logError(`discord activity: failed to record pending launch: ${String(error)}`);
  }

  override async run(interaction: BaseComponentInteraction, data: ComponentData): Promise<void> {
    if (typeof data.widgetId !== "string") {
      await replySilently(interaction, {
        content: "This widget is no longer valid.",
        ephemeral: true,
      });
      return;
    }
    const runtime = getDiscordActivitiesRuntime();
    const channelId = interaction.rawData.channel_id;
    const discordUserId = interaction.userId;
    if (!runtime || !channelId || !discordUserId) {
      this.logPendingLaunchFailure(new Error("missing activity runtime or interaction identity"));
    } else {
      // Await the write within a small budget so the record is visible before the Activity
      // can query api/widget, while never risking Discord's 3-second interaction ack: a
      // healthy store commits in single-digit milliseconds; on timeout the write continues
      // in the background and the mangled-ID multi-widget case degrades to fail-closed.
      const write = runtime.store
        .recordPendingLaunch({
          accountId: this.ctx.accountId,
          channelId,
          discordUserId,
          widgetId: data.widgetId,
          createdAt: Date.now(),
        })
        .then(() => "written" as const)
        .catch((error: unknown) => {
          this.logPendingLaunchFailure(error);
          return "failed" as const;
        });
      const result = await raceWithTimeout(write, PENDING_LAUNCH_WRITE_BUDGET_MS, () => "timeout", {
        ref: false,
      });
      if (result === "timeout") {
        this.logPendingLaunchFailure(
          new Error(`pending launch write exceeded ${PENDING_LAUNCH_WRITE_BUDGET_MS}ms`),
        );
      }
    }
    await interaction.launchActivity();
  }
}

export function createDiscordActivityButton(
  ctx: AgentComponentContext,
  applicationId?: string,
): DiscordActivityButton | null {
  const runtime = getDiscordActivitiesRuntime();
  if (!runtime) {
    return null;
  }
  if (applicationId) {
    runtime.registerApplicationId(ctx.accountId, applicationId);
  }
  if (!runtime.resolveAccount(ctx.accountId, ctx.cfg)) {
    return null;
  }
  return new DiscordActivityButton(ctx);
}
