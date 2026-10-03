import type { WebClient } from "@slack/web-api";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSlackLookupClient } from "./client.js";
import { collectSlackCursorPages } from "./cursor-pages.js";
import { resolveWorkspaceQualifiedSlackTarget } from "./target-parsing.js";

export type SlackUserLookup = {
  id: string;
  name: string;
  displayName?: string;
  realName?: string;
  email?: string;
  deleted: boolean;
  isBot: boolean;
  isAppUser: boolean;
};

export type SlackUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  email?: string;
  deleted?: boolean;
  isBot?: boolean;
  note?: string;
};

function parseSlackUserInput(raw: string): { id?: string; name?: string; email?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention) {
    return { id: mention[1]?.toUpperCase() };
  }
  const prefixed = trimmed.replace(/^(slack:|user:)/i, "");
  if (/^[A-Z][A-Z0-9]+$/i.test(prefixed)) {
    return { id: prefixed.toUpperCase() };
  }
  if (trimmed.includes("@") && !trimmed.startsWith("@")) {
    return { email: normalizeLowercaseStringOrEmpty(trimmed) };
  }
  const name = trimmed.replace(/^@/, "").trim();
  return name ? { name } : {};
}

async function listSlackUsers(client: WebClient): Promise<SlackUserLookup[]> {
  return collectSlackCursorPages({
    fetchPage: (cursor) =>
      client.users.list({
        limit: 200,
        cursor,
      }),
    collectPageItems: (res) =>
      (res.members ?? [])
        .map((member) => {
          const id = normalizeOptionalString(member.id);
          const name = normalizeOptionalString(member.name);
          if (!id || !name) {
            return null;
          }
          const profile = member.profile ?? {};
          return {
            id,
            name,
            displayName: normalizeOptionalString(profile.display_name),
            realName:
              normalizeOptionalString(profile.real_name) ??
              normalizeOptionalString(member.real_name),
            email: normalizeOptionalLowercaseString(profile.email),
            deleted: Boolean(member.deleted),
            isBot: Boolean(member.is_bot),
            isAppUser: Boolean(member.is_app_user),
          } satisfies SlackUserLookup;
        })
        .filter((user) => user !== null),
  });
}

function matchesSlackUserName(user: SlackUserLookup, name: string): boolean {
  const target = normalizeLowercaseStringOrEmpty(name);
  return [user.name, user.displayName, user.realName].some((value) => {
    const candidate = normalizeLowercaseStringOrEmpty(value);
    return Boolean(candidate) && candidate === target;
  });
}

function scoreSlackUser(user: SlackUserLookup): number {
  return (user.deleted ? 0 : 3) + (user.isBot || user.isAppUser ? 0 : 2);
}

export async function resolveSlackUserAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackUserResolution[]> {
  const entries = params.entries.map((input) => ({
    input,
    workspace: resolveWorkspaceQualifiedSlackTarget(input, "user"),
    parsed: parseSlackUserInput(input),
  }));
  const users = entries.some(({ workspace }) => !workspace)
    ? await listSlackUsers(params.client ?? createSlackLookupClient(params.token))
    : [];
  return entries.map(({ input, workspace, parsed }) => {
    if (workspace) {
      return workspace;
    }
    const matches = users.filter((user) =>
      parsed.id
        ? user.id === parsed.id
        : parsed.email
          ? user.email === parsed.email
          : parsed.name
            ? matchesSlackUserName(user, parsed.name)
            : false,
    );
    // Every candidate already matches the same id, email, or name. Only account
    // health ranks candidates; equal scores retain Slack's directory order.
    const match = parsed.id
      ? matches[0]
      : matches.toSorted((a, b) => scoreSlackUser(b) - scoreSlackUser(a))[0];
    return parsed.id || match
      ? {
          input,
          resolved: true,
          id: parsed.id ?? match?.id,
          name: match?.displayName ?? match?.realName ?? match?.name,
          email: match?.email,
          deleted: match?.deleted,
          isBot: match?.isBot,
          ...(!parsed.id
            ? { note: matches.length > 1 ? "multiple matches; chose best" : undefined }
            : {}),
        }
      : { input, resolved: false };
  });
}
