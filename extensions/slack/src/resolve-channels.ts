import type { WebClient } from "@slack/web-api";
import { resolveDirectoryAllowlistEntries } from "openclaw/plugin-sdk/directory-runtime";
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

// Slack conversation ids are at least 9 characters: C = public channel,
// G = private channel, D = direct message. Canonical ids are uppercase;
// lowercase folded ids are unambiguous only when the second character is a
// digit, which is the convention the Slack doctor already repairs.
const SLACK_CANONICAL_CONVERSATION_ID_RE = /^[CDG][A-Z0-9]{8,}$/;
const SLACK_LOWERCASE_CONVERSATION_ID_RE = /^[cdg][0-9][a-z0-9]{7,}$/;

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
  if (
    SLACK_CANONICAL_CONVERSATION_ID_RE.test(prefixed) ||
    SLACK_LOWERCASE_CONVERSATION_ID_RE.test(prefixed)
  ) {
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
        .filter(Boolean) as SlackChannelLookup[],
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
  if (matches.length === 0) {
    return undefined;
  }
  const active = matches.find((channel) => !channel.archived);
  return active ?? matches[0];
}

export async function resolveSlackChannelAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackChannelResolution[]> {
  const workspaceResolved = params.entries.map((input) =>
    resolveWorkspaceQualifiedSlackTarget(input, "channel"),
  );
  const lookupEntries = params.entries.filter((_, index) => !workspaceResolved[index]);
  if (lookupEntries.length === 0) {
    return workspaceResolved.filter((entry) => entry !== undefined);
  }
  const parsedEntries = lookupEntries.map((input) => ({
    input,
    parsed: parseSlackChannelMention(input),
  }));
  if (parsedEntries.every((entry) => Boolean(entry.parsed.id))) {
    const resolved = parsedEntries.map(({ input, parsed }) => ({
      input,
      resolved: true,
      id: parsed.id,
      name: parsed.name,
    }));
    let resolvedIndex = 0;
    return workspaceResolved.map((entry) => entry ?? resolved[resolvedIndex++]!);
  }
  const client = params.client ?? createSlackLookupClient(params.token);
  const channels = await listSlackChannels(client);
  const resolved = resolveDirectoryAllowlistEntries<
    { id?: string; name?: string },
    SlackChannelLookup,
    SlackChannelResolution
  >({
    entries: lookupEntries,
    lookup: channels,
    parseInput: parseSlackChannelMention,
    findById: (lookup, id) => lookup.find((channel) => channel.id === id),
    buildIdResolved: ({ input, parsed, match }) => ({
      input,
      resolved: true,
      id: parsed.id,
      name: match?.name ?? parsed.name,
      archived: match?.archived,
    }),
    resolveNonId: ({ input, parsed, lookup }) => {
      if (!parsed.name) {
        return undefined;
      }
      const match = resolveByName(parsed.name, lookup);
      if (!match) {
        return undefined;
      }
      return {
        input,
        resolved: true,
        id: match.id,
        name: match.name,
        archived: match.archived,
      };
    },
    buildUnresolved: (input) => ({ input, resolved: false }),
  });
  let resolvedIndex = 0;
  return workspaceResolved.map((entry) => entry ?? resolved[resolvedIndex++]!);
}
