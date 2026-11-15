import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import {
  mutateConfigFile,
  readConfigFileSnapshotForWrite,
} from "openclaw/plugin-sdk/config-mutation";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, warn } from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { migrateSlackChannelConfig } from "../../channel-migration.js";
import { resolveSlackChannelLabel } from "../channel-config.js";
import type { SlackMonitorContext } from "../context.js";
import { resolveSlackMonitorEventScope } from "../event-scope.js";
import { resolveSlackIngressTurnLifecycle } from "../ingress.js";
import type { SlackChannelIdChangedEvent, SlackChannelRenamedEvent } from "../types.js";

export function registerSlackChannelEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  for (const [eventName, kind] of [
    ["channel_created", "created"],
    ["channel_rename", "renamed"],
  ] as const) {
    ctx.app.event(
      eventName,
      async (
        args: SlackEventMiddlewareArgs<"channel_created" | "channel_rename"> & AllMiddlewareArgs,
      ) => {
        const { event, body, context, client } = args;
        const eventScope = resolveSlackMonitorEventScope({ ctx, body, context, client });
        if (eventScope === null || ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const channel: SlackChannelRenamedEvent["channel"] = event.channel;
        const channelId = channel?.id;
        const channelName =
          kind === "renamed" ? (channel?.name_normalized ?? channel?.name) : channel?.name;
        const eventId = body.event_id;
        const runtimeContext = await params.ctx.readRuntimeContext();
        if (
          !runtimeContext.isChannelAllowed({
            teamId: eventScope?.teamId ?? runtimeContext.teamId,
            channelId,
            channelName,
            channelType: "channel",
          })
        ) {
          return;
        }

        const label = resolveSlackChannelLabel({
          channelId,
          channelName,
        });
        const route = await runtimeContext.resolveSlackSystemEventRoute({
          channelId,
          channelType: "channel",
          eventScope,
        });
        enqueueRoutedSystemEvent(`Slack channel ${kind}: ${label}.`, route, {
          contextKey: `slack:channel:${eventScope ? `${eventScope.teamId}:` : ""}${kind}:${channelId ?? channelName ?? "unknown"}:${eventId}`,
        });
      },
    );
  }
}

export function registerSlackChannelIdChangedEvent(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

  ctx.app.event(
    "channel_id_changed",
    async ({
      event,
      body,
      context,
    }: SlackEventMiddlewareArgs<"channel_id_changed"> & AllMiddlewareArgs) => {
      const turnAdoptionLifecycle = resolveSlackIngressTurnLifecycle(context);
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

        const { snapshot } = await readConfigFileSnapshotForWrite();
        const previewConfig = structuredClone(snapshot.sourceConfig);
        const preview = migrateSlackChannelConfig({
          cfg: previewConfig,
          accountId: ctx.accountId,
          oldChannelId,
          newChannelId,
        });

        if (preview.migrated) {
          const persisted = await mutateConfigFile({
            baseHash: snapshot.hash ?? undefined,
            afterWrite: { mode: "auto" },
            mutate: (draft) =>
              migrateSlackChannelConfig({
                cfg: draft,
                accountId: ctx.accountId,
                oldChannelId,
                newChannelId,
              }),
          });
          if (persisted.result?.migrated) {
            // The config write publishes the next snapshot; admitted turns retain the old one.
            ctx.runtime.log?.(warn("[slack] Channel config migrated and saved successfully."));
          }
        } else if (preview.skippedExisting) {
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
        ctx.runtime.error?.(
          danger(`slack channel_id_changed handler failed: ${formatErrorMessage(err)}`),
        );
        if (turnAdoptionLifecycle) {
          throw err;
        }
      }
    },
  );
}
