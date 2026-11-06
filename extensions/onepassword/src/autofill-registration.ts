import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { z } from "zod";
import { ApprovalNotifier } from "./autofill-approval-notice.js";
import { BrowserAutofillExtension, autofillBrowserGuidance } from "./autofill-browser.js";
import { AutofillConnectCards } from "./autofill-connect-cards.js";
import type { AutofillAuthority } from "./autofill-contract.js";
import { isAgenticAutofillEnabled } from "./autofill-input.js";
import { autofillClock } from "./autofill-poll.js";
import { AutofillError, AutofillRelayClient } from "./autofill-relay.js";
import {
  AutofillService,
  type AutofillConnection,
  type AutofillRequest,
} from "./autofill-service.js";
import { createAutofillTool } from "./autofill-tool.js";

type GatewayOptions = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];

// Pickup failures worth retrying within the consent window; fixed codes, no upstream text.
const transientPickupErrors = new Set(["networkError"]);

// Core admits session-scoped methods only at operator.write; the handler itself
// still requires a real Control UI client holding operator.admin.
const cardAccess = { mode: "write", requiredTool: "onepassword_autofill" } as const;

/** Private card hydration belongs only to a current, real Control UI admin with session access. */
function controlUiAuthority(options: GatewayOptions) {
  return {
    signal: options.signal,
    assertCurrent() {
      options.signal?.throwIfAborted();
      // Never hydrate for a synthetic agent RPC, even when it inherits administrator scopes.
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
}

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
  const cards = new AutofillConnectCards(autofillClock);
  const notifier = new ApprovalNotifier(api.runtime.system, (message) => api.logger.warn(message));
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
        run: () => {
          service.pruneApprovalLinks();
          cards.prune();
        },
      });
    },
    async stop() {
      scheduler = undefined;
      for (const release of pollingReleases) {
        release();
      }
      pollingReleases.clear();
      service.clearApprovalLinks();
      cards.clear();
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
  api.session.controls.registerControlUiDescriptor({
    id: "connect",
    surface: "inline",
    label: "Connect 1Password",
    requiredScopes: ["operator.admin"],
    version: 1,
  });
  // Both private card methods share one viewer contract and admission policy.
  const cardMethod = { scope: "operator.write", sessionAccess: cardAccess } as const;
  api.registerGatewayMethod(
    "onepassword.autofill.approval",
    async (options) => {
      const authority = controlUiAuthority(options);
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
        // Captured now, while the Control UI click is current, so the checker can resume this session.
        const resume = await notifier.capture(target);
        authority.assertCurrent();
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
                const result = await service.checkStatus(input.requestId, scope, true, {
                  signal,
                  assertCurrent: retained.assertCurrent,
                });
                await notifier.notify(resume, result);
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
    cardMethod,
  );
  let connectJob = 0;
  const connectCheckers = new Set<string>();
  api.registerGatewayMethod(
    "onepassword.autofill.connectView",
    async (options) => {
      const authority = controlUiAuthority(options);
      try {
        authority.assertCurrent();
        const input = z
          .object({
            sessionId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
            action: z.enum(["get", "opened"]).default("get"),
            sessionKey: z.string(),
            agentId: z.string().optional(),
          })
          .strict()
          .parse(options.params);
        const target = options.sessionAccessAuthority!.target;
        const scope = JSON.stringify([target.sessionKey, target.sessionId]);
        const view = (current: AutofillAuthority) =>
          cards.snapshot(input.sessionId, scope, service.consentSession(input.sessionId, current));
        const snapshot = view(authority);
        if (
          input.action !== "opened" ||
          snapshot.state !== "pending" ||
          connectCheckers.has(input.sessionId) ||
          !cards.opened(input.sessionId, scope)
        ) {
          return snapshot;
        }
        const owner = scheduler;
        if (!owner || owner.signal.aborted) {
          throw new AutofillError("operationFailed");
        }
        // Captured while the click is current so the checker can resume this chat.
        const resume = await notifier.capture(target);
        authority.assertCurrent();
        const retained = options.sessionAccessAuthority!.retain();
        const release = () => {
          retained.release();
          connectCheckers.delete(input.sessionId);
          pollingReleases.delete(release);
        };
        connectCheckers.add(input.sessionId);
        pollingReleases.add(release);
        const signal = AbortSignal.any([owner.signal, retained.signal]);
        try {
          owner.schedule({
            id: `connect-${++connectJob}`,
            delayMs: 0,
            async run() {
              try {
                const checker = { signal, assertCurrent: retained.assertCurrent };
                // Same cadence as the CLI. Pickup records the card's outcome; stop when
                // another caller (CLI, agent) settled it, or when the consent expires.
                while (view(checker).state === "pending") {
                  let result: Awaited<ReturnType<AutofillService["pickup"]>>;
                  try {
                    result = await cards.pickup(input.sessionId, () =>
                      service.pickup(input.sessionId, checker),
                    );
                  } catch (error) {
                    if (error instanceof AutofillError && error.code === "rateLimited") {
                      await autofillClock.sleep(60_000, signal);
                      continue;
                    }
                    // A relay or network blip is not a consent outcome; keep checking until
                    // the consent expires instead of ending the card on one failed request.
                    if (error instanceof AutofillError && transientPickupErrors.has(error.code)) {
                      await autofillClock.sleep(5_000, signal);
                      continue;
                    }
                    api.logger.warn(
                      `1Password connect check stopped: ${
                        error instanceof AutofillError ? error.code : "unexpected error"
                      }`,
                    );
                    // Lost authority stays quiet; an authorized stopped check must be visible.
                    checker.assertCurrent();
                    cards.stopped(input.sessionId);
                    const settled = view(checker);
                    if (settled.state === "failed") {
                      await notifier.notifyConnect(resume, {
                        sessionId: input.sessionId,
                        state: "failed",
                        code: settled.code,
                      });
                    }
                    return;
                  }
                  if (result.state !== "pending") {
                    await notifier.notifyConnect(resume, {
                      sessionId: input.sessionId,
                      state: result.state === "connected" ? "connected" : "failed",
                    });
                    return;
                  }
                  await autofillClock.sleep(2000, signal);
                }
              } catch {
                // Cancellation or a lost session grant; the card reports the current state.
              } finally {
                release();
              }
            },
          });
        } catch {
          release();
          throw new AutofillError("operationFailed");
        }
        return view(authority);
      } catch (error) {
        return {
          state: "error",
          code: error instanceof AutofillError ? error.code : "operationFailed",
        };
      }
    },
    cardMethod,
  );
  api.registerTool(
    {
      contextVersion: 2,
      create: (context) => createAutofillTool(service, context, api.inlineView, cards),
    },
    {
      // agenticAutofill.enabled is the opt-in: the tool is registered only when
      // it is true, so a second tool-policy allow would only hide the feature.
      name: "onepassword_autofill",
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
