import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { QA_SESSION_OBSERVER_HEADER } from "./providers/shared/session-observer-registry.js";
import { createQaLabWebSearchProvider } from "./qa-web-search-provider.js";
import { createStaticSshWorkerProvider } from "./static-ssh-worker-provider.js";

const EMPTY_TOOL_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const qaLabGatewayDefinition = {
  id: "qa-lab",
  name: "QA Lab",
  description: "Private QA automation harness and debugger UI",
  register(api: OpenClawPluginApi) {
    const sessionObserverUrl =
      api.config.models?.providers?.["mock-openai"]?.request?.headers?.[QA_SESSION_OBSERVER_HEADER];
    if (typeof sessionObserverUrl === "string") {
      // This awaited QA gate observes full identities, including hidden/raw runs,
      // before a provider can truncate them for cache affinity.
      api.on("before_agent_run", async (_event, context) => {
        if (!context.sessionId) {
          return;
        }
        const { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin } =
          await import("openclaw/plugin-sdk/ssrf-runtime");
        const { response, release } = await fetchWithSsrFGuard({
          url: sessionObserverUrl,
          policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(sessionObserverUrl),
          auditContext: "qa-lab-session-observer",
          init: {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: context.sessionId }),
          },
        });
        try {
          await response.text();
          if (!response.ok) {
            throw new Error(`QA mock session observation failed: HTTP ${response.status}`);
          }
        } finally {
          await release();
        }
      });
    }
    api.registerTool(
      {
        name: "qa_restart_wait",
        label: "QA Restart Wait",
        description: "Hold a QA call pending until it completes or its run is aborted.",
        parameters: EMPTY_TOOL_PARAMETERS,
        async execute(_toolCallId, _params, signal) {
          await sleep(30_000, undefined, { signal });
          return jsonResult({ status: "released" });
        },
      },
      { name: "qa_restart_wait" },
    );
    const ordersFile = process.env.OPENCLAW_QA_PERSONAL_ORDERS_FILE;
    if (ordersFile) {
      api.registerTool(
        {
          contextVersion: 2,
          create(ctx) {
            return {
              name: "qa_my_orders",
              label: "My orders",
              description: "Read the current orders for the requesting private WhatsApp contact.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  action: { type: "string", enum: ["list", "mark_reviewed"] },
                },
              },
              async execute(_id, args: { action?: string }) {
                ctx.assertInvocationCurrent();
                if (
                  ctx.messageChannel !== "whatsapp" ||
                  !ctx.agentAccountId ||
                  !ctx.requesterSenderId ||
                  ctx.senderIsOwner === true
                ) {
                  throw new Error(
                    `Invalid synthetic orders caller (channel=${ctx.messageChannel}, hasAccount=${Boolean(ctx.agentAccountId)}, hasSender=${Boolean(ctx.requesterSenderId)}, owner=${ctx.senderIsOwner}).`,
                  );
                }
                await appendFile(
                  ordersFile + ".accesses",
                  JSON.stringify({
                    account: ctx.agentAccountId,
                    peer: ctx.requesterSenderId,
                    action: args.action,
                  }) + "\n",
                );
                const ledger: Record<string, Record<string, number[]>> = JSON.parse(
                  await readFile(ordersFile, "utf8"),
                );
                ctx.assertInvocationCurrent();
                const quantities = ledger[ctx.agentAccountId]?.[ctx.requesterSenderId] ?? [];
                if (args.action === "mark_reviewed") {
                  await appendFile(
                    ordersFile + ".reviews",
                    JSON.stringify({
                      account: ctx.agentAccountId,
                      peer: ctx.requesterSenderId,
                      quantities,
                    }) + "\n",
                  );
                  return jsonResult({ reviewed: quantities.length });
                }
                return jsonResult({ quantities });
              },
            };
          },
        },
        { name: "qa_my_orders", workspaceAccess: false },
      );
    }
    api.registerWorkerProvider(createStaticSshWorkerProvider());
    api.registerWebSearchProvider(createQaLabWebSearchProvider());
  },
};
