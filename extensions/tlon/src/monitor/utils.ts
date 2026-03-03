import { normalizeShip } from "../targets.js";

// Cite types for message references
export interface ChanCite {
  chan: { nest: string; where: string };
}
export interface GroupCite {
  group: string;
}
export interface DeskCite {
  desk: { flag: string; where: string };
}
export interface BaitCite {
  bait: { group: string; graph: string; where: string };
}
export type Cite = ChanCite | GroupCite | DeskCite | BaitCite;

export interface ParsedCite {
  type: "chan" | "group" | "desk" | "bait";
  nest?: string;
  author?: string;
  postId?: string;
  group?: string;
  flag?: string;
  where?: string;
}

// Extract all cites from message content
export function extractCites(content: unknown): ParsedCite[] {
  if (!content || !Array.isArray(content)) {
    return [];
  }

  const cites: ParsedCite[] = [];

  for (const verse of content) {
    if (verse?.block?.cite && typeof verse.block.cite === "object") {
      const cite = verse.block.cite;

      if (cite.chan && typeof cite.chan === "object") {
        const { nest, where } = cite.chan;
        const whereMatch = where?.match(/\/msg\/(~[a-z-]+)\/(.+)/);
        cites.push({
          type: "chan",
          nest,
          where,
          author: whereMatch?.[1],
          postId: whereMatch?.[2],
        });
      } else if (cite.group && typeof cite.group === "string") {
        cites.push({ type: "group", group: cite.group });
      } else if (cite.desk && typeof cite.desk === "object") {
        cites.push({ type: "desk", flag: cite.desk.flag, where: cite.desk.where });
      } else if (cite.bait && typeof cite.bait === "object") {
        cites.push({
          type: "bait",
          group: cite.bait.group,
          nest: cite.bait.graph,
          where: cite.bait.where,
        });
      }
    }
  }

  return cites;
}

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

export function isBotMentioned(
  messageText: string,
  botShipName: string,
  nickname?: string,
): boolean {
  if (!messageText || !botShipName) {
    return false;
  }

  // Check for @all mention
  if (/@all\b/i.test(messageText)) {
    return true;
  }

  // Check for ship mention
  const normalizedBotShip = normalizeShip(botShipName);
  const escapedShip = normalizedBotShip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`(^|\\s)${escapedShip}(?=\\s|$)`, "i");
  if (mentionPattern.test(messageText)) {
    return true;
  }

  // Check for nickname mention (case-insensitive, word boundary)
  if (nickname) {
    const escapedNickname = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nicknamePattern = new RegExp(`(^|\\s)${escapedNickname}(?=\\s|$|[,!?.])`, "i");
    if (nicknamePattern.test(messageText)) {
      return true;
    }
  }

  return false;
}

/**
 * Strip bot ship mention from message text for command detection.
 * "~bot-ship /status" → "/status"
 */
export function stripBotMention(messageText: string, botShipName: string): string {
  if (!messageText || !botShipName) return messageText;
  return messageText.replace(normalizeShip(botShipName), "").trim();
}

export function isDmAllowed(senderShip: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) {
    return false;
  }
  const normalizedSender = normalizeShip(senderShip);
  return allowlist.map((ship) => normalizeShip(ship)).some((ship) => ship === normalizedSender);
}

/**
 * Check if a group invite from a ship should be auto-accepted.
 *
 * SECURITY: Fail-safe to deny. If allowlist is empty or undefined,
 * ALL invites are rejected - even if autoAcceptGroupInvites is enabled.
 * This prevents misconfigured bots from accepting malicious invites.
 */
export function isGroupInviteAllowed(
  inviterShip: string,
  allowlist: string[] | undefined,
): boolean {
  // SECURITY: Fail-safe to deny when no allowlist configured
  if (!allowlist || allowlist.length === 0) {
    return false;
  }
  const normalizedInviter = normalizeShip(inviterShip);
  return allowlist.map((ship) => normalizeShip(ship)).some((ship) => ship === normalizedInviter);
}

