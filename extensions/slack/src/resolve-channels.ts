import type { WebClient } from "@slack/web-api";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSlackLookupClient } from "./client.js";
import { collectSlackCursorPages, fetchSlackChannelListPage } from "./cursor-pages.js";
import { resolveWorkspaceQualifiedSlackTarget } from "./target-parsing.js";

export type SlackChannelLookup = {
  id: string;
  name: string;
  archived: boolean;
  isPrivate: boolean;
};

export type SlackChannelResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  archived?: boolean;
};

function parseSlackChannelMention(raw: string): { id?: string; name?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<#([A-Z0-9]+)(?:\|([^>]+))?>$/i);
  if (mention) {
    const id = mention[1]?.toUpperCase();
    const name = mention[2]?.trim();
    return { id, name };
  }
  const prefixed = trimmed.replace(/^(slack:|channel:)/i, "");
  // Slack channel ids are 9+ characters. Keep every C/G-leading token of that length an id, in any
  // case, so an existing folded id never resolves to a namesake room and inherits its policy.
  // Shorter bare names such as "general" fall through to name lookup (#155820); use "#name" to
  // force name lookup for longer ones.
  if (/^[CG][A-Z0-9]{8,}$/i.test(prefixed)) {
    return { id: prefixed.toUpperCase() };
  }
  const name = prefixed.replace(/^#/, "").trim();
  return name ? { name } : {};
}

async function listSlackChannels(client: WebClient): Promise<SlackChannelLookup[]> {
  return collectSlackCursorPages({
    fetchPage: (cursor) => fetchSlackChannelListPage(client, cursor),
    collectPageItems: (res) =>
      (res.channels ?? [])
        .map((channel) => {
          const id = channel.id?.trim();
          const name = channel.name?.trim();
          if (!id || !name) {
            return null;
          }
          return {
            id,
            name,
            archived: Boolean(channel.is_archived),
            isPrivate: Boolean(channel.is_private),
          } satisfies SlackChannelLookup;
        })
        .filter((channel) => channel !== null),
  });
}

function resolveByName(
  name: string,
  channels: readonly SlackChannelLookup[],
): SlackChannelLookup | undefined {
  const target = normalizeLowercaseStringOrEmpty(name);
  if (!target) {
    return undefined;
  }
  const matches = channels.filter(
    (channel) => normalizeLowercaseStringOrEmpty(channel.name) === target,
  );
  return matches.find((channel) => !channel.archived) ?? matches[0];
}

export async function resolveSlackChannelAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackChannelResolution[]> {
  const entries = params.entries.map((input) => ({
    input,
    workspace: resolveWorkspaceQualifiedSlackTarget(input, "channel"),
    parsed: parseSlackChannelMention(input),
  }));
  if (entries.every(({ workspace, parsed }) => workspace || parsed.id)) {
    return entries.map(
      ({ input, workspace, parsed }) =>
        workspace ?? { input, resolved: true, id: parsed.id, name: parsed.name },
    );
  }
  const client = params.client ?? createSlackLookupClient(params.token);
  const channels = await listSlackChannels(client);
  return entries.map(({ input, workspace, parsed }) => {
    if (workspace) {
      return workspace;
    }
    const match = parsed.id
      ? channels.find((channel) => channel.id === parsed.id)
      : parsed.name
        ? resolveByName(parsed.name, channels)
        : undefined;
    return parsed.id || match
      ? {
          input,
          resolved: true,
          id: parsed.id ?? match?.id,
          name: match?.name ?? parsed.name,
          archived: match?.archived,
        }
      : { input, resolved: false };
  });
}
