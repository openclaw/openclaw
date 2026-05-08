import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveOpenClawAgentDir } from "openclaw/plugin-sdk/provider-auth";
import {
  GMAIL_PROVIDER_ID,
  listGmailStoredProfiles,
  persistGmailRefresh,
  resolveStoredGmailCredential,
  storeGmailOAuthCredentials,
} from "./gmail-auth-store.js";
import { createGmailClient } from "./gmail-client.js";
import { buildGmailAuthUrl, exchangeGmailCodeForTokens } from "./gmail-oauth.js";
import type { GmailDraftMessageInput, GmailSearchParams } from "./gmail-types.js";
import { resolveGooglePersonalOAuthIdentity } from "./oauth.project.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

type GatewayMethodContext = Parameters<
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]
>[0];
type GatewayRespond = GatewayMethodContext["respond"];

function readStringParam(params: Record<string, unknown>, key: string): string | undefined;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true },
): string;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: boolean },
): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (options?.required) {
    throw new Error(`${key} is required.`);
  }
  return undefined;
}

function readNumberParam(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return undefined;
}

function readStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

function respondError(respond: GatewayRespond, error: unknown) {
  respond(false, undefined, { code: "internal_error", message: formatErrorMessage(error) });
}

async function withGmailClient<T>(params: {
  agentDir: string;
  profileId?: string;
  run: (client: ReturnType<typeof createGmailClient>, resolvedProfileId: string) => Promise<T>;
}): Promise<T> {
  const resolved = resolveStoredGmailCredential({
    agentDir: params.agentDir,
    profileId: params.profileId,
  });

  const client = createGmailClient({
    auth: {
      accessToken: resolved.credential.access,
      refreshToken: resolved.credential.refresh,
      expiresAt: resolved.credential.expires,
    },
    onTokenRefresh: async (refreshed) => {
      await persistGmailRefresh({
        agentDir: params.agentDir,
        profileId: resolved.profileId,
        credential: {
          ...resolved.credential,
          access: refreshed.access,
          refresh: refreshed.refresh,
          expires: refreshed.expires,
          ...(refreshed.email ? { email: refreshed.email } : {}),
        },
      });
    },
  });

  return await params.run(client, resolved.profileId);
}

function readSearchParams(params: Record<string, unknown>): GmailSearchParams {
  return {
    ...(readStringParam(params, "query") ? { query: readStringParam(params, "query") } : {}),
    ...(readStringParam(params, "from") ? { from: readStringParam(params, "from") } : {}),
    ...(readStringParam(params, "to") ? { to: readStringParam(params, "to") } : {}),
    ...(readStringParam(params, "subject") ? { subject: readStringParam(params, "subject") } : {}),
    ...(readStringParam(params, "label") ? { label: readStringParam(params, "label") } : {}),
    ...(readStringParam(params, "after") ? { after: readStringParam(params, "after") } : {}),
    ...(readStringParam(params, "before") ? { before: readStringParam(params, "before") } : {}),
    ...(readBooleanParam(params, "isUnread") !== undefined
      ? { isUnread: readBooleanParam(params, "isUnread") }
      : {}),
    ...(readBooleanParam(params, "inInbox") !== undefined
      ? { inInbox: readBooleanParam(params, "inInbox") }
      : {}),
    ...(readBooleanParam(params, "hasAttachment") !== undefined
      ? { hasAttachment: readBooleanParam(params, "hasAttachment") }
      : {}),
  };
}

function readDraftInput(params: Record<string, unknown>): GmailDraftMessageInput {
  return {
    to: readStringParam(params, "to", { required: true }),
    subject: readStringParam(params, "subject", { required: true }),
    ...(readStringParam(params, "textBody")
      ? { textBody: readStringParam(params, "textBody") }
      : {}),
    ...(readStringParam(params, "htmlBody")
      ? { htmlBody: readStringParam(params, "htmlBody") }
      : {}),
    ...(readStringArrayParam(params, "cc") ? { cc: readStringArrayParam(params, "cc") } : {}),
    ...(readStringArrayParam(params, "bcc") ? { bcc: readStringArrayParam(params, "bcc") } : {}),
    ...(readStringParam(params, "threadId")
      ? { threadId: readStringParam(params, "threadId") }
      : {}),
    ...(readStringParam(params, "inReplyTo")
      ? { inReplyTo: readStringParam(params, "inReplyTo") }
      : {}),
    ...(readStringArrayParam(params, "references")
      ? { references: readStringArrayParam(params, "references") }
      : {}),
  };
}

