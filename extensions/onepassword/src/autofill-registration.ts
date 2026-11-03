import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
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
  const extension = new BrowserAutofillExtension({
    ...config,
    warn: (message) => api.logger.warn(message),
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
  let scheduler: PluginServiceSchedulerV1 | undefined;
  let approvalJob = 0;
  const pollingReleases = new Set<() => void>();
  api.registerService({
    id: "onepassword-autofill-browser",
    apiVersion: 2,
    async start(context) {
      scheduler = context.scheduler;
      await extension.start();
      scheduler.schedule({
        id: "approval-expiry",
        delayMs: 60_000,
        everyMs: 60_000,
        run: () => service.pruneApprovalLinks(),
      });
    },
    async stop() {
      scheduler = undefined;
      for (const release of pollingReleases) {
        release();
      }
      pollingReleases.clear();
      service.clearApprovalLinks();
      await extension.close();
    },
  });
  api.session.controls.registerControlUiDescriptor({
    id: "approval",
    surface: "inline",
    label: "1Password approval",
    requiredScopes: ["operator.admin"],
    version: 1,
  });
  api.registerGatewayMethod(
    "onepassword.autofill.approval",
    async (options) => {
      const authority = {
        signal: options.signal,
        assertCurrent() {
          options.signal?.throwIfAborted();
          // Admin is the existing Control UI owner contract. Never hydrate for a
          // synthetic agent RPC, even when it inherits administrator scopes.
          if (
            !options.client?.internal?.authenticatedControlUi ||
            options.client.internal.syntheticClient ||
            options.client.invalidated ||
            options.hasCurrentClientAuthority?.() !== true ||
            !options.client.connect.scopes?.includes("operator.admin") ||
            !options.sessionAccessAuthority
          ) {
            throw new AutofillError("gatewayOwnerRequired");
          }
          options.sessionAccessAuthority.assertCurrent();
        },
      };
      try {
        authority.assertCurrent();
        const input = z
          .object({
            requestId: z.string().min(1).max(256),
            action: z.enum(["get", "opened"]).default("get"),
            sessionKey: z.string(),
            agentId: z.string().optional(),
          })
          .strict()
          .parse(options.params);
        const target = options.sessionAccessAuthority!.target;
        const scope = JSON.stringify([target.sessionKey, target.sessionId]);
        const snapshot = await service.approval(input.requestId, scope, authority);
        authority.assertCurrent();
        if (
          input.action !== "opened" ||
          snapshot.state !== "pending" ||
          !snapshot.appLink ||
          snapshot.openedAt !== undefined
        ) {
          return snapshot;
        }
        const owner = scheduler;
        if (!owner || owner.signal.aborted) {
          throw new AutofillError("operationFailed");
        }
        await service.noteApprovalOpened(input.requestId, scope, authority);
        authority.assertCurrent();
        if (owner !== scheduler || owner.signal.aborted) {
          service.forgetApprovalLink(input.requestId);
          throw new AutofillError("operationFailed");
        }
        const retained = options.sessionAccessAuthority!.retain();
        const release = () => {
          retained.release();
          pollingReleases.delete(release);
        };
        pollingReleases.add(release);
        // A service job + explicit retained session grant own the checker. The
        // completed browser RPC is not retained, nor does native-app navigation cancel it.
        const signal = AbortSignal.any([owner.signal, retained.signal]);
        try {
          owner.schedule({
            id: `approval-${++approvalJob}`,
            delayMs: 0,
            async run() {
              try {
                await service.checkStatus(input.requestId, scope, true, {
                  signal,
                  assertCurrent: retained.assertCurrent,
                });
              } catch {
                // Errors may contain upstream data. Expire this private view without logging.
                service.forgetApprovalLink(input.requestId);
              } finally {
                release();
              }
            },
          });
        } catch {
          release();
          service.forgetApprovalLink(input.requestId);
          throw new AutofillError("operationFailed");
        }
        const opened = await service.approval(input.requestId, scope, authority);
        authority.assertCurrent();
        return opened;
      } catch (error) {
        return {
          state: "error",
          code: error instanceof AutofillError ? error.code : "operationFailed",
        };
      }
    },
    {
      // Core admits session-scoped methods only at operator.write; the handler
      // itself still requires a real Control UI client holding operator.admin.
      scope: "operator.write",
      sessionAccess: { mode: "write", requiredTool: "onepassword_autofill" },
    },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create: (context) => createAutofillTool(service, context, api.inlineView),
    },
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
