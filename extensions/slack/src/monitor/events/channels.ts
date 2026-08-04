// Slack plugin module implements channels behavior.
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { migrateSlackChannelConfig } from "../../channel-migration.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import type {
  SlackChannelCreatedEvent,
  SlackChannelIdChangedEvent,
  SlackChannelRenamedEvent,
} from "../types.js";
import {
  handleSlackSystemEventFailure,
  resolveSlackSystemEventOccurrenceId,
} from "./system-event-context.js";

export function registerSlackChannelEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  const enqueueChannelSystemEvent = (paramsLocal: {
    kind: "created" | "renamed";
    channelId: string | undefined;
    channelName: string | undefined;
    occurrenceId: string;
  }) => {
    if (
      !ctx.isChannelAllowed({
        channelId: paramsLocal.channelId,
        channelName: paramsLocal.channelName,
        channelType: "channel",
      })
    ) {
      return;
    }

    const label = resolveSlackChannelLabel({
      channelId: paramsLocal.channelId,
      channelName: paramsLocal.channelName,
    });
    const sessionKey = ctx.resolveSlackSystemEventSessionKey({
      channelId: paramsLocal.channelId,
      channelType: "channel",
    });
    enqueueSystemEvent(`Slack channel ${paramsLocal.kind}: ${label}.`, {
      sessionKey,
      contextKey: `slack:channel:${paramsLocal.kind}:${paramsLocal.channelId ?? paramsLocal.channelName ?? "unknown"}:${paramsLocal.occurrenceId}`,
    });
  };

  ctx.app.event(
    "channel_created",
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"channel_created"> & AllMiddlewareArgs) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackChannelCreatedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name;
        enqueueChannelSystemEvent({
          kind: "created",
          channelId,
          channelName,
          occurrenceId: resolveSlackSystemEventOccurrenceId({
            body,
            eventTs: payload.event_ts,
          }),
        });
      } catch (err) {
        handleSlackSystemEventFailure({ ctx, context, error: err, label: "channel created" });
      }
    },
  );

  ctx.app.event(
    "channel_rename",
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"channel_rename"> & AllMiddlewareArgs) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackChannelRenamedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name_normalized ?? payload.channel?.name;
        enqueueChannelSystemEvent({
          kind: "renamed",
          channelId,
          channelName,
          occurrenceId: resolveSlackSystemEventOccurrenceId({
            body,
            eventTs: payload.event_ts,
          }),
        });
      } catch (err) {
        handleSlackSystemEventFailure({ ctx, context, error: err, label: "channel rename" });
      }
    },
  );

  ctx.app.event(
    "channel_id_changed",
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"channel_id_changed"> & AllMiddlewareArgs) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackChannelIdChangedEvent;
        const oldChannelId = payload.old_channel_id;
        const newChannelId = payload.new_channel_id;
        if (!oldChannelId || !newChannelId) {
          return;
        }

        const channelInfo = await ctx.resolveChannelName(newChannelId);
        const label = resolveSlackChannelLabel({
          channelId: newChannelId,
          channelName: channelInfo?.name,
        });

        ctx.runtime.log?.(
          warn(`[slack] Channel ID changed: ${oldChannelId} → ${newChannelId} (${label})`),
        );

        if (
          !resolveChannelConfigWrites({
            cfg: ctx.cfg,
            channelId: "slack",
            accountId: ctx.accountId,
          })
        ) {
          ctx.runtime.log?.(
            warn("[slack] Config writes disabled; skipping channel config migration."),
          );
          return;
        }

        const currentConfig = getRuntimeConfig();
        const migration = migrateSlackChannelConfig({
          cfg: currentConfig,
          accountId: ctx.accountId,
          oldChannelId,
          newChannelId,
        });

        if (migration.migrated) {
          migrateSlackChannelConfig({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
            oldChannelId,
            newChannelId,
          });
          await mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate: (draft) => {
              migrateSlackChannelConfig({
                cfg: draft,
                accountId: ctx.accountId,
                oldChannelId,
                newChannelId,
              });
            },
          });
          ctx.runtime.log?.(warn("[slack] Channel config migrated and saved successfully."));
        } else if (migration.skippedExisting) {
          ctx.runtime.log?.(
            warn(
              `[slack] Channel config already exists for ${newChannelId}; leaving ${oldChannelId} unchanged`,
            ),
          );
        } else {
          ctx.runtime.log?.(
            warn(
              `[slack] No config found for old channel ID ${oldChannelId}; migration logged only`,
            ),
          );
        }
      } catch (err) {
        handleSlackSystemEventFailure({
          ctx,
          context,
          error: err,
          label: "channel_id_changed",
        });
      }
    },
  );
}
