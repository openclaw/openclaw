import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createGesahniService, createGesahniTools, resolveGesahniConfig } from "./gesahni.js";

const TELEGRAM_DM_FROM_RE = /^telegram:(-?\d+)$/;

function resolveTelegramDmBridgeUserId(from: unknown): string | null {
  const rawFrom = typeof from === "string" ? from.trim() : "";
  const match = TELEGRAM_DM_FROM_RE.exec(rawFrom);
  if (!match?.[1]) {
    return null;
  }
  return `tg:${match[1]}`;
}

function resolveDashboardUrl(payload: Record<string, unknown>): string | null {
  const value = payload.connect_url ?? payload.dashboard_url;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatConnectFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("timed out")) {
    return "Unable to start dashboard linking because the bridge request timed out. Please try again.";
  }

  if (
    normalized.includes("network") ||
    normalized.includes("fetch") ||
    normalized.includes("econnrefused") ||
    normalized.includes("ehostunreach") ||
    normalized.includes("enotfound")
  ) {
    return "Unable to start dashboard linking due to a network error. Please try again.";
  }

  return "Unable to start dashboard linking right now. Please try again.";
}

const gesahniPlugin = {
  id: "gesahni",
  name: "Gesahni Bridge",
  description:
    "Bridge tools for market reads plus preview-confirm writes for watchlists, stock alerts, and option alert rules.",
  register(api: OpenClawPluginApi) {
    api.registerCommand({
      name: "dashboard",
      description: "Get a dashboard link for Telegram account linking.",
      requireAuth: false,
      handler: async (ctx) => {
        if (ctx.channel !== "telegram") {
          return { text: "This command is only available in Telegram direct messages." };
        }

        const userId = resolveTelegramDmBridgeUserId(ctx.from);
        if (!userId) {
          return { text: "This command only works in Telegram direct messages." };
        }

        try {
          const service = createGesahniService({
            config: resolveGesahniConfig(api.pluginConfig),
          });
          const payload = await service.linkInitiate({ userId });
          const dashboardUrl = resolveDashboardUrl(payload);

          if (!dashboardUrl) {
            return {
              text: "Unable to start dashboard linking because the bridge response was missing connect_url or dashboard_url. Please try again.",
            };
          }

          return {
            text: `Open this URL to connect your dashboard:\n${dashboardUrl}`,
          };
        } catch (error) {
          return { text: formatConnectFailure(error) };
        }
      },
    });

    api.registerTool((ctx) => createGesahniTools({ api, ctx }).watchlistGet, {
      name: "gesahni_watchlist_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).watchlistAdd, {
      name: "gesahni_watchlist_add",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).watchlistRemove, {
      name: "gesahni_watchlist_remove",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).positionsGet, {
      name: "gesahni_positions_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).marketSummaryGet, {
      name: "gesahni_market_summary_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).alertsGet, {
      name: "gesahni_alerts_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).alertCreate, {
      name: "gesahni_alert_create",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).alertUpdate, {
      name: "gesahni_alert_update",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).alertDelete, {
      name: "gesahni_alert_delete",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsWatchRuleCreate, {
      name: "gesahni_options_watch_rule_create",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsWatchRuleUpdate, {
      name: "gesahni_options_watch_rule_update",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsWatchRuleDelete, {
      name: "gesahni_options_watch_rule_delete",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsAlertSuggestionApply, {
      name: "gesahni_options_alert_suggestion_apply",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsAlertSuggestionsApplyAll, {
      name: "gesahni_options_alert_suggestions_apply_all",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).writeConfirm, {
      name: "gesahni_write_confirm",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).earningsUpcomingGet, {
      name: "gesahni_earnings_upcoming_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).portfolioGet, {
      name: "gesahni_portfolio_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsPositionsGet, {
      name: "gesahni_options_positions_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsWatchRulesGet, {
      name: "gesahni_options_watch_rules_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsStatusGet, {
      name: "gesahni_options_status_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsAlertSuggestionsGet, {
      name: "gesahni_options_alert_suggestions_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsWatchRuleEventsGet, {
      name: "gesahni_options_watch_rule_events_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsChainSnapshotGet, {
      name: "gesahni_options_chain_snapshot_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).stockQuoteGet, {
      name: "gesahni_stock_quote_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).optionsQuotesBatchGet, {
      name: "gesahni_options_quotes_batch_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).earningsCoverageGet, {
      name: "gesahni_earnings_coverage_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).earningsRemindersDueGet, {
      name: "gesahni_earnings_reminders_due_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).earningsRemindersSentGet, {
      name: "gesahni_earnings_reminders_sent_get",
    });
    api.registerTool((ctx) => createGesahniTools({ api, ctx }).alertDeliveriesGet, {
      name: "gesahni_alert_deliveries_get",
    });
  },
};

export default gesahniPlugin;
