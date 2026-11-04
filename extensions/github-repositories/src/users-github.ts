import {
  validateUsersGitHubStatusParams,
  validateUsersGitHubAuthorizeStartParams,
  validateUsersGitHubAuthorizePollParams,
  validateUsersGitHubAuthorizeCancelParams,
  validateUsersGitHubDisconnectParams,
} from "@openclaw/gateway-protocol";
import { getActiveSecretsRuntimeConfigSnapshot } from "openclaw/plugin-sdk/channel-secret-owner-runtime";
import { defineValidatedGatewayMethod } from "openclaw/plugin-sdk/gateway-method-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlers,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { prepareGatewayNativeGitHubPersonalCallerV2 as prepareGatewayPersonalCallerV2 } from "openclaw/plugin-sdk/native-github-publication-host";
import { readRepositoryServices, type RepositoryServices } from "../account-runtime-api.js";
import type { PersonalGitHubAction } from "../personal-oauth-api.js";
import { resolveSystemGitHubIdentityStatus } from "../tool-identity-api.js";
async function runPersonalGitHub(
  options: Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal" | "respond">,
  fallbackError: string,
  run: (action: PersonalGitHubAction, service: RepositoryServices["oauth"]["personal"]) => unknown,
): Promise<void> {
  const fail = (error: unknown) =>
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, error instanceof Error ? error.message : fallbackError),
    );
  try {
    const action = await prepareGatewayPersonalCallerV2(options, "operator.read", undefined);
    const service = readRepositoryServices(options.context)?.oauth?.personal;
    if (!service) {
      throw new Error("GitHub connections are unavailable; retry after Gateway startup.");
    }
    const result = await run(action, service);
    action.assertCurrent();
    options.respond(true, result);
  } catch (error) {
    fail(error);
  }
}
export const usersGitHubHandlers: GatewayRequestHandlers = {
  "users.github.status": defineValidatedGatewayMethod(
    "users.github.status",
    validateUsersGitHubStatusParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub is unavailable.", async (action, service) => {
        const config = options.context.getRuntimeConfig();
        const system = await resolveSystemGitHubIdentityStatus({
          config,
          sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? config,
          assertActive() {
            options.signal?.throwIfAborted();
            action.assertCurrent();
          },
        });
        const personal = await service.status(action);
        return {
          personal,
          system,
        };
      }),
  ),
  "users.github.authorize.start": defineValidatedGatewayMethod(
    "users.github.authorize.start",
    validateUsersGitHubAuthorizeStartParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub authorization failed.", (action, service) =>
        service.startAuthorization(action),
      ),
  ),
  "users.github.authorize.poll": defineValidatedGatewayMethod(
    "users.github.authorize.poll",
    validateUsersGitHubAuthorizePollParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub authorization failed.", (action, service) =>
        service.pollAuthorization(action, options.params.requestId),
      ),
  ),
  "users.github.authorize.cancel": defineValidatedGatewayMethod(
    "users.github.authorize.cancel",
    validateUsersGitHubAuthorizeCancelParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub authorization failed.", async (action, service) => ({
        cancelled: await service.cancelAuthorizationAsync(action, options.params.requestId),
      })),
  ),
  "users.github.disconnect": defineValidatedGatewayMethod(
    "users.github.disconnect",
    validateUsersGitHubDisconnectParams,
    (options) =>
      runPersonalGitHub(options, "My GitHub disconnect failed.", async (action, service) => {
        await service.disconnectAsync(action);
        return {
          disconnected: true,
        };
      }),
  ),
};
