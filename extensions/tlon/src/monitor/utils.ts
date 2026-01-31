import { normalizeShip } from "../targets.js";

export function formatModelName(modelString?: string | null): string {
  if (!modelString) {
    return "AI";
  }
  const modelName = modelString.includes("/") ? modelString.split("/")[1] : modelString;
  const modelMappings: Record<string, string> = {
    "claude-opus-4-5": "Claude Opus 4.5",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-3-5": "Claude Sonnet 3.5",
    "gpt-4o": "GPT-4o",
    "gpt-4-turbo": "GPT-4 Turbo",
    "gpt-4": "GPT-4",
    "gemini-2.0-flash": "Gemini 2.0 Flash",
    "gemini-pro": "Gemini Pro",
  };

  if (modelMappings[modelName]) {
    return modelMappings[modelName];
  }
  return modelName
    .replace(/-/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function isBotMentioned(messageText: string, botShipName: string): boolean {
  if (!messageText || !botShipName) {
    return false;
  }
  const normalizedBotShip = normalizeShip(botShipName);
  const escapedShip = normalizedBotShip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`(^|\\s)${escapedShip}(?=\\s|$)`, "i");
  return mentionPattern.test(messageText);
}

export function isDmAllowed(senderShip: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) {
    return true;
  }
  const normalizedSender = normalizeShip(senderShip);
  return allowlist.map((ship) => normalizeShip(ship)).some((ship) => ship === normalizedSender);
}

export function extractMessageText(content: unknown): string {
  if (!content || !Array.isArray(content)) {
    return "";
  }

  return content
    .map((block: any) => {
      if (block.inline && Array.isArray(block.inline)) {
        return block.inline
          .map((item: any) => {
            if (typeof item === "string") {
              return item;
            }
            if (item && typeof item === "object") {
              if (item.ship) {
                return item.ship;
              }
              if (item.break !== undefined) {
                return "\n";
              }
              if (item.link && item.link.href) {
                return item.link.href;
              }
            }
            return "";
          })
          .join("");
      }
      return "";
    })
    .join("\n")
    .trim();
}

export function isSummarizationRequest(messageText: string): boolean {
  const patterns = [
    /summarize\s+(this\s+)?(channel|chat|conversation)/i,
    /what\s+did\s+i\s+miss/i,
    /catch\s+me\s+up/i,
    /channel\s+summary/i,
    /tldr/i,
  ];
  return patterns.some((pattern) => pattern.test(messageText));
}

export function formatChangesDate(daysAgo = 5): string {
  const now = new Date();
  const targetDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;
  const day = targetDate.getDate();
  return `~${year}.${month}.${day}..20.19.51..9b9d`;
}
