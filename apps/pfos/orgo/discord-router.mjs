import { AGENT_PROFILES } from "./profiles.mjs";

const ALIASES = {
  main: AGENT_PROFILES.main,
  platinumfang: AGENT_PROFILES.main,
  pfmain: AGENT_PROFILES.main,
  content: AGENT_PROFILES.youtube,
  yt: AGENT_PROFILES.youtube,
  youtube: AGENT_PROFILES.youtube,
  trading: AGENT_PROFILES.trading,
  trade: AGENT_PROFILES.trading,
};

function normalize(raw) {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function profileFromAlias(alias) {
  return ALIASES[normalize(alias)] ?? AGENT_PROFILES.main;
}

function inferTaskType(profile, text) {
  const lower = text.toLowerCase();
  if (profile === AGENT_PROFILES.youtube) {
    if (lower.includes("thumbnail")) return "yt.thumbnail.briefs";
    if (lower.includes("script")) return "yt.script";
    return "yt.content.plan";
  }
  if (profile === AGENT_PROFILES.trading) {
    if (lower.includes("backtest")) return "trade.backtest.run";
    if (lower.includes("strategy")) return "trade.strategy.dev";
    return "trade.market.scan";
  }
  if (lower.includes("scrape")) return "work.research.scrape";
  if (lower.includes("calendar") || lower.includes("schedule")) return "daily.calendar.plan";
  return "daily.task";
}

export function routeDiscordMessage(message) {
  const text = String(message ?? "").trim();
  if (!text) return null;

  // Supported patterns:
  // 1) !agent <main|content|trading> <message>
  // 2) @pf-main <message> / @pf-content <message> / @pf-trading <message>
  const command = text.match(/^!agent\s+(\S+)\s+([\s\S]+)$/i);
  if (command) {
    const profile = profileFromAlias(command[1]);
    const body = command[2].trim();
    return {
      profile,
      taskType: inferTaskType(profile, body),
      payload: { source: "discord", message: body, raw: text },
    };
  }

  const mention = text.match(/^@([a-z0-9_-]+)\s+([\s\S]+)$/i);
  if (mention) {
    const profile = profileFromAlias(mention[1]);
    const body = mention[2].trim();
    return {
      profile,
      taskType: inferTaskType(profile, body),
      payload: { source: "discord", message: body, raw: text },
    };
  }

  // Default route to main profile when there is no explicit selector.
  return {
    profile: AGENT_PROFILES.main,
    taskType: inferTaskType(AGENT_PROFILES.main, text),
    payload: { source: "discord", message: text, raw: text },
  };
}