export function registerGmailGatewayMethods(api: OpenClawPluginApi) {
  const agentDir = resolveOpenClawAgentDir();

  api.registerGatewayMethod(
    "gmail.auth.status",
    async ({ respond }) => {
      try {
        const profiles = listGmailStoredProfiles(agentDir);
        respond(true, {
          providerId: GMAIL_PROVIDER_ID,
          connected: profiles.length > 0,
          profiles,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "gmail.auth.url",
    async ({ params, respond }) => {
      try {
        const challenge = readStringParam(params, "challenge", { required: true });
        const state = readStringParam(params, "state", { required: true });
        const redirectUri = readStringParam(params, "redirectUri");
        respond(true, {
          providerId: GMAIL_PROVIDER_ID,
          url: buildGmailAuthUrl({ challenge, state, redirectUri }),
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "gmail.auth.exchange",
    async ({ params, respond }) => {
      try {
        const code = readStringParam(params, "code", { required: true });
        const verifier = readStringParam(params, "verifier", { required: true });
        const redirectUri = readStringParam(params, "redirectUri");
        const token = await exchangeGmailCodeForTokens({ code, verifier, redirectUri });
        const identity = await resolveGooglePersonalOAuthIdentity(token.access);
        const profileId = await storeGmailOAuthCredentials({
          agentDir,
          access: token.access,
          refresh: token.refresh,
          expires: token.expires,
          email: identity.email,
        });
        respond(true, {
          providerId: GMAIL_PROVIDER_ID,
          profileId,
          email: identity.email,
          expires: token.expires,
        });
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "gmail.messages.list",
    async ({ params, respond }) => {
      try {
        const result = await withGmailClient({
          agentDir,
          profileId: readStringParam(params, "profileId"),
          run: async (client, resolvedProfileId) => ({
            profileId: resolvedProfileId,
            ...(await client.listMessages({
              maxResults: readNumberParam(params, "maxResults"),
              pageToken: readStringParam(params, "pageToken"),
              query: readStringParam(params, "query"),
              labelIds: readStringArrayParam(params, "labelIds"),
              includeSpamTrash: readBooleanParam(params, "includeSpamTrash"),
            })),
          }),
        });
        respond(true, result);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "gmail.messages.search",
    async ({ params, respond }) => {
      try {
        const result = await withGmailClient({
          agentDir,
          profileId: readStringParam(params, "profileId"),
          run: async (client, resolvedProfileId) => ({
            profileId: resolvedProfileId,
            ...(await client.searchMessages({
              ...readSearchParams(params),
              maxResults: readNumberParam(params, "maxResults"),
              pageToken: readStringParam(params, "pageToken"),
            })),
          }),
        });
        respond(true, result);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "gmail.messages.get",
    async ({ params, respond }) => {
      try {
        const result = await withGmailClient({
          agentDir,
          profileId: readStringParam(params, "profileId"),
          run: async (client, resolvedProfileId) => ({
            profileId: resolvedProfileId,
            message: await client.getMessage(
              readStringParam(params, "id", { required: true }),
              (readStringParam(params, "format") as
                | "full"
                | "metadata"
                | "minimal"
                | "raw"
                | undefined) ?? "full",
            ),
          }),
        });
        respond(true, result);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "gmail.threads.get",
    async ({ params, respond }) => {
      try {
        const result = await withGmailClient({
          agentDir,
          profileId: readStringParam(params, "profileId"),
          run: async (client, resolvedProfileId) => ({
            profileId: resolvedProfileId,
            thread: await client.getThread(
              readStringParam(params, "id", { required: true }),
              (readStringParam(params, "format") as "full" | "metadata" | "minimal" | undefined) ??
                "full",
            ),
          }),
        });
        respond(true, result);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: READ_SCOPE },
  );

  api.registerGatewayMethod(
    "gmail.drafts.create",
    async ({ params, respond }) => {
      try {
        const result = await withGmailClient({
          agentDir,
          profileId: readStringParam(params, "profileId"),
          run: async (client, resolvedProfileId) => ({
            profileId: resolvedProfileId,
            draft: await client.createDraft(readDraftInput(params)),
          }),
        });
        respond(true, result);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "gmail.messages.send",
    async ({ params, respond }) => {
      try {
        const result = await withGmailClient({
          agentDir,
          profileId: readStringParam(params, "profileId"),
          run: async (client, resolvedProfileId) => ({
            profileId: resolvedProfileId,
            message: await client.sendMessage(readDraftInput(params)),
          }),
        });
        respond(true, result);
      } catch (error) {
        respondError(respond, error);
      }
    },
    { scope: WRITE_SCOPE },
  );
}
