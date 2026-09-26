import { AsyncLocalStorage } from "node:async_hooks";
import type { Interceptor } from "@microsoft/teams.common";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";

export type MSTeamsSendHandoff = {
  assertDirectAdapterHandoff?: () => void;
  onPlatformSendDispatch?: () => Promise<void>;
};

const connectorHandoff = new AsyncLocalStorage<MSTeamsSendHandoff>();

function notDispatched(error: unknown): PlatformMessageNotDispatchedError {
  return error instanceof PlatformMessageNotDispatchedError
    ? error
    : new PlatformMessageNotDispatchedError(
        error instanceof Error ? error.message : "Teams delivery authority closed",
        { cause: error, retryable: false },
      );
}

export function assertMSTeamsSendHandoff(handoff?: MSTeamsSendHandoff): void {
  try {
    handoff?.assertDirectAdapterHandoff?.();
  } catch (error) {
    throw notDispatched(error);
  }
}

export function withMSTeamsConnectorHandoff<T>(
  handoff: MSTeamsSendHandoff,
  send: (current: MSTeamsSendHandoff) => Promise<T>,
): Promise<T> {
  // Replayed turn contexts enter the proactive helper again with routing options
  // only. Keep their caller's operation; explicit callbacks start their own scope.
  const current =
    handoff.assertDirectAdapterHandoff || handoff.onPlatformSendDispatch
      ? handoff
      : (connectorHandoff.getStore() ?? handoff);
  return connectorHandoff.run(current, () => send(current));
}

/** Called only by a Connector transport, after its asynchronous token preparation. */
export async function prepareMSTeamsConnectorRequest(): Promise<(() => void) | undefined> {
  const handoff = connectorHandoff.getStore();
  if (!handoff) {
    return undefined;
  }
  const assertCurrent = handoff.assertDirectAdapterHandoff
    ? () => assertMSTeamsSendHandoff(handoff)
    : undefined;
  assertCurrent?.();
  try {
    await handoff.onPlatformSendDispatch?.();
  } catch (error) {
    throw notDispatched(error);
  }
  return assertCurrent;
}

// App clones this permanent interceptor into its API and per-reference clients.
// Capture each operation at request time so concurrent sends never share authority.
export const msteamsConnectorHandoffInterceptor: Interceptor = {
  request: async ({ config }) => {
    const assertCurrent = await prepareMSTeamsConnectorRequest();
    if (!assertCurrent) {
      return config;
    }
    // Common's interceptors are asynchronous even when options.synchronous is set.
    // Axios runs transforms synchronously immediately before its JSON HTTP adapter.
    const transforms = config.transformRequest;
    config.transformRequest = [
      ...(Array.isArray(transforms) ? transforms : transforms ? [transforms] : []),
      (data: unknown) => {
        assertCurrent();
        return data;
      },
    ];
    const beforeRedirect = config.beforeRedirect;
    config.beforeRedirect = (...args) => {
      beforeRedirect?.(...args);
      assertCurrent();
    };
    return config;
  },
};
