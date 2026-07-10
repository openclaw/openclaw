// Slack plugin module implements home behavior.
import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { HomeView } from "@slack/types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { mergeSlackAccountConfig } from "../../accounts.js";
import { validateSlackBlocksArray } from "../../blocks-input.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackAppHomeOpenedEvent } from "../types.js";

// Slack Home tabs accept up to 100 blocks (message payloads cap at SLACK_MAX_BLOCKS).
const SLACK_APP_HOME_MAX_BLOCKS = 100;

function buildSlackHomeView(slashCommandName?: string): HomeView {
  const startSessionText = slashCommandName
    ? `Send a DM, mention OpenClaw in a channel, or use \`/${slashCommandName}\` to start a session.`
    : "Send a DM or mention OpenClaw in a channel to start a session.";
  return {
    type: "home",
    callback_id: "openclaw:home",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "OpenClaw",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: startSessionText,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "This Home tab is safe to show to any workspace member who opens the app.",
          },
        ],
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeSlackHomeView(raw: unknown): HomeView {
  if (!isRecord(raw)) {
    throw new Error("Slack App Home view must be an object");
  }
  if (raw.type !== undefined && raw.type !== "home") {
    throw new Error('Slack App Home view type must be "home"');
  }
  return {
    ...raw,
    type: "home",
    blocks: validateSlackBlocksArray(raw.blocks, { maxBlocks: SLACK_APP_HOME_MAX_BLOCKS }),
  } as HomeView;
}

// Inline views come from account-merged config only, so edits follow the normal
// config reload/account lifecycle; invalid content falls back to the built-in
// safe view instead of breaking the Home tab.
function resolveSlackCustomHomeView(ctx: SlackMonitorContext): HomeView | undefined {
  const view = mergeSlackAccountConfig(ctx.cfg, ctx.accountId).appHome?.view;
  if (view === undefined) {
    return undefined;
  }
  try {
    return normalizeSlackHomeView(view);
  } catch (err) {
    ctx.runtime.error?.(danger(`slack app home view config failed: ${formatErrorMessage(err)}`));
    return undefined;
  }
}

export function registerSlackHomeEvents(params: {
  ctx: SlackMonitorContext;
  slashCommandName?: string;
  trackEvent?: () => void;
}) {
  const { ctx, slashCommandName, trackEvent } = params;

  ctx.app.event(
    "app_home_opened",
    async ({ event, body }: SlackEventMiddlewareArgs<"app_home_opened">) => {
      try {
        if (ctx.shouldDropMismatchedSlackEvent(body)) {
          return;
        }
        trackEvent?.();

        const payload = event as SlackAppHomeOpenedEvent;
        if (!payload.user || payload.tab === "messages") {
          return;
        }
        const userId = payload.user;

        const publishHomeView = (view: HomeView) =>
          ctx.app.client.views.publish({
            token: ctx.botToken,
            user_id: userId,
            view,
          });

        const customView = resolveSlackCustomHomeView(ctx);
        if (customView) {
          try {
            await publishHomeView(customView);
            return;
          } catch (err) {
            // Local validation is shallow, so Slack can still reject configured
            // blocks; keep the Home tab working with the built-in view.
            ctx.runtime.error?.(
              danger(`slack app home custom view publish failed: ${formatErrorMessage(err)}`),
            );
          }
        }
        await publishHomeView(buildSlackHomeView(slashCommandName));
      } catch (err) {
        ctx.runtime.error?.(danger(`slack app home handler failed: ${formatErrorMessage(err)}`));
      }
    },
  );
}
