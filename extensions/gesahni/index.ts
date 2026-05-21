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
import { parseOptionContractWithDefaultExpiry, parseOptionTradeContext } from "./src/options.js";
import { createWatchlistStore, formatWatchlist, parseWatchlistSymbol } from "./src/watchlist.js";

const passiveTickerReadCache = new Map<string, number>();

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

function formatCompactQuoteLine(quote: MarketQuote): string {
  return `${quote.symbol} ${formatCurrency(readQuoteMark(quote))} | bid/ask ${formatCurrency(
    quote.bid,
  )}/${formatCurrency(quote.ask)} | ${quote.source} | educational only.`;
}

function unavailableText(label: string): string {
  return `${label} unavailable right now. Check /stockstatus and try again.`;
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
  const watchlistStore = createWatchlistStore(options.stateDir);
  return { config, marketData, alertStore, watchlistStore };
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
      } catch {
        return { text: unavailableText("Quote") };
      }
    },
  };
}

function createContractCommand(options: {
  pluginConfig: unknown;
  stateDir: string;
  marketDataClient?: MarketDataClient;
  now?: () => Date;
}): OpenClawPluginCommandDefinition {
  return {
    name: "contract",
    description: "Fetch a fast option-contract quote.",
    acceptsArgs: true,
    channels: ["discord"],
    requireAuth: true,
    handler: async (ctx) => {
      const contract = parseOptionContractWithDefaultExpiry(ctx.args ?? "", options.now?.());
      if (!contract) {
        return { text: "Usage: /contract AAPL 210C or /contract MU 647.5C 5/8" };
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
            : "Option quote unavailable; using intrinsic value as a floor estimate (provider unavailable).",
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
      } catch {
        return { text: unavailableText("Contract quote") };
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
      } catch {
        return { text: unavailableText("Chart") };
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
        "Gesahni stock-room commands:",
        "Public read-only:",
        "/quote AAPL - current stock quote.",
        "/contract AAPL 210C - option math with live underlying context; expiry defaults to the upcoming Friday.",
        "/chart AAPL - data chart when chart bars are configured.",
        "$AAPL or watch AAPL - compact read-only ticker context in approved stock-room channels.",
        "DM actions:",
        "alert me if AAPL breaks 300 - preview a private alert.",
        "confirm - save the latest private alert preview.",
        "list alerts or /alerts - list private alerts.",
        "delete the AAPL 300 alert - delete a private alert.",
        "watch AAPL / unwatch AAPL / list watchlist - manage your private watchlist.",
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
  return (
    /^\/?alerts(?:\s+(?:me|private|personal))?\s*$/i.test(input) ||
    /^list\s+(?:my\s+)?alerts\s*$/i.test(input)
  );
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

function parseWatchlistAddIntent(input: string): string | null {
  const match = /^\/?watch\s+(\$?[A-Za-z]{1,6})\s*$/i.exec(input.trim());
  return match ? parseWatchlistSymbol(match[1]) : null;
}

function parseWatchlistRemoveIntent(input: string): string | null {
  const match = /^\/?(?:unwatch|remove\s+from\s+watchlist)\s+(\$?[A-Za-z]{1,6})\s*$/i.exec(
    input.trim(),
  );
  return match ? parseWatchlistSymbol(match[1]) : null;
}

function isWatchlistListIntent(input: string): boolean {
  return /^\/?(?:watchlist|list\s+(?:my\s+)?watchlist)\s*$/i.test(input);
}

function parsePassiveTickerReadIntent(input: string): string | null {
  const trimmed = input.trim();
  const watchSymbol = parseWatchlistAddIntent(trimmed);
  if (watchSymbol) {
    return watchSymbol;
  }
  const cashtags = [...trimmed.matchAll(/\$([A-Za-z]{1,6})\b/g)].map((match) =>
    parseWatchlistSymbol(match[1] ?? ""),
  );
  const unique = [...new Set(cashtags.filter((symbol): symbol is string => Boolean(symbol)))];
  if (unique.length !== 1 || trimmed.length > 120) {
    return null;
  }
  return unique[0] ?? null;
}

function resolveApprovedPublicChannelIds(
  config: ReturnType<typeof readGesahniConfig>,
): Set<string> {
  const channelIds = new Set(config.stockRoom?.publicChannelIds ?? []);
  if (config.alerts?.groupChannelId) {
    channelIds.add(config.alerts.groupChannelId);
  }
  return channelIds;
}

function isApprovedPublicStockRoomChannel(params: {
  config: ReturnType<typeof readGesahniConfig>;
  channelId?: string;
  conversationId?: string;
}): boolean {
  if (params.config.stockRoom?.passiveTickerRead === false) {
    return false;
  }
  const approvedIds = resolveApprovedPublicChannelIds(params.config);
  if (approvedIds.size === 0) {
    return false;
  }
  const candidates = [params.channelId, params.conversationId?.replace(/^channel:/, "")]
    .filter((candidate): candidate is string => Boolean(candidate))
    .flatMap((candidate) => [candidate, `channel:${candidate}`]);
  return candidates.some((candidate) => approvedIds.has(candidate));
}

function shouldSuppressPassiveTickerRead(params: {
  channelId: string;
  symbol: string;
  cooldownSeconds: number;
  nowMs?: number;
}): boolean {
  const nowMs = params.nowMs ?? Date.now();
  const key = `${params.channelId}:${params.symbol}`;
  const lastMs = passiveTickerReadCache.get(key);
  if (lastMs !== undefined && nowMs - lastMs < params.cooldownSeconds * 1000) {
    return true;
  }
  passiveTickerReadCache.set(key, nowMs);
  return false;
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

function requireDiscordSenderId(senderId: string | undefined): string | undefined {
  return senderId?.trim() || undefined;
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
  const { config, marketData, alertStore, watchlistStore } = createCommandContext(options);

  if (!isDirect) {
    if (isPublicAlertMutationIntent(input) || isAlertCreateIntent(input)) {
      return { handled: true, text: publicAlertMutationBlockedText() };
    }
    const symbol = parsePassiveTickerReadIntent(input);
    if (
      symbol &&
      isApprovedPublicStockRoomChannel({
        config,
        channelId: event.channel,
        conversationId: ctx.conversationId,
      })
    ) {
      const channelId = event.channel ?? ctx.conversationId ?? "discord-public";
      if (
        shouldSuppressPassiveTickerRead({
          channelId,
          symbol,
          cooldownSeconds: config.stockRoom?.passiveTickerCooldownSeconds ?? 60,
        })
      ) {
        return { handled: true };
      }
      try {
        return { handled: true, text: formatCompactQuoteLine(await marketData.quote(symbol)) };
      } catch {
        return { handled: true, text: unavailableText("Ticker read") };
      }
    }
    if (
      isWatchlistListIntent(input) ||
      parseWatchlistAddIntent(input) ||
      parseWatchlistRemoveIntent(input)
    ) {
      return { handled: true, text: "Private watchlist actions are DM-only." };
    }
    return undefined;
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

  const watchlistAddSymbol = parseWatchlistAddIntent(input);
  if (watchlistAddSymbol) {
    const ownerId = requireDiscordSenderId(senderId);
    if (!ownerId) {
      return { handled: true, text: "Private watchlist actions need a Discord sender id." };
    }
    await watchlistStore.add({ senderId: ownerId, symbol: watchlistAddSymbol });
    return { handled: true, text: `Added ${watchlistAddSymbol} to your private watchlist.` };
  }

  const watchlistRemoveSymbol = parseWatchlistRemoveIntent(input);
  if (watchlistRemoveSymbol) {
    const ownerId = requireDiscordSenderId(senderId);
    if (!ownerId) {
      return { handled: true, text: "Private watchlist actions need a Discord sender id." };
    }
    const removed = await watchlistStore.remove({
      senderId: ownerId,
      symbol: watchlistRemoveSymbol,
    });
    return {
      handled: true,
      text: removed
        ? `Removed ${watchlistRemoveSymbol} from your private watchlist.`
        : `${watchlistRemoveSymbol} is not on your private watchlist.`,
    };
  }

  if (isWatchlistListIntent(input)) {
    const ownerId = requireDiscordSenderId(senderId);
    if (!ownerId) {
      return { handled: true, text: "Private watchlist actions need a Discord sender id." };
    }
    const records = await watchlistStore.list({ senderId: ownerId });
    return { handled: true, text: formatWatchlist(records) };
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
  resetPassiveTickerReadCache: () => passiveTickerReadCache.clear(),
};
