import {
  validateToolsGitHubAuthorizeCancelParams,
  validateToolsGitHubAuthorizePollParams,
  validateToolsGitHubAuthorizeStartParams,
  validateToolsGitHubConfigureParams,
  validateToolsGitHubStatusParams,
} from "@openclaw/gateway-protocol";
import { getActiveSecretsRuntimeConfigSnapshot } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveAgentIdOrRespondError,
  defineValidatedGatewayHandler,
} from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlers,
} from "openclaw/plugin-sdk/gateway-runtime";
import { createSubsystemLogger, redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { consumeGitHubSetupHandoff } from "openclaw/plugin-sdk/native-github-account-host";
import { readRepositoryServices } from "../account-runtime-api.js";
import { GitHubCliUnavailableError } from "../cli-preflight-api.js";
import {
  GitHubIdentityError,
  createManagedGitHubProfileId,
  installManagedGitHubProfile,
  resolveConfiguredGitHubToolIdentity,
  resolveGitHubToolIdentityStatus,
  resolveManagedGitHubProfileDir,
} from "../tool-identity-api.js";
import { updateGitHubToolIdentityConfig } from "../tool-identity-config-api.js";
const log = createSubsystemLogger("github-repositories");

export const toolsGitHubHandlers: GatewayRequestHandlers = {
  "tools.github.status": defineValidatedGatewayHandler(
    "tools.github.status",
    validateToolsGitHubStatusParams,
    async ({ params, respond, context, signal, hasCurrentClientAuthority }) => {
      const assertActive = () => {
        signal?.throwIfAborted();
        if (hasCurrentClientAuthority?.() === false) {
          throw new GitHubIdentityError("changed");
        }
      };
      assertActive();
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      const result = await resolveGitHubToolIdentityStatus({
        config: resolved.cfg,
        sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? resolved.cfg,
        agentId: resolved.agentId,
        selectedScope: params.selectedScope,
        assertActive,
      });
      assertActive();
      respond(true, result);
    },
  ),
  "tools.github.configure": defineValidatedGatewayHandler(
    "tools.github.configure",
    validateToolsGitHubConfigureParams,
    async ({ params, respond, context }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      try {
        const previousIdentity = resolveConfiguredGitHubToolIdentity({
          config: resolved.cfg,
          agentId: resolved.agentId,
          scope: params.scope,
        });
        let nextConfig = resolved.cfg;
        if (params.mode === "inherit") {
          nextConfig = await updateGitHubToolIdentityConfig({
            scope: params.scope,
            agentId: resolved.agentId,
            expectedIdentity: previousIdentity ?? null,
          });
        } else {
          const gitAuthor = params.gitAuthor
            ? {
                ...(params.gitAuthor.name !== undefined
                  ? { name: params.gitAuthor.name.trim() }
                  : {}),
                ...(params.gitAuthor.email !== undefined
                  ? { email: params.gitAuthor.email.trim() }
                  : {}),
              }
            : undefined;
          const token = await consumeGitHubSetupHandoff({ name: params.secretName });
          if (!token) {
            throw new Error("temporary GitHub credential is unavailable");
          }
          const profileId = createManagedGitHubProfileId();
          const profileDir = resolveManagedGitHubProfileDir({
            agentId: resolved.agentId,
            scope: params.scope,
            profileId,
          });
          await installManagedGitHubProfile({
            profileDir,
            token,
            commitConfig: async (account) => {
              const identity = {
                profileId,
                gitAuthor: gitAuthor ?? {
                  name: account.login,
                  email: `${account.accountId}+${account.login}@users.noreply.github.com`,
                },
              };
              nextConfig = await updateGitHubToolIdentityConfig({
                scope: params.scope,
                agentId: resolved.agentId,
                identity,
                expectedIdentity: previousIdentity ?? null,
              });
            },
          });
        }
        if (previousIdentity?.kind === "oauth") {
          await readRepositoryServices(context)?.oauth?.retireProfileAsync(
            previousIdentity.profileId,
          );
        }
        respond(
          true,
          await resolveGitHubToolIdentityStatus({
            config: nextConfig,
            agentId: resolved.agentId,
            selectedScope: params.scope,
          }),
        );
      } catch (error) {
        // Credential setup causes must be safe even in raw file logs.
        log.warn(
          `tools-github: GitHub identity setup failed: ${redactToolPayloadText(formatErrorMessage(error))}`,
        );
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "GitHub identity setup failed"),
        );
      }
    },
  ),
  "tools.github.authorize.start": defineValidatedGatewayHandler(
    "tools.github.authorize.start",
    validateToolsGitHubAuthorizeStartParams,
    async ({ params, respond, context }) => {
      const resolved = resolveAgentIdOrRespondError({
        rawAgentId: params.agentId,
        respond,
        cfg: context.getRuntimeConfig(),
      });
      if (!resolved) {
        return;
      }
      try {
        const service = readRepositoryServices(context)?.oauth;
        if (!service) {
          throw new Error("GitHub authorization lifecycle is unavailable.");
        }
        respond(
          true,
          await service.startAuthorization({ scope: params.scope, agentId: resolved.agentId }),
        );
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof GitHubCliUnavailableError
              ? error.message
              : "GitHub authorization could not start",
          ),
        );
      }
    },
  ),
  "tools.github.authorize.poll": defineValidatedGatewayHandler(
    "tools.github.authorize.poll",
    validateToolsGitHubAuthorizePollParams,
    async ({ params, respond, context }) => {
      const service = readRepositoryServices(context)?.oauth;
      if (!service) {
        throw new Error("GitHub authorization lifecycle is unavailable.");
      }
      respond(true, await service.pollAuthorization(params.requestId));
    },
    () => errorShape(ErrorCodes.UNAVAILABLE, "GitHub authorization polling failed"),
  ),
  "tools.github.authorize.cancel": defineValidatedGatewayHandler(
    "tools.github.authorize.cancel",
    validateToolsGitHubAuthorizeCancelParams,
    async ({ params, respond, context }) => {
      const service = readRepositoryServices(context)?.oauth;
      if (!service) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "GitHub authorization lifecycle is unavailable"),
        );
        return;
      }
      respond(true, { cancelled: await service.cancelAuthorizationAsync(params.requestId) });
    },
  ),
};
