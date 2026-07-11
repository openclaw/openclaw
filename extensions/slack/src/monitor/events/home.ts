// Slack plugin module implements home behavior.
import type { SlackEventMiddlewareArgs } from "@slack/bolt";
import type { HomeView } from "@slack/types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  normalizeUniqueTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackEffectiveAllowFrom } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import { authorizeSlackDirectMessage } from "../dm-auth.js";
import type { SlackAppHomeOpenedEvent } from "../types.js";

const SLACK_HOME_CALLBACK_ID = "openclaw:home";
const SLACK_HOME_GROUP_DM_BLOCK_ID = "openclaw:home:group-members";
const SLACK_HOME_GROUP_DM_SELECT_ACTION_ID = "openclaw:home:group-members";
export const SLACK_HOME_GROUP_DM_ACTION_ID = "openclaw:home:open-group-dm";

type SlackHomeGroupDmStatus =
  | {
      kind: "error";
      message: string;
      initialUsers?: string[];
    }
  | {
      kind: "success";
      channelId: string;
      starterMessageFailed: boolean;
    };

type SlackHomeActionBody = {
  user?: { id?: string };
  view?: { callback_id?: string };
  state?: { values?: unknown };
};

function isSlackHomeGroupDmEnabled(ctx: SlackMonitorContext): boolean {
  const allowsNewGroupDm =
    ctx.groupDmChannels.length === 0 || ctx.groupDmChannels.some((entry) => entry.trim() === "*");
  return ctx.dmEnabled && ctx.dmPolicy !== "disabled" && ctx.groupDmEnabled && allowsNewGroupDm;
}

function readSlackHomeSelectedUsers(body: SlackHomeActionBody): string[] {
  const values = body.state?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return [];
  }
  const block = (values as Record<string, unknown>)[SLACK_HOME_GROUP_DM_BLOCK_ID];
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return [];
  }
  const action = (block as Record<string, unknown>)[SLACK_HOME_GROUP_DM_SELECT_ACTION_ID];
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return [];
  }
  const selectedUsers = (action as { selected_users?: unknown }).selected_users;
  if (!Array.isArray(selectedUsers)) {
    return [];
  }
  return normalizeUniqueTrimmedStringList(
    selectedUsers.filter((entry): entry is string => typeof entry === "string"),
  );
}

function buildSlackHomeStatusBlock(params: {
  status: SlackHomeGroupDmStatus;
  teamId: string;
}): HomeView["blocks"][number] {
  if (params.status.kind === "error") {
    return {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:warning: ${params.status.message}`,
      },
    };
  }
  const groupDmUrl = `https://slack.com/app_redirect?team=${encodeURIComponent(params.teamId)}&channel=${encodeURIComponent(params.status.channelId)}`;
  const message = params.status.starterMessageFailed
    ? `:warning: Group DM is ready, but OpenClaw could not post its starter message. <${groupDmUrl}|Open it in Slack>.`
    : `:white_check_mark: Group DM is ready. <${groupDmUrl}|Open it in Slack>.`;
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: message,
    },
  };
}

export function buildSlackHomeView(params?: {
  groupDmEnabled?: boolean;
  groupDmStatus?: SlackHomeGroupDmStatus;
  teamId?: string;
}): HomeView {
  const blocks: HomeView["blocks"] = [
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
        text: "Send a DM, mention OpenClaw in a channel, or use `/openclaw` to start a session.",
      },
    },
  ];
  if (params?.groupDmStatus) {
    blocks.push(
      buildSlackHomeStatusBlock({
        status: params.groupDmStatus,
        teamId: params.teamId ?? "",
      }),
    );
  }
  if (params?.groupDmEnabled) {
    const initialUsers =
      params.groupDmStatus?.kind === "error" ? params.groupDmStatus.initialUsers : undefined;
    blocks.push(
      {
        type: "input",
        block_id: SLACK_HOME_GROUP_DM_BLOCK_ID,
        dispatch_action: false,
        label: {
          type: "plain_text",
          text: "Who else?",
        },
        hint: {
          type: "plain_text",
          text: "Choose 1–7 people. You and OpenClaw are included; everyone in the group can use the agent.",
        },
        element: {
          type: "multi_users_select",
          action_id: SLACK_HOME_GROUP_DM_SELECT_ACTION_ID,
          placeholder: {
            type: "plain_text",
            text: "Choose people",
          },
          max_selected_items: 7,
          ...(initialUsers?.length ? { initial_users: initialUsers } : {}),
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: SLACK_HOME_GROUP_DM_ACTION_ID,
            style: "primary",
            text: {
              type: "plain_text",
              text: "Open group DM",
            },
          },
        ],
      },
    );
  }
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "This Home tab is safe to show to any workspace member who opens the app.",
      },
    ],
  });
  return {
    type: "home",
    callback_id: SLACK_HOME_CALLBACK_ID,
    blocks,
  };
}

async function publishSlackHomeView(params: {
  ctx: SlackMonitorContext;
  userId: string;
  status?: SlackHomeGroupDmStatus;
}): Promise<void> {
  await params.ctx.app.client.views.publish({
    token: params.ctx.botToken,
    user_id: params.userId,
    view: buildSlackHomeView({
      groupDmEnabled: isSlackHomeGroupDmEnabled(params.ctx),
      groupDmStatus: params.status,
      teamId: params.ctx.teamId,
    }),
  });
}

