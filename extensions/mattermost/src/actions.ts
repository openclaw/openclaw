import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "openclaw/plugin-sdk";
import { listEnabledMattermostAccounts, resolveMattermostAccount } from "./mattermost/accounts.js";
import {
  createMattermostClient,
  fetchChannelPosts,
  fetchMattermostChannel,
  fetchTeamChannels,
  searchPosts,
} from "./mattermost/client.js";
import { sendMessageMattermost } from "./mattermost/send.js";

const providerId = "mattermost";

type EnabledAccounts = ReturnType<typeof listEnabledMattermostAccounts>;

function isGateEnabled(accounts: EnabledAccounts, cfg: OpenClawConfig, key: string): boolean {
  for (const account of accounts) {
    const gate = createActionGate(
      (account.config.actions ??
        (cfg.channels?.["mattermost"] as { actions?: unknown })?.actions) as Record<
        string,
        boolean | undefined
      >,
    );
    if (gate(key)) {
      return true;
    }
  }
  return false;
}

function resolveClient(cfg: OpenClawConfig, accountId?: string | null) {
  const account = resolveMattermostAccount({ cfg, accountId });
  if (!account.botToken || !account.baseUrl) {
    throw new Error("Mattermost credentials are missing.");
  }
  return createMattermostClient({
    baseUrl: account.baseUrl,
    botToken: account.botToken,
  });
}

export const mattermostMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledMattermostAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    const actions = new Set<ChannelMessageActionName>([]);
    actions.add("send");
    if (isGateEnabled(accounts, cfg, "messages")) {
      actions.add("read");
    }
    if (isGateEnabled(accounts, cfg, "search")) {
      actions.add("search");
    }
    if (isGateEnabled(accounts, cfg, "channelInfo")) {
      actions.add("channel-list");
      actions.add("channel-info");
    }
    return Array.from(actions);
  },

  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "sendMessage") {
      return null;
    }
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) {
      return null;
    }
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },

  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const to = readStringParam(params, "to", { required: true });
      const message = readStringParam(params, "message", { required: true, allowEmpty: true });
      const mediaUrl = readStringParam(params, "media", { trim: false });
      const result = await sendMessageMattermost(to, message, {
        accountId: accountId ?? undefined,
        mediaUrl: mediaUrl ?? undefined,
      });
      return jsonResult({ ok: true, ...result });
    }

    const client = resolveClient(cfg, accountId);

    if (action === "read") {
      const channelId =
        readStringParam(params, "channelId") ?? readStringParam(params, "to", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const before = readStringParam(params, "before");
      const after = readStringParam(params, "after");
      const since = readNumberParam(params, "since", { integer: true });
      const posts = await fetchChannelPosts(client, channelId, {
        limit: limit ?? undefined,
        before: before ?? undefined,
        after: after ?? undefined,
        since: since ?? undefined,
      });
      return jsonResult({ ok: true, posts });
    }

    if (action === "search") {
      const query = readStringParam(params, "query", { required: true });
      const teamId = readStringParam(params, "teamId", { required: true });
      const channelId = readStringParam(params, "channelId");
      const authorId = readStringParam(params, "authorId");
      const posts = await searchPosts(client, teamId, query, {
        channelId: channelId ?? undefined,
        authorId: authorId ?? undefined,
      });
      return jsonResult({ ok: true, posts });
    }

    if (action === "channel-list") {
      const teamId = readStringParam(params, "teamId", { required: true });
      const channels = await fetchTeamChannels(client, teamId);
      return jsonResult({ ok: true, channels });
    }

    if (action === "channel-info") {
      const channelId = readStringParam(params, "channelId", { required: true });
      const channel = await fetchMattermostChannel(client, channelId);
      return jsonResult({ ok: true, channel });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
