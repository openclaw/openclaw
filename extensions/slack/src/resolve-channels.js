import { createSlackWebClient } from "./client.js";
import {
  collectSlackCursorItems,
  resolveSlackAllowlistEntries
} from "./resolve-allowlist-common.js";
function parseSlackChannelMention(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<#([A-Z0-9]+)(?:\|([^>]+))?>$/i);
  if (mention) {
    const id = mention[1]?.toUpperCase();
    const name2 = mention[2]?.trim();
    return { id, name: name2 };
  }
  const prefixed = trimmed.replace(/^(slack:|channel:)/i, "");
  if (/^[CG][A-Z0-9]+$/i.test(prefixed)) {
    return { id: prefixed.toUpperCase() };
  }
  const name = prefixed.replace(/^#/, "").trim();
  return name ? { name } : {};
}
async function listSlackChannels(client) {
  return collectSlackCursorItems({
    fetchPage: async (cursor) => await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1e3,
      cursor
    }),
    collectPageItems: (res) => (res.channels ?? []).map((channel) => {
      const id = channel.id?.trim();
      const name = channel.name?.trim();
      if (!id || !name) {
        return null;
      }
      return {
        id,
        name,
        archived: Boolean(channel.is_archived),
        isPrivate: Boolean(channel.is_private)
      };
    }).filter(Boolean)
  });
}
function resolveByName(name, channels) {
  const target = name.trim().toLowerCase();
  if (!target) {
    return void 0;
  }
  const matches = channels.filter((channel) => channel.name.toLowerCase() === target);
  if (matches.length === 0) {
    return void 0;
  }
  const active = matches.find((channel) => !channel.archived);
  return active ?? matches[0];
}
async function resolveSlackChannelAllowlist(params) {
  const client = params.client ?? createSlackWebClient(params.token);
  const channels = await listSlackChannels(client);
  return resolveSlackAllowlistEntries({
    entries: params.entries,
    lookup: channels,
    parseInput: parseSlackChannelMention,
    findById: (lookup, id) => lookup.find((channel) => channel.id === id),
    buildIdResolved: ({ input, parsed, match }) => ({
      input,
      resolved: true,
      id: parsed.id,
      name: match?.name ?? parsed.name,
      archived: match?.archived
    }),
    resolveNonId: ({ input, parsed, lookup }) => {
      if (!parsed.name) {
        return void 0;
      }
      const match = resolveByName(parsed.name, lookup);
      if (!match) {
        return void 0;
      }
      return {
        input,
        resolved: true,
        id: match.id,
        name: match.name,
        archived: match.archived
      };
    },
    buildUnresolved: (input) => ({ input, resolved: false })
  });
}
export {
  resolveSlackChannelAllowlist
};