async function publishSlackHomeActionStatus(params: {
  ctx: SlackMonitorContext;
  userId: string;
  status: SlackHomeGroupDmStatus;
}): Promise<void> {
  try {
    await publishSlackHomeView(params);
  } catch (error) {
    params.ctx.runtime.error?.(
      danger(`slack app home update failed: ${formatErrorMessage(error)}`),
    );
  }
}

export async function handleSlackHomeBlockAction(params: {
  ctx: SlackMonitorContext;
  actionId: string;
  body: unknown;
}): Promise<boolean> {
  if (params.actionId !== SLACK_HOME_GROUP_DM_ACTION_ID) {
    return false;
  }
  const body = params.body as SlackHomeActionBody;
  if (body.view?.callback_id !== SLACK_HOME_CALLBACK_ID) {
    return false;
  }

  const userId = normalizeOptionalString(body.user?.id);
  if (!userId) {
    params.ctx.runtime.log?.("slack:app-home drop group DM action reason=missing-user");
    return true;
  }
  const selectedUsers = readSlackHomeSelectedUsers(body);
  const publishError = (message: string, initialUsers?: string[]) =>
    publishSlackHomeActionStatus({
      ctx: params.ctx,
      userId,
      status: {
        kind: "error",
        message,
        initialUsers,
      },
    });
  if (!isSlackHomeGroupDmEnabled(params.ctx)) {
    await publishError("Group DM creation is not enabled for this Slack account.");
    return true;
  }

  // MPIM access is conversation-scoped. With unrestricted group IDs enabled,
  // the authorized creator's explicit selection defines who can use the agent there.
  const initialUsers = selectedUsers.filter(
    (selectedUserId) => selectedUserId !== userId && selectedUserId !== params.ctx.botUserId,
  );
  const allowFromLower = await resolveSlackEffectiveAllowFrom(params.ctx, {
    includePairingStore: true,
  });
  const creatorAllowed = await authorizeSlackDirectMessage({
    ctx: params.ctx,
    accountId: params.ctx.accountId,
    senderId: userId,
    allowFromLower,
    resolveSenderName: params.ctx.resolveUserName,
    sendPairingReply: async (text) => {
      await publishError(text, initialUsers);
    },
    onDisabled: async () => {
      await publishError("Slack DMs are disabled for this account.", initialUsers);
    },
    onUnauthorized: async ({ allowMatchMeta }) => {
      params.ctx.runtime.log?.(
        `slack:app-home drop group DM action user=${userId} dmPolicy=${params.ctx.dmPolicy} ${allowMatchMeta}`,
      );
      await publishError(
        "You are not authorized to open an OpenClaw group DM. Ask an administrator for access.",
        initialUsers,
      );
    },
    log: (message) => params.ctx.runtime.log?.(message),
  });
  if (!creatorAllowed) {
    return true;
  }
  if (initialUsers.length === 0) {
    await publishError("Choose at least one other person.");
    return true;
  }
  if (initialUsers.length > 7) {
    await publishError("Choose no more than seven other people.", initialUsers.slice(0, 7));
    return true;
  }

  try {
    const response = await params.ctx.app.client.conversations.open({
      token: params.ctx.botToken,
      users: [userId, ...initialUsers].join(","),
      return_im: true,
    });
    const channelId = normalizeOptionalString(response.channel?.id);
    if (!channelId) {
      throw new Error("Slack conversations.open returned no conversation ID");
    }

    let starterMessageFailed = false;
    // Exact member sets resume an existing MPIM; only a genuinely new one gets a starter message.
    if (response.already_open !== true) {
      try {
        /* eslint-disable unicorn/require-post-message-target-origin -- Slack Web API, not Window.postMessage. */
        await params.ctx.app.client.chat.postMessage({
          token: params.ctx.botToken,
          channel: channelId,
          text: "OpenClaw is ready in this group DM. Send a message here to start.",
        });
        /* eslint-enable unicorn/require-post-message-target-origin */
      } catch (error) {
        starterMessageFailed = true;
        params.ctx.runtime.error?.(
          danger(`slack group DM starter message failed: ${formatErrorMessage(error)}`),
        );
      }
    }
    await publishSlackHomeActionStatus({
      ctx: params.ctx,
      userId,
      status: {
        kind: "success",
        channelId,
        starterMessageFailed,
      },
    });
  } catch (error) {
    params.ctx.runtime.error?.(
      danger(`slack app home group DM failed: ${formatErrorMessage(error)}`),
    );
    await publishError(
      "Slack could not open that group DM. Check app permissions and participant access, then try again.",
      initialUsers,
    );
  }
  return true;
}

export function registerSlackHomeEvents(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
}) {
  const { ctx, trackEvent } = params;

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

        await publishSlackHomeView({ ctx, userId: payload.user });
      } catch (err) {
        ctx.runtime.error?.(danger(`slack app home handler failed: ${formatErrorMessage(err)}`));
      }
    },
  );
}
