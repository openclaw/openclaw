import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-entry";
import { runAlertCheck } from "./src/alert-runner.js";
import {
  createAlertStore,
  formatAlertList,
  formatAlertPreview,
  formatAlertSaved,
  formatAlertInstrument,
  parseAlertRequest,
  type AlertScope,
} from "./src/alerts.js";
import { renderChartFile } from "./src/charts.js";
import { readGesahniConfig } from "./src/config.js";
import {
  createMarketDataClient,
  type MarketDataClient,
  type MarketQuote,
} from "./src/market-data.js";
import { parseOptionContract, parseOptionTradeContext } from "./src/options.js";

function formatCurrency(value: number | undefined): string {
  return value === undefined ? "unavailable" : `$${value.toFixed(2)}`;
}

function formatQuoteLine(quote: MarketQuote): string {
  const mark =
    quote.mark ??
    (quote.bid !== undefined && quote.ask !== undefined ? (quote.bid + quote.ask) / 2 : undefined);
  const lines = [
    `${quote.symbol} - ${formatCurrency(mark)}`,
    `Bid/ask: ${formatCurrency(quote.bid)} / ${formatCurrency(quote.ask)}`,
    `Source: ${quote.source}${quote.timestamp ? `, ${quote.timestamp}` : ""}`,
    "Educational only.",
  ];
  return lines.join("\n");
}

function readQuoteMark(quote: MarketQuote): number | undefined {
  return (
    quote.mark ??
    (quote.bid !== undefined && quote.ask !== undefined ? (quote.bid + quote.ask) / 2 : undefined)
  );
}

