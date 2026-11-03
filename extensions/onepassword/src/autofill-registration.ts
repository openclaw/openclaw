import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { BrowserAutofillExtension, autofillBrowserGuidance } from "./autofill-browser.js";
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
  const config = z
    .object({
      agenticAutofill: z.object({
        extensionPath: z.string().trim().min(1).optional(),
        browserProfile: z.string().trim().min(1).optional(),
      }),
    })
    .parse(api.pluginConfig).agenticAutofill;
  const extension = new BrowserAutofillExtension(config);
  api.registerService({
    id: "onepassword-autofill-browser",
    apiVersion: 2,
    start: () => extension.start(),
    stop: () => extension.close(),
  });
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
    extension,
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
            guidance: autofillBrowserGuidance,
          };
        }
      },
      { scope: "operator.admin" },
    );
  }
}
