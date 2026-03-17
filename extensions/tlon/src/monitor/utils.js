import { normalizeShip } from "../targets.js";
function extractCites(content) {
  if (!content || !Array.isArray(content)) {
    return [];
  }
  const cites = [];
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
          postId: whereMatch?.[2]
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
          where: cite.bait.where
        });
      }
    }
  }
  return cites;
}
function formatModelName(modelString) {
  if (!modelString) {
    return "AI";
  }
  const modelName = modelString.includes("/") ? modelString.split("/")[1] : modelString;
  const modelMappings = {
    "claude-opus-4-5": "Claude Opus 4.5",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-3-5": "Claude Sonnet 3.5",
    "gpt-4o": "GPT-4o",
    "gpt-4-turbo": "GPT-4 Turbo",
    "gpt-4": "GPT-4",
    "gemini-2.0-flash": "Gemini 2.0 Flash",
    "gemini-pro": "Gemini Pro"
  };
  if (modelMappings[modelName]) {
    return modelMappings[modelName];
  }
  return modelName.replace(/-/g, " ").split(" ").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
function isBotMentioned(messageText, botShipName, nickname) {
  if (!messageText || !botShipName) {
    return false;
  }
  if (/@all\b/i.test(messageText)) {
    return true;
  }
  const normalizedBotShip = normalizeShip(botShipName);
  const escapedShip = normalizedBotShip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`(^|\\s)${escapedShip}(?=\\s|$)`, "i");
  if (mentionPattern.test(messageText)) {
    return true;
  }
  if (nickname) {
    const escapedNickname = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nicknamePattern = new RegExp(`(^|\\s)${escapedNickname}(?=\\s|$|[,!?.])`, "i");
    if (nicknamePattern.test(messageText)) {
      return true;
    }
  }
  return false;
}
function stripBotMention(messageText, botShipName) {
  if (!messageText || !botShipName) return messageText;
  return messageText.replace(normalizeShip(botShipName), "").trim();
}
function isDmAllowed(senderShip, allowlist) {
  if (!allowlist || allowlist.length === 0) {
    return false;
  }
  const normalizedSender = normalizeShip(senderShip);
  return allowlist.map((ship) => normalizeShip(ship)).some((ship) => ship === normalizedSender);
}
function isGroupInviteAllowed(inviterShip, allowlist) {
  if (!allowlist || allowlist.length === 0) {
    return false;
  }
  const normalizedInviter = normalizeShip(inviterShip);
  return allowlist.map((ship) => normalizeShip(ship)).some((ship) => ship === normalizedInviter);
}
function renderInlineItem(item, options) {
  if (typeof item === "string") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.ship) {
    return item.ship;
  }
  if ("sect" in item) {
    return `@${item.sect || "all"}`;
  }
  if (options?.allowBreak && item.break !== void 0) {
    return "\n";
  }
  if (item["inline-code"]) {
    return `\`${item["inline-code"]}\``;
  }
  if (item.code) {
    return `\`${item.code}\``;
  }
  if (item.link && item.link.href) {
    return options?.linkMode === "href" ? item.link.href : item.link.content || item.link.href;
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
  if (options?.allowBlockquote && item.blockquote && Array.isArray(item.blockquote)) {
    return `> ${extractInlineText(item.blockquote)}`;
  }
  return "";
}
function extractInlineText(items) {
  return items.map((item) => renderInlineItem(item)).join("");
}
function extractMessageText(content) {
  if (!content || !Array.isArray(content)) {
    return "";
  }
  return content.map((verse) => {
    if (verse.inline && Array.isArray(verse.inline)) {
      return verse.inline.map(
        (item) => renderInlineItem(item, {
          linkMode: "href",
          allowBreak: true,
          allowBlockquote: true
        })
      ).join("");
    }
    if (verse.block && typeof verse.block === "object") {
      const block = verse.block;
      if (block.image && block.image.src) {
        const alt = block.image.alt ? ` (${block.image.alt})` : "";
        return `
${block.image.src}${alt}
`;
      }
      if (block.code && typeof block.code === "object") {
        const lang = block.code.lang || "";
        const code = block.code.code || "";
        return `
\`\`\`${lang}
${code}
\`\`\`
`;
      }
      if (block.header && typeof block.header === "object") {
        const text = block.header.content?.map((item) => typeof item === "string" ? item : "").join("") || "";
        return `
## ${text}
`;
      }
      if (block.cite && typeof block.cite === "object") {
        const cite = block.cite;
        if (cite.chan && typeof cite.chan === "object") {
          const { nest, where } = cite.chan;
          const whereMatch = where?.match(/\/msg\/(~[a-z-]+)\/(.+)/);
          if (whereMatch) {
            const [, author, _postId] = whereMatch;
            return `
> [quoted: ${author} in ${nest}]
`;
          }
          return `
> [quoted from ${nest}]
`;
        }
        if (cite.group && typeof cite.group === "string") {
          return `
> [ref: group ${cite.group}]
`;
        }
        if (cite.desk && typeof cite.desk === "object") {
          return `
> [ref: ${cite.desk.flag}]
`;
        }
        if (cite.bait && typeof cite.bait === "object") {
          return `
> [ref: ${cite.bait.graph} in ${cite.bait.group}]
`;
        }
        return `
> [quoted message]
`;
      }
    }
    return "";
  }).join("\n").trim();
}
function isSummarizationRequest(messageText) {
  const patterns = [
    /summarize\s+(this\s+)?(channel|chat|conversation)/i,
    /what\s+did\s+i\s+miss/i,
    /catch\s+me\s+up/i,
    /channel\s+summary/i,
    /tldr/i
  ];
  return patterns.some((pattern) => pattern.test(messageText));
}
function formatChangesDate(daysAgo = 5) {
  const now = /* @__PURE__ */ new Date();
  const targetDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1e3);
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;
  const day = targetDate.getDate();
  return `~${year}.${month}.${day}..20.19.51..9b9d`;
}
export {
  extractCites,
  extractMessageText,
  formatChangesDate,
  formatModelName,
  isBotMentioned,
  isDmAllowed,
  isGroupInviteAllowed,
  isSummarizationRequest,
  stripBotMention
};
