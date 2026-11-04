import type { ControlUiLinkReaderSection } from "openclaw/plugin-sdk/control-ui-link-reader";
import { resolveAgentIdOrRespondError } from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlers,
} from "openclaw/plugin-sdk/gateway-runtime";
import { captureNativeGitHubSessionRequestRead as captureRepositorySessionRequestRead } from "openclaw/plugin-sdk/native-github-session-read";
import type { ControlUiSessionPullRequestChecksParams } from "../control-ui-session-pr-check-details-api.js";
import { parseControlUiSessionPullRequestsSubscribeParams } from "../control-ui-session-pr-subscription-params-api.js";
import {
  gitHubPublicApi,
  type ControlUiGitHubPreviewIdentity,
  type ControlUiGitHubSessionIdentity,
} from "../public-api.js";
import {
  GitHubReadRequestInactiveError,
  prepareControlUiGitHubIdentity,
} from "../reader-identity-api.js";
import { withControlUiSessionGitHubRead } from "../session-item-read-api.js";
import { GitHubIdentityError } from "../tool-identity-api.js";

function createGitHubReadHandler<
  T extends NonNullable<ReturnType<typeof gitHubPublicApi.parseGitHubTarget>>,
>(
  method: string,
  parseTarget: (params: unknown) => T | null,
  load: (
    target: T,
    identity?: ControlUiGitHubPreviewIdentity,
    fetchImpl?: typeof fetch,
    refresh?: boolean,
    section?: ControlUiLinkReaderSection,
  ) => Promise<unknown>,
  loadSession: (
    target: T,
    identity: ControlUiGitHubSessionIdentity,
    fetchImpl?: typeof fetch,
    refresh?: boolean,
    section?: ControlUiLinkReaderSection,
  ) => Promise<unknown>,
): GatewayRequestHandlers[string] {
  return async (options) => {
    const { params, respond, context } = options;
    const target = parseTarget(params);
    const section = params.section;
    if (
      !target ||
      (params.refresh !== undefined && typeof params.refresh !== "boolean") ||
      (section !== undefined &&
        (method !== "controlUi.githubDetail" ||
          (section !== "overview" &&
            section !== "checks" &&
            section !== "files" &&
            section !== "discussion")))
    ) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params`));
      return;
    }
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId,
      respond,
      cfg: context.getRuntimeConfig(),
    });
    if (!resolved) {
      return;
    }
    const startedAt = performance.now();
    let preparedAt: number | undefined;
    try {
      if (params.sessionKey !== undefined || params.githubHost !== undefined) {
        await withControlUiSessionGitHubRead(
          options,
          resolved.agentId,
          target,
          (identity) => loadSession(target, identity, undefined, params.refresh === true, section),
          (result) => respond(true, result, undefined),
        );
        return;
      }
      const { identity, assertSelected } = await prepareControlUiGitHubIdentity(
        options,
        resolved.agentId,
        `${target.owner}/${target.repo}`,
      );
      let result;
      try {
        assertSelected();
        preparedAt = performance.now();
        result = await load(target, identity, undefined, params.refresh === true, section);
        assertSelected();
      } finally {
        await identity?.revoke?.();
      }
      assertSelected();
      respond(true, result, undefined);
    } catch (error) {
      const { message, ...details } =
        error instanceof GitHubReadRequestInactiveError
          ? { message: error.message, retryable: false }
          : error instanceof GitHubIdentityError
            ? // Retained reader content requires current authority, even when a
              // later identity-verification attempt could succeed.
              { message: error.message, retryable: false }
            : gitHubPublicApi.formatControlUiGitHubPreviewError(error);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, details));
    } finally {
      const finishedAt = performance.now();
      if (method === "controlUi.githubPreview" && finishedAt - startedAt >= 500) {
        context.logGateway?.info("Slow GitHub preview handler", {
          identityMs: Math.round((preparedAt ?? finishedAt) - startedAt),
          loadMs: preparedAt === undefined ? 0 : Math.round(finishedAt - preparedAt),
        });
      }
    }
  };
}

function parseCheckDetailsParams(
  params: Record<string, unknown>,
): ControlUiSessionPullRequestChecksParams | null {
  if (
    Object.keys(params).some(
      (key) => !["sessionKey", "owner", "repo", "number", "headSha"].includes(key),
    )
  ) {
    return null;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  const headSha = typeof params.headSha === "string" ? params.headSha : "";
  const target = gitHubPublicApi.parseControlUiGitHubPreviewTarget({ ...params, kind: "pull" });
  return target?.kind === "pull" &&
    sessionKey &&
    sessionKey.length <= 512 &&
    /^[0-9a-f]{40}$/i.test(headSha)
    ? {
        sessionKey,
        owner: target.owner,
        repo: target.repo,
        number: target.number,
        headSha: headSha.toLowerCase(),
      }
    : null;
}

export const controlUiGitHubHandlers: GatewayRequestHandlers = {
  "controlUi.githubPreview": createGitHubReadHandler(
    "controlUi.githubPreview",
    (params) => gitHubPublicApi.parseControlUiGitHubPreviewTarget(params),
    (target, identity, fetchImpl, refresh) =>
      gitHubPublicApi.loadControlUiGitHubPreview(target, identity, fetchImpl, refresh),
    (target, identity, fetchImpl) =>
      gitHubPublicApi.loadSessionGitHubPreview(target, identity, fetchImpl),
  ),
  "controlUi.githubDetail": createGitHubReadHandler(
    "controlUi.githubDetail",
    (params) => gitHubPublicApi.parseGitHubTarget(params),
    (target, identity, fetchImpl, refresh, section) =>
      gitHubPublicApi.loadGitHubDetail(target, identity, fetchImpl, refresh, undefined, section),
    (...args) => gitHubPublicApi.loadSessionGitHubDetail(...args),
  ),
  "controlUi.sessionPullRequests.checks": async ({ params, respond, signal }) => {
    const parsed = parseCheckDetailsParams(params);
    if (!parsed) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid controlUi.sessionPullRequests.checks params",
        ),
      );
      return;
    }
    try {
      const requestRead = await captureRepositorySessionRequestRead();
      await requestRead.withRead(
        { sessionKey: parsed.sessionKey, allowOwnImportedPullRequest: true },
        async (read, request) => {
          if (!read) {
            throw new gitHubPublicApi.ControlUiGitHubError(404, "Session CI details unavailable");
          }
          const assertCurrent = () => {
            signal?.throwIfAborted();
            try {
              read.assertCurrent();
            } catch {
              throw new gitHubPublicApi.ControlUiGitHubError(
                409,
                "Session changed; reopen CI details",
              );
            }
            try {
              requestRead.assertCurrent();
            } catch {
              throw new gitHubPublicApi.ControlUiGitHubError(
                409,
                "Session changed; reopen CI details",
              );
            }
          };
          let result;
          try {
            result = await request.checks(read, parsed, assertCurrent);
          } finally {
            assertCurrent();
          }
          respond(true, result, undefined);
        },
      );
    } catch (error) {
      const message =
        error instanceof gitHubPublicApi.ControlUiGitHubError &&
        (error.statusCode === 404 || error.statusCode === 409)
          ? error.message
          : gitHubPublicApi.formatControlUiGitHubPreviewError(error).message;
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message));
    }
  },
  "controlUi.sessionPullRequests.subscribe": async ({ params, context, respond }) => {
    const parsed = parseControlUiSessionPullRequestsSubscribeParams(params);
    if (!parsed) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid controlUi.sessionPullRequests.subscribe params",
        ),
      );
      return;
    }
    let requestRead;
    try {
      requestRead = await captureRepositorySessionRequestRead();
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session pull request subscriptions unavailable"),
      );
      return;
    }
    const preparationError = await new Promise<unknown>((resolve) => {
      const replacement = requestRead.replaceSubscriptions({
        sessionKeys: parsed.sessionKeys,
        refresh:
          parsed.refreshSessionKeys.length > 0 ? new Set(parsed.refreshSessionKeys) : undefined,
        admitted: () => resolve(undefined),
        passive: parsed.passiveSessionKeys ? new Set(parsed.passiveSessionKeys) : undefined,
      });
      void replacement.catch((error: unknown) => {
        resolve(error);
        context.logGateway.warn(
          `Failed to prepare Control UI pull request subscriptions; retry the subscription: ${String(error)}`,
        );
      });
    });
    if (preparationError) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "session pull request subscriptions unavailable; retry the subscription",
        ),
      );
      return;
    }
    respond(
      true,
      { subscribed: parsed.sessionKeys.length > 0 || Boolean(parsed.passiveSessionKeys?.length) },
      undefined,
    );
  },
};
