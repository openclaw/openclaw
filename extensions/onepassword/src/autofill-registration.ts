import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { unavailableAutofillExtension } from "./autofill-contract.js";
import { isAgenticAutofillEnabled } from "./autofill-input.js";
import { AutofillError, AutofillRelayClient } from "./autofill-relay.js";
import {
  AutofillService,
  type AutofillConnection,
  type AutofillRequest,
} from "./autofill-service.js";
import { createAutofillTool } from "./autofill-tool.js";

/** Compose the Gateway-owned preview, without opening state in CLI child processes. */
export function registerAutofill(api: OpenClawPluginApi, resolveConfig: () => unknown): void {
  if (!isAgenticAutofillEnabled(api.pluginConfig)) {
    return;
  }
  const service = new AutofillService({
    stores: {
      connections: api.runtime.state.openKeyedStoreV2<AutofillConnection>({
        namespace: "autofill-connections",
        retention: "retained",
      }),
      requests: api.runtime.state.openKeyedStoreV2<AutofillRequest>({
        namespace: "autofill-requests",
        retention: "retained",
      }),
    },
    relay: new AutofillRelayClient(),
    // ExtensionBridge seam: browser owner supplies an adapter implementing this contract.
    // It MUST enforce one person per browser, Agentic Mode, and an exclusive tab lock.
    extension: unavailableAutofillExtension,
    assertEnabled() {
      if (!isAgenticAutofillEnabled(resolveConfig())) {
        throw new AutofillError("autofillDisabled");
      }
    },
  });
  api.registerTool(
    { contextVersion: 2, create: (context) => createAutofillTool(service, context) },
    {
      name: "onepassword_autofill",
      optional: true,
      workspaceAccess: false,
    },
  );
  for (const action of ["connect", "pickup", "disconnect", "status"] as const) {
    api.registerGatewayMethod(
      `onepassword.autofill.${action}`,
      async (options) => {
        const authority = {
          signal: options.signal,
          assertCurrent() {
            options.signal?.throwIfAborted();
            if (options.client?.invalidated || options.hasCurrentClientAuthority?.() === false) {
              throw new AutofillError("requesterChanged");
            }
            options.sessionMutationCommitGuard?.();
            options.sessionMutationAuthorization?.assertCurrent();
          },
        };
        // Errors contain fixed codes only. The Gateway must never serialize relay/extension objects.
        try {
          authority.assertCurrent();
          switch (action) {
            case "connect":
              return await service.connect(authority);
            case "pickup": {
              if (
                typeof options.params.sessionId !== "string" ||
                !/^[A-Za-z0-9_-]{22}$/.test(options.params.sessionId)
              ) {
                throw new AutofillError("invalidRequest");
              }
              return await service.pickup(options.params.sessionId, authority);
            }
            case "disconnect":
              return await service.disconnect(authority);
            case "status":
              return await service.status(authority);
            default:
              throw new AutofillError("invalidRequest");
          }
        } catch (error) {
          return {
            state: "error",
            code: error instanceof AutofillError ? error.code : "operationFailed",
          };
        }
      },
      { scope: "operator.admin" },
    );
  }
}
