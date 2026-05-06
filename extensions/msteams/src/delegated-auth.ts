import { Buffer } from "node:buffer";
import type { OpenClawPluginAuthContext } from "openclaw/plugin-sdk/core";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { getMSTeamsSsoSignInResource, getMSTeamsSsoUserToken, type MSTeamsSsoDeps } from "./sso.js";

type MSTeamsActivity = MSTeamsTurnContext["activity"];

export type MSTeamsDelegatedAuthContextParams = {
  activity: MSTeamsActivity;
  sso?: MSTeamsSsoDeps;
  botAppId?: string;
  sendActivity?: (activity: object) => Promise<unknown>;
  onDebug?: (message: string, meta?: Record<string, unknown>) => void;
  onConsentChallengeError?: (error: unknown) => void;
  onConsentChallengeSent?: () => void;
  now?: () => Date;
};

type CachedToken = {
  token: string;
  expiresAt?: string;
  tokenUserId: string;
};

export const MSTEAMS_DELEGATED_AUTH_PROVIDER = "msteams";

const EXPIRY_SKEW_MS = 30_000;

export function createMSTeamsDelegatedAuthContext(
  params: MSTeamsDelegatedAuthContextParams,
): OpenClawPluginAuthContext {
  const cache = new Map<string, CachedToken>();
  const consentChallenges = new Set<string>();
  const tenantId = resolveTenantId(params.activity);
  const delegatedUserId =
    params.activity.from?.aadObjectId?.trim() || params.activity.from?.id?.trim() || undefined;
  const channelId = params.activity.channelId?.trim() || "msteams";
  const candidateUserIds = uniqueStrings([
    params.activity.from?.aadObjectId,
    params.activity.from?.id,
  ]);

  return {
    getDelegatedAccessToken: async (request) => {
      if (request.provider !== MSTEAMS_DELEGATED_AUTH_PROVIDER) {
        return { ok: false, reason: "not_configured" };
      }
      const sso = params.sso;
      const connectionName = sso?.connectionName?.trim();
      if (!sso || !connectionName) {
        return { ok: false, reason: "not_configured" };
      }
      const requestedConnectionName = request.connectionName?.trim();
      if (requestedConnectionName && requestedConnectionName !== connectionName) {
        return { ok: false, reason: "not_configured" };
      }
      if (candidateUserIds.length === 0) {
        return { ok: false, reason: "unavailable" };
      }

      const cacheKey = `${channelId}\n${connectionName}`;
      const cached = cache.get(cacheKey);
      if (cached && !isTokenExpired(cached, params.now)) {
        if (!matchesRequestedJwtClaims(cached.token, request.audience, request.scopes)) {
          return { ok: false, reason: "unavailable" };
        }
        return {
          ok: true,
          token: cached.token,
          expiresAt: cached.expiresAt,
          tenantId,
          userId: delegatedUserId ?? cached.tokenUserId,
        };
      }

      let missingConsent = false;
      for (const userId of candidateUserIds) {
        const result = await getMSTeamsSsoUserToken({
          user: { userId, channelId },
          connectionName,
          deps: sso,
        });
        if (!result.ok) {
          if (result.code === "missing_consent") {
            missingConsent = true;
            continue;
          }
          params.onDebug?.("msteams delegated auth token request unavailable", {
            code: result.code,
            status: result.status,
          });
          return { ok: false, reason: "unavailable" };
        }

        const resolved: CachedToken = {
          token: result.token,
          expiresAt: result.expiresAt,
          tokenUserId: userId,
        };
        if (isTokenExpired(resolved, params.now)) {
          params.onDebug?.("msteams delegated auth token expired");
          return { ok: false, reason: "expired" };
        }
        if (!matchesRequestedJwtClaims(resolved.token, request.audience, request.scopes)) {
          params.onDebug?.("msteams delegated auth token rejected by requested claims", {
            hasAudience: Boolean(request.audience?.trim()),
            scopeCount: request.scopes?.filter((scope) => scope.trim()).length ?? 0,
          });
          return { ok: false, reason: "unavailable" };
        }
        cache.set(cacheKey, resolved);
        return {
          ok: true,
          token: resolved.token,
          expiresAt: resolved.expiresAt,
          tenantId,
          userId: delegatedUserId ?? resolved.tokenUserId,
        };
      }

      if (missingConsent) {
        await maybeSendConsentChallenge({
          params,
          connectionName,
          cacheKey: `${channelId}\n${connectionName}\n${request.audience ?? ""}\n${(
            request.scopes ?? []
          ).join(" ")}`,
          consentChallenges,
        });
        return { ok: false, reason: "missing_consent" };
      }
      return { ok: false, reason: "unavailable" };
    },
  };
}