// Helper to recursively extract text from inline content
function extractInlineText(items: any[]): string {
  return items
    .map((item: any) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object") {
        if (item.ship) {
          return item.ship;
        }
        if ("sect" in item) {
          return `@${item.sect || "all"}`;
        }
        if (item["inline-code"]) {
          return `\`${item["inline-code"]}\``;
        }
        if (item.code) {
          return `\`${item.code}\``;
        }
        if (item.link && item.link.href) {
          return item.link.content || item.link.href;
        }
        if (item.bold && Array.isArray(item.bold)) {
          return `**${extractInlineText(item.bold)}**`;
        }
        if (item.italics && Array.isArray(item.italics)) {
          return `*${extractInlineText(item.italics)}*`;
        }
        if (item.strike && Array.isArray(item.strike)) {
          return `~~${extractInlineText(item.strike)}~~`;
        }
      }
      return "";
    })
    .join("");
}

export function extractMessageText(content: unknown): string {
  if (!content || !Array.isArray(content)) {
    return "";
  }

  return content
    .map((verse: any) => {
      // Handle inline content (text, ships, links, etc.)
      if (verse.inline && Array.isArray(verse.inline)) {
        return verse.inline
          .map((item: any) => {
            if (typeof item === "string") {
              return item;
            }
            if (item && typeof item === "object") {
              if (item.ship) {
                return item.ship;
              }
              // Handle sect (role mentions like @all)
              if ("sect" in item) {
                return `@${item.sect || "all"}`;
              }
              if (item.break !== undefined) {
                return "\n";
              }
              if (item.link && item.link.href) {
                return item.link.href;
              }
              // Handle inline code (Tlon uses "inline-code" key)
              if (item["inline-code"]) {
                return `\`${item["inline-code"]}\``;
              }
              if (item.code) {
                return `\`${item.code}\``;
              }
              // Handle bold/italic/strike - recursively extract text
              if (item.bold && Array.isArray(item.bold)) {
                return `**${extractInlineText(item.bold)}**`;
              }
              if (item.italics && Array.isArray(item.italics)) {
                return `*${extractInlineText(item.italics)}*`;
              }
              if (item.strike && Array.isArray(item.strike)) {
                return `~~${extractInlineText(item.strike)}~~`;
              }
              // Handle blockquote inline
              if (item.blockquote && Array.isArray(item.blockquote)) {
                return `> ${extractInlineText(item.blockquote)}`;
              }
            }
            return "";
          })
          .join("");
      }

      // Handle block content (images, code blocks, etc.)
      if (verse.block && typeof verse.block === "object") {
        const block = verse.block;

        // Image blocks
        if (block.image && block.image.src) {
          const alt = block.image.alt ? ` (${block.image.alt})` : "";
          return `\n${block.image.src}${alt}\n`;
        }

        // Code blocks
        if (block.code && typeof block.code === "object") {
          const lang = block.code.lang || "";
          const code = block.code.code || "";
          return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
        }

        // Header blocks
        if (block.header && typeof block.header === "object") {
          const text =
            block.header.content
              ?.map((item: any) => (typeof item === "string" ? item : ""))
              .join("") || "";
          return `\n## ${text}\n`;
        }

        // Cite/quote blocks - parse the reference structure
        if (block.cite && typeof block.cite === "object") {
          const cite = block.cite;

          // ChanCite - reference to a channel message
          if (cite.chan && typeof cite.chan === "object") {
            const { nest, where } = cite.chan;
            // where is typically /msg/~author/timestamp
            const whereMatch = where?.match(/\/msg\/(~[a-z-]+)\/(.+)/);
            if (whereMatch) {
              const [, author, _postId] = whereMatch;
              return `\n> [quoted: ${author} in ${nest}]\n`;
            }
            return `\n> [quoted from ${nest}]\n`;
          }

          // GroupCite - reference to a group
          if (cite.group && typeof cite.group === "string") {
            return `\n> [ref: group ${cite.group}]\n`;
          }

          // DeskCite - reference to an app/desk
          if (cite.desk && typeof cite.desk === "object") {
            return `\n> [ref: ${cite.desk.flag}]\n`;
          }

          // BaitCite - reference with group+graph context
          if (cite.bait && typeof cite.bait === "object") {
            return `\n> [ref: ${cite.bait.graph} in ${cite.bait.group}]\n`;
          }

          return `\n> [quoted message]\n`;
        }
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
