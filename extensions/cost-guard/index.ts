/**
 * Cost Guard — Budget enforcement and cost alerts for OpenClaw.
 *
 * Listens to model.usage diagnostic events, tracks spend in real time,
 * and enforces daily/monthly budget limits via lifecycle hooks.
 *
 * - Service:  subscribes to diagnostic events, accumulates costs.
 * - Hook:     before_agent_start — injects budget warning into context.
 * - Hook:     message_sending — blocks responses when budget exceeded.
 * - Command:  /cost — shows current spend and budget status.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { costGuardConfigSchema } from "./src/config.js";
import { formatBudgetStatus, formatCostSummary } from "./src/format.js";
import { createCostGuardService } from "./src/service.js";
import { createCostTracker } from "./src/tracker.js";

const plugin = {
  id: "cost-guard",
  name: "Cost Guard",
  description: "Budget enforcement and cost alerts for API usage",
  configSchema: costGuardConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = costGuardConfigSchema.parse(api.pluginConfig);
    const tracker = createCostTracker();

    // ----- 1. Service — listen to model.usage events ----- //

    api.registerService(createCostGuardService(tracker, config, api.logger));

    // ----- 2. Hook: before_agent_start — inject budget warning ----- //

    api.on("before_agent_start", async () => {
      const status = tracker.checkBudget(config);

      if (status.level === "exceeded" && config.hardStop) {
        return {
          prependContext: [
            "[Cost Guard] BUDGET EXCEEDED.",
            `Daily limit of $${status.dailyLimit.toFixed(2)} reached ($${status.dailyUsed.toFixed(2)} used).`,
            "Responses are blocked until the budget resets.",
          ].join(" "),
        };
      }

      if (status.level === "warning") {
        return {
          prependContext: [
            `[Cost Guard] Warning: ${(status.dailyPercent * 100).toFixed(0)}% of daily budget used`,
            `($${status.dailyUsed.toFixed(2)}/$${status.dailyLimit.toFixed(2)}).`,
            "Please keep responses concise to stay within budget.",
          ].join(" "),
        };
      }

      return undefined;
    });

    // ----- 3. Hook: message_sending — hard stop ----- //

    api.on("message_sending", async () => {
      if (!config.hardStop) {
        return undefined;
      }
      const status = tracker.checkBudget(config);
      if (status.level === "exceeded") {
        return { cancel: true };
      }
      return undefined;
    });

    // ----- 4. Command: /cost — show current spend ----- //

    api.registerCommand({
      name: "cost",
      description: "Show current API cost usage and budget status",
      acceptsArgs: true,
      handler: async (ctx) => {
        const args = ctx.args?.trim();

        if (args === "reset") {
          tracker.pruneOldEntries();
          return { text: "Cost tracker entries pruned." };
        }

        const summary = tracker.summary();
        const status = tracker.checkBudget(config);
        const text = formatCostSummary(summary) + "\n\n" + formatBudgetStatus(status);
        return { text };
      },
    });
  },
};

export default plugin;