function formatSignedCurrency(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

function formatTradeValueDelta(posture: "bought" | "sold" | "unknown", value: number): string {
  if (posture === "bought") {
    return `P/L versus entry: ${formatSignedCurrency(value)}.`;
  }
  if (posture === "unknown") {
    return `Value versus entry reference: ${formatSignedCurrency(value)}.`;
  }
  if (value > 0) {
    return `Extra upside versus that sale: ${formatSignedCurrency(value)}.`;
  }
  if (value < 0) {
    return `Current estimate is ${formatCurrency(Math.abs(value))} below that sale.`;
  }
  return "Current estimate matches that sale.";
}

function getDiscordChannelId(ctx: PluginCommandContext): string | undefined {
  return ctx.channel === "discord" && typeof ctx.channelId === "string" ? ctx.channelId : undefined;
}

function isDirectDiscordContext(ctx: PluginCommandContext): boolean {
  return (
    ctx.channel === "discord" &&
    typeof ctx.from === "string" &&
    ctx.from.startsWith("discord:") &&
    !ctx.from.startsWith("discord:channel:") &&
    !ctx.from.startsWith("discord:group:")
  );
}

function isDiscordDispatchContext(params: {
  channel?: string;
  sessionKey?: string;
  contextSessionKey?: string;
}): boolean {
  return (
    params.channel === "discord" ||
    params.sessionKey?.includes(":discord:") === true ||
    params.contextSessionKey?.includes(":discord:") === true
  );
}

function isDirectDiscordDispatch(params: {
  isGroup?: boolean;
  sessionKey?: string;
  contextSessionKey?: string;
  conversationId?: string;
}): boolean {
  if (params.isGroup) {
    return false;
  }
  const conversationId = params.conversationId;
  if (
    conversationId?.startsWith("user:") === true ||
    (conversationId?.startsWith("discord:") === true &&
      !conversationId.startsWith("discord:channel:") &&
      !conversationId.startsWith("discord:group:"))
  ) {
    return true;
  }
  return (
    params.sessionKey?.includes(":discord:direct:") === true ||
    params.contextSessionKey?.includes(":discord:direct:") === true
  );
}

function resolveDefaultScope(ctx: PluginCommandContext): AlertScope {
  return isDirectDiscordContext(ctx) ? "private" : "group";
}

function createCommandContext(options: {
  pluginConfig: unknown;
  stateDir: string;
  marketDataClient?: MarketDataClient;
}) {
  const config = readGesahniConfig(options.pluginConfig);
  const marketData = options.marketDataClient ?? createMarketDataClient(config);
  const alertStore = createAlertStore(options.stateDir);
  return { config, marketData, alertStore };
}

function createQuoteCommand(options: {
  pluginConfig: unknown;
  stateDir: string;
  marketDataClient?: MarketDataClient;
}): OpenClawPluginCommandDefinition {
  return {
    name: "quote",
    description: "Fetch a fast stock quote.",
    acceptsArgs: true,
    channels: ["discord"],
    requireAuth: true,
    handler: async (ctx) => {
      const symbol = ctx.args?.trim().split(/\s+/)[0]?.replace(/^\$/, "").toUpperCase();
      if (!symbol) {
        return { text: "Usage: /quote AAPL" };
      }
      const { marketData } = createCommandContext(options);
      try {
        return { text: formatQuoteLine(await marketData.quote(symbol)) };
      } catch (error) {
        return { text: `Quote unavailable: ${(error as Error).message}` };
      }
    },
  };
}

function createContractCommand(options: {
  pluginConfig: unknown;
  stateDir: string;
  marketDataClient?: MarketDataClient;
}): OpenClawPluginCommandDefinition {
  return {
    name: "contract",
    description: "Fetch a fast option-contract quote.",
    acceptsArgs: true,
    channels: ["discord"],
    requireAuth: true,
    handler: async (ctx) => {
      const contract = parseOptionContract(ctx.args ?? "");
      if (!contract) {
        return { text: "Usage: /contract MU 647.5C 5/8" };
      }
      const { marketData } = createCommandContext(options);
      try {
        const underlying = await marketData.quote(contract.symbol);
        let quote: MarketQuote | undefined;
        let quoteError: Error | undefined;
        try {
          quote = await marketData.optionQuote(contract);
        } catch (error) {
          quoteError = error as Error;
        }
        const trade = parseOptionTradeContext(ctx.args ?? "");
        const underlyingMark = readQuoteMark(underlying);
        const intrinsic =
          underlyingMark === undefined
            ? undefined
            : contract.right === "call"
              ? Math.max(0, underlyingMark - contract.strike)
              : Math.max(0, contract.strike - underlyingMark);
        if (!quote && intrinsic === undefined) {
          throw quoteError ?? new Error("contract and underlying market data unavailable");
        }
        const optionMark = quote ? readQuoteMark(quote) : intrinsic;
        const timeValue =
          quote && optionMark !== undefined && intrinsic !== undefined
            ? Math.max(0, optionMark - intrinsic)
            : undefined;
        const currentValue =
          optionMark === undefined ? undefined : optionMark * 100 * trade.quantity;
        const entryValue =
          trade.entryPrice === undefined ? undefined : trade.entryPrice * 100 * trade.quantity;
        const valueDelta =
          currentValue === undefined || entryValue === undefined
            ? undefined
            : currentValue - entryValue;
        const breakeven =
          trade.entryPrice === undefined
            ? undefined
            : contract.right === "call"
              ? contract.strike + trade.entryPrice
              : contract.strike - trade.entryPrice;
        const postureLine =
          trade.entryPrice === undefined
            ? undefined
            : trade.posture === "sold"
              ? `Sold/closed reference: ${trade.quantity} contract${trade.quantity === 1 ? "" : "s"} at ${formatCurrency(trade.entryPrice)} = ${formatCurrency(entryValue)} collected before fees.`
              : `Entry reference: ${trade.quantity} contract${trade.quantity === 1 ? "" : "s"} at ${formatCurrency(trade.entryPrice)} = ${formatCurrency(entryValue)} before fees.`;
        const analysis = [
          `${contract.symbol} ${contract.strike}${contract.right === "call" ? "C" : "P"} ${contract.expiry}`,
          `Underlying: ${formatCurrency(underlyingMark)}. Strike distance: ${
            underlyingMark === undefined
              ? "unavailable"
              : formatSignedCurrency(underlyingMark - contract.strike)
          }.`,
          quote
            ? `Option mark: ${formatCurrency(optionMark)}. Bid/ask: ${formatCurrency(quote.bid)} / ${formatCurrency(quote.ask)}.`
            : `Option quote unavailable; using intrinsic value as a floor estimate (${quoteError?.message ?? "provider unavailable"}).`,
          `Intrinsic: ${formatCurrency(intrinsic)}. Estimated time value: ${formatCurrency(timeValue)}.`,
          ...(breakeven === undefined ? [] : [`Entry breakeven: ${formatCurrency(breakeven)}.`]),
          ...(postureLine ? [postureLine] : []),
          ...(currentValue === undefined
            ? []
            : [
                `Current value: ${formatCurrency(currentValue)} for ${trade.quantity} contract${trade.quantity === 1 ? "" : "s"}.`,
              ]),
          ...(valueDelta === undefined ? [] : [formatTradeValueDelta(trade.posture, valueDelta)]),
          quote
            ? `Source: ${quote.source}${quote.timestamp ? `, ${quote.timestamp}` : ""}. Educational only.`
            : `Source: ${underlying.source}${underlying.timestamp ? `, ${underlying.timestamp}` : ""}; contract value is estimated from intrinsic value only. Educational only.`,
          `OCC: ${contract.occSymbol}`,
          "Want me to set an alert for the next level?",
        ];
        return {
          text: analysis.join("\n"),
        };
      } catch (error) {
        return { text: `Contract quote unavailable: ${(error as Error).message}` };
      }
    },
  };
}

function createChartCommand(options: {
  pluginConfig: unknown;
  stateDir: string;
  marketDataClient?: MarketDataClient;
}): OpenClawPluginCommandDefinition {
  return {
    name: "chart",
    description: "Fetch a data-driven intraday stock chart.",
    acceptsArgs: true,
    channels: ["discord"],
    requireAuth: true,
    handler: async (ctx) => {
      const symbol = ctx.args?.trim().split(/\s+/)[0]?.replace(/^\$/, "").toUpperCase();
      if (!symbol) {
        return { text: "Usage: /chart AAPL" };
      }
      const { marketData } = createCommandContext(options);
      try {
        const bars = await marketData.bars(symbol, { timeframe: "5Min", limit: 20 });
        return await renderChartFile({ symbol, bars, stateDir: options.stateDir });
      } catch (error) {
        return { text: `Chart unavailable: ${(error as Error).message}` };
      }
    },
  };
}

function createAlertCommand(options: {
  pluginConfig: unknown;
  stateDir: string;
  marketDataClient?: MarketDataClient;
}): OpenClawPluginCommandDefinition {
  return {
    name: "alert",
    description: "Preview, confirm, and save Gesahni market alerts.",
    acceptsArgs: true,
    channels: ["discord"],
    requireAuth: true,
    handler: async (ctx) => {
      const { config, alertStore } = createCommandContext(options);
      const args = ctx.args?.trim() ?? "";
      const [action, id] = args.split(/\s+/);
      if (action?.toLowerCase() === "confirm") {
        if (!id && isDirectDiscordContext(ctx)) {
          const confirmed = await alertStore.confirmLatest({
            scope: "private",
            senderId: ctx.senderId,
          });
          return {
            text: confirmed ? formatAlertSaved(confirmed) : "No pending private alert to confirm.",
          };
        }
        if (!id) {
          return { text: "Usage: /alert confirm alrt_..." };
        }
        const confirmed = await alertStore.confirm(id, ctx.senderId);
        return {
          text: confirmed ? formatAlertSaved(confirmed) : "Alert preview not found or not yours.",
        };
      }
      if (action?.toLowerCase() === "delete") {
        if (!id) {
          return { text: "Usage: /alert delete alrt_..." };
        }
        const deleted = await alertStore.delete(id, ctx.senderId);
        return {
          text: deleted
            ? `Alert deleted: ${formatAlertInstrument(deleted.instrument)}.`
            : "Alert not found or not yours.",
        };
      }
      const alert = parseAlertRequest({
        input: args,
        config,
        channel: ctx.channel,
        senderId: ctx.senderId,
        currentDiscordChannelId: getDiscordChannelId(ctx),
        defaultScope: resolveDefaultScope(ctx),
      });
      if (!alert) {
        return {
          text: "Usage: /alert group AAPL above 210 or /alert me MU 647.5C 5/8 above 31",
        };
      }
      if (
        alert.scope === "group" &&
        config.alerts?.groupCreation === "owner" &&
        !ctx.senderIsOwner
      ) {
        return { text: "Group alert creation is owner-only right now." };
      }
      const savedPreview = await alertStore.preview(alert);
      return { text: formatAlertPreview(savedPreview) };
    },
  };
}

function createAlertsCommand(options: {
  pluginConfig: unknown;
  stateDir: string;
  marketDataClient?: MarketDataClient;
}): OpenClawPluginCommandDefinition {
  return {
    name: "alerts",
    description: "List active Gesahni alerts.",
    acceptsArgs: true,
    channels: ["discord"],
    requireAuth: true,
    handler: async (ctx) => {
      const { alertStore } = createCommandContext(options);
      const requestedScope = ctx.args ?? "";
      const scope = /\b(me|private|personal)\b/i.test(requestedScope)
        ? "private"
        : /\b(group|shared|public)\b/i.test(requestedScope)
          ? "group"
          : resolveDefaultScope(ctx);
      if (scope === "private" && !isDirectDiscordContext(ctx)) {
        return { text: "Private alerts can only be listed in DM." };
      }
      const alerts = await alertStore.list({ scope, senderId: ctx.senderId });
      return { text: formatAlertList(alerts, scope) };
    },
  };
}

function createStockStatusCommand(options: {
  pluginConfig: unknown;
  stateDir: string;
  marketDataClient?: MarketDataClient;
}): OpenClawPluginCommandDefinition {
  return {
    name: "stockstatus",
    description: "Show Gesahni stock-room command status.",
    acceptsArgs: false,
    channels: ["discord"],
    requireAuth: true,
    handler: () => {
      const { config, marketData } = createCommandContext(options);
      return {
        text: [
          "Gesahni stock-room status:",
          `- market data: ${marketData.status()}`,
          `- group alert channel: #${config.alerts?.groupChannelName ?? "stock-alerts"}${config.alerts?.groupChannelId ? ` (${config.alerts.groupChannelId})` : " (id not configured)"}`,
          `- alert cadence: ${config.alerts?.pollSeconds ?? 30}s regular-hours checks`,
          `- alert cooldown: ${config.alerts?.cooldownSeconds ?? 300}s`,
          "- fast commands: /quote, /contract, /chart, /alert, /alerts",
        ].join("\n"),
      };
    },
  };
}

function createStockHelpCommand(): OpenClawPluginCommandDefinition {
  return {
    name: "stockhelp",
    description: "Show Gesahni stock-room commands.",
    acceptsArgs: false,
    channels: ["discord"],
    requireAuth: true,
    handler: () => ({
      text: [
        "Gesahni stock commands:",
        "/quote AAPL - current stock quote.",
        "/contract sold 1 MU 647.5C 5/8 for 19.50 - option math with live underlying context.",
        "/alert group AAPL above 210 - preview a shared alert.",
        "/alert confirm <id> - save an alert after preview.",
        "/alerts group - list shared alerts.",
        "/alerts me - list private alerts in DM only.",
        "/chart AAPL - data chart when chart bars are configured.",
        "/stockstatus - show market-data and alert setup.",
      ].join("\n"),
    }),
  };
}

function resolveDiscordStockRoomPromptGuidance(params: {
  prompt: string;
  messageProvider?: string;
}): string | undefined {
  const isDiscordTurn = params.messageProvider === "discord";
  const looksLikeGesahniTurn =
    /(^|\s)@?gesahni\b|stock[- ]room|\/(quote|contract|chart|alert|alerts|stockhelp|stockstatus)\b/i.test(
      params.prompt,
    );
  if (!isDiscordTurn && !looksLikeGesahniTurn) {
    return undefined;
  }
  return [
    "Gesahni Discord stock-room voice:",
    "- You are Gesahni, a Discord stock-room assistant. Sound relaxed, sharp, and a little fun without turning serious financial replies into jokes.",
    "- Lead with the useful read first, then the key price/math/level context, then the next action or follow-up question.",
    '- Use natural short openers when they fit: "Yeah", "Quick read", "That setup is interesting", or "I would not fake that price".',
    "- Use at most one in-message emoji when it adds signal. Do not decorate every bullet or every answer.",
    "- Prefer Discord reactions for lightweight state when the message tool is available: 👀 for checking, ✅ for saved/confirmed, 🔒 for private-only redirects, ⚠️ for data/provider issues, and 📈 for chart-focused replies or chart attachments.",
    "- In public channels, keep personal/private lists private. Redirect watch-list disclosure to DM, but allow public requests to add a visible ticker or alert when policy allows it.",
    "- Be transparent about missing live data, delayed feeds, screenshots, and inference. Never make up a price, fill, position, or account detail.",
  ].join("\n");
}

function resolveScreenshotPromptGuidance(prompt: string): string | undefined {
  if (
    !/(gesahni|<media:image>|MediaPath|ReplyToBody|screenshot|chart image|option screenshot)/i.test(
      prompt,
    )
  ) {
    return undefined;
  }
  return [
    "Gesahni Discord screenshot guidance:",
    "- If the user asks about an image or replied-to image, separate what is visible in the image from live market data, inference, and missing info.",
    "- For option screenshots, extract symbol, expiry, strike, right, quantity, entry price, visible mark, and visible P/L when present.",
    "- Fetch live/current market data before doing price-sensitive math; if live data is unavailable, say that directly and label any intrinsic-value math as an estimate.",
    "- Keep public-channel replies concise and offer a follow-up alert/watch action when a ticker or contract is actionable.",
  ].join("\n");
}

function resolvePromptGuidance(params: {
  prompt: string;
  messageProvider?: string;
}): string | undefined {
  const sections = [
    resolveDiscordStockRoomPromptGuidance(params),
    resolveScreenshotPromptGuidance(params.prompt),
  ].filter((section): section is string => Boolean(section));
  return sections.length ? sections.join("\n\n") : undefined;
}

function resolveServicePluginConfig(ctxConfig: unknown, fallback: unknown): unknown {
  if (typeof ctxConfig !== "object" || ctxConfig === null) {
    return fallback;
  }
  const plugins = (ctxConfig as { plugins?: unknown }).plugins;
  if (typeof plugins !== "object" || plugins === null) {
    return fallback;
  }
  const entries = (plugins as { entries?: unknown }).entries;
  if (typeof entries !== "object" || entries === null) {
    return fallback;
  }
  const entry = (entries as Record<string, unknown>).gesahni;
  if (typeof entry !== "object" || entry === null) {
    return fallback;
  }
  return (entry as { config?: unknown }).config ?? fallback;
}

function normalizeDispatchBody(input: string | undefined): string {
  return (input ?? "").trim();
}

function hasAlertThreshold(input: string): boolean {
  return /\b(?:above|over|breaks?|hits?|>=|at least|below|under|<=|at most)\s+\$?\d+(?:\.\d+)?/i.test(
    input,
  );
}

function isAlertCreateIntent(input: string): boolean {
  return (
    hasAlertThreshold(input) &&
    /\b(alert|alerts|notify|notification|ping|watch|let me know)\b/i.test(input)
  );
}

function isAlertListIntent(input: string): boolean {
  return /^\/?alerts(?:\s+(?:me|private|personal))?\s*$/i.test(input);
}

function isConfirmIntent(input: string): boolean {
  return /^\/?(?:alert\s+)?confirm\s*$/i.test(input);
}

function isPendingCancelIntent(input: string): boolean {
  return /^\/?(?:alert\s+)?cancel\s*$/i.test(input);
}

function isAlertDeleteIntent(input: string): boolean {
  return /\b(?:delete|cancel|remove)\b/i.test(input) && /\balert\b/i.test(input);
}

function isPublicAlertMutationIntent(input: string): boolean {
  return (
    /\balert\b/i.test(input) &&
    /\b(?:create|set|add|save|public|group|shared|confirm|delete|cancel|remove)\b/i.test(input)
  );
}

function parseAlertDeletionCriteria(input: string): {
  symbol?: string;
  conditionValue?: number;
} {
  const ignored = new Set(["delete", "cancel", "remove", "the", "alert", "me", "if"]);
  const symbol = (input.match(/\$?[A-Za-z]{1,6}\b/g) ?? [])
    .map((token) => token.replace(/^\$/, "").toUpperCase())
    .find((token) => !ignored.has(token.toLowerCase()));
  const conditionValueMatch = /\$?(\d+(?:\.\d+)?)/.exec(input);
  const conditionValue = conditionValueMatch
    ? Number.parseFloat(conditionValueMatch[1])
    : undefined;
  return {
    ...(symbol ? { symbol } : {}),
    ...(conditionValue !== undefined && Number.isFinite(conditionValue) ? { conditionValue } : {}),
  };
}

function publicAlertMutationBlockedText(): string {
  return [
    "I can't create, confirm, update, or delete alerts from a public Discord channel.",
    "DM Gesahni with the exact alert, like: AAPL above 210.",
  ].join("\n");
}

async function handleStockAlertDispatch(
  event: {
    content: string;
    body?: string;
    channel?: string;
    sessionKey?: string;
    senderId?: string;
    isGroup?: boolean;
  },
  ctx: {
    conversationId?: string;
    sessionKey?: string;
    senderId?: string;
  },
  options: {
    pluginConfig: unknown;
    stateDir: string;
    marketDataClient?: MarketDataClient;
  },
): Promise<{ handled: boolean; text?: string } | undefined> {
  if (
    !isDiscordDispatchContext({
      channel: event.channel,
      sessionKey: event.sessionKey,
      contextSessionKey: ctx.sessionKey,
    })
  ) {
    return undefined;
  }

  const input = normalizeDispatchBody(event.body ?? event.content);
  if (!input) {
    return undefined;
  }

  const isDirect = isDirectDiscordDispatch({
    isGroup: event.isGroup,
    sessionKey: event.sessionKey,
    contextSessionKey: ctx.sessionKey,
    conversationId: ctx.conversationId,
  });
  const senderId = ctx.senderId ?? event.senderId;
  const { config, alertStore } = createCommandContext(options);

  if (!isDirect) {
    return isPublicAlertMutationIntent(input) || isAlertCreateIntent(input)
      ? { handled: true, text: publicAlertMutationBlockedText() }
      : undefined;
  }

  if (isAlertListIntent(input)) {
    const alerts = await alertStore.list({ scope: "private", senderId });
    return { handled: true, text: formatAlertList(alerts, "private") };
  }

  if (isConfirmIntent(input)) {
    const confirmed = await alertStore.confirmLatest({ scope: "private", senderId });
    return {
      handled: true,
      text: confirmed ? formatAlertSaved(confirmed) : "No pending private alert to confirm.",
    };
  }

  if (isPendingCancelIntent(input)) {
    const deleted = await alertStore.deleteLatestPending({ scope: "private", senderId });
    return {
      handled: true,
      text: deleted
        ? `Discarded pending private alert for ${formatAlertInstrument(deleted.instrument)}.`
        : "No pending private alert to cancel.",
    };
  }

  if (isAlertDeleteIntent(input)) {
    const deleted = await alertStore.deleteMatching({
      scope: "private",
      senderId,
      ...parseAlertDeletionCriteria(input),
    });
    return {
      handled: true,
      text: deleted
        ? `Deleted private alert for ${formatAlertInstrument(deleted.instrument)}.`
        : "No matching private alert found.",
    };
  }

  if (!isAlertCreateIntent(input)) {
    return undefined;
  }

  const alert = parseAlertRequest({
    input,
    config,
    channel: "discord",
    senderId,
    defaultScope: "private",
  });
  if (!alert) {
    return undefined;
  }
  const savedPreview = await alertStore.preview(alert);
  return { handled: true, text: formatAlertPreview(savedPreview) };
}

function createAlertRunnerService(options: {
  pluginConfig: unknown;
  marketDataClient?: MarketDataClient;
}): OpenClawPluginService {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  return {
    id: "gesahni-alert-runner",
    start(ctx) {
      const runOnce = async () => {
        if (running) {
          return;
        }
        running = true;
        try {
          const pluginConfig = resolveServicePluginConfig(ctx.config, options.pluginConfig);
          const config = readGesahniConfig(pluginConfig);
          await runAlertCheck({
            cfg: ctx.config,
            store: createAlertStore(ctx.stateDir),
            marketData: options.marketDataClient ?? createMarketDataClient(config),
            onError: (error, alert) => {
              ctx.logger.warn?.(
                `gesahni alert check failed for ${alert.id}: ${(error as Error).message}`,
              );
            },
          });
        } finally {
          running = false;
        }
      };
      void runOnce();
      const config = readGesahniConfig(options.pluginConfig);
      timer = setInterval(
        () => {
          void runOnce();
        },
        (config.alerts?.pollSeconds ?? 30) * 1000,
      );
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

export default definePluginEntry({
  id: "gesahni",
  name: "Gesahni",
  description: "Stock-room market commands and alert previews.",
  register(api) {
    const options = {
      pluginConfig: api.pluginConfig,
      stateDir: api.runtime.state.resolveStateDir(),
    };
    api.registerCommand(createQuoteCommand(options));
    api.registerCommand(createContractCommand(options));
    api.registerCommand(createChartCommand(options));
    api.registerCommand(createAlertCommand(options));
    api.registerCommand(createAlertsCommand(options));
    api.registerCommand(createStockStatusCommand(options));
    api.registerCommand(createStockHelpCommand());
    api.registerService(createAlertRunnerService({ pluginConfig: api.pluginConfig }));
    api.on("before_dispatch", async (event, ctx) => handleStockAlertDispatch(event, ctx, options));
    api.on("before_prompt_build", (event, ctx) => {
      const appendSystemContext = resolvePromptGuidance({
        prompt: event.prompt,
        messageProvider: ctx.messageProvider,
      });
      return appendSystemContext ? { appendSystemContext } : undefined;
    });
  },
});

// eslint-disable-next-line no-underscore-dangle
export const __testing = {
  createQuoteCommand,
  createContractCommand,
  createChartCommand,
  createAlertCommand,
  createAlertsCommand,
  createStockStatusCommand,
  createStockHelpCommand,
  resolveDiscordStockRoomPromptGuidance,
  resolvePromptGuidance,
  createAlertRunnerService,
  resolveScreenshotPromptGuidance,
  handleStockAlertDispatch,
};