async function maybeSendConsentChallenge(params: {
  params: MSTeamsDelegatedAuthContextParams;
  connectionName: string;
  cacheKey: string;
  consentChallenges: Set<string>;
}): Promise<void> {
  if (
    params.consentChallenges.has(params.cacheKey) ||
    !params.params.sso ||
    !params.params.botAppId ||
    !params.params.sendActivity
  ) {
    return;
  }
  params.consentChallenges.add(params.cacheKey);

  const signIn = await getMSTeamsSsoSignInResource({
    activity: params.params.activity,
    appId: params.params.botAppId,
    connectionName: params.connectionName,
    deps: params.params.sso,
  });
  if (!signIn.ok) {
    params.params.onConsentChallengeError?.(
      new Error(
        `OAuth sign-in resource unavailable: ${signIn.code}${
          signIn.status != null ? ` HTTP ${signIn.status}` : ""
        }`,
      ),
    );
    return;
  }

  const consentText =
    "Sign in to allow OpenClaw to use your Microsoft Teams delegated access for this tool.";

  try {
    await params.params.sendActivity({
      type: "message",
      text: `${consentText}\n\n${signIn.signInLink}`,
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.oauth",
          content: {
            text: consentText,
            connectionName: params.connectionName,
            buttons: [
              {
                type: "signin",
                title: "Sign in",
                value: signIn.signInLink,
              },
            ],
            ...(signIn.tokenExchangeResource
              ? { tokenExchangeResource: signIn.tokenExchangeResource }
              : {}),
          },
        },
      ],
    });
    params.params.onConsentChallengeSent?.();
  } catch (err) {
    // The tool result still reports missing_consent; a failed challenge send
    // should not expose token-service details to plugin code.
    params.params.onConsentChallengeError?.(err);
  }
}

function isTokenExpired(token: CachedToken, nowFn: (() => Date) | undefined): boolean {
  const raw = token.expiresAt?.trim();
  if (!raw) {
    return false;
  }
  const expiresAt = Date.parse(raw);
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  const now = (nowFn?.() ?? new Date()).getTime();
  return expiresAt <= now + EXPIRY_SKEW_MS;
}

function matchesRequestedJwtClaims(token: string, audience?: string, scopes?: string[]): boolean {
  const expectedAudience = audience?.trim();
  const expectedScopes = (scopes ?? []).map((scope) => scope.trim()).filter(Boolean);
  if (!expectedAudience && expectedScopes.length === 0) {
    return true;
  }
  const payload = decodeJwtPayload(token);
  if (!payload) {
    return false;
  }
  if (expectedAudience && !claimAudienceMatches(payload.aud, expectedAudience)) {
    return false;
  }
  if (expectedScopes.length > 0) {
    const actualScopes = new Set(readScopeClaim(payload.scp));
    for (const scope of expectedScopes) {
      if (!actualScopes.has(scope)) {
        return false;
      }
    }
  }
  return true;
}

function readScopeClaim(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  return [];
}

function claimAudienceMatches(value: unknown, expected: string): boolean {
  const expectedAudiences = expandAcceptedAudienceValues(expected);
  if (typeof value === "string") {
    return expectedAudiences.has(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === "string" && expectedAudiences.has(entry));
  }
  return false;
}

function expandAcceptedAudienceValues(expected: string): Set<string> {
  const values = new Set([expected]);
  const appId = parseApiSchemeAppId(expected);
  if (appId) {
    values.add(appId);
  } else if (isPlainAppId(expected)) {
    values.add(`api://${expected.trim()}`);
  }
  return values;
}

function parseApiSchemeAppId(value: string): string | undefined {
  const match = /^api:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    value.trim(),
  );
  return match?.[1];
}

function isPlainAppId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) {
    return null;
  }
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function resolveTenantId(activity: MSTeamsActivity): string | undefined {
  return activity.conversation?.tenantId?.trim() || activity.channelData?.tenant?.id?.trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      seen.add(trimmed);
    }
  }
  return [...seen];
}
