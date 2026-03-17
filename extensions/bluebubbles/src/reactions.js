import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { getCachedBlueBubblesPrivateApiStatus } from "./probe.js";
import { blueBubblesFetchWithTimeout, buildBlueBubblesApiUrl } from "./types.js";
const REACTION_TYPES = /* @__PURE__ */ new Set(["love", "like", "dislike", "laugh", "emphasize", "question"]);
const REACTION_ALIASES = /* @__PURE__ */ new Map([
  // General
  ["heart", "love"],
  ["love", "love"],
  ["\u2764", "love"],
  ["\u2764\uFE0F", "love"],
  ["red_heart", "love"],
  ["thumbs_up", "like"],
  ["thumbsup", "like"],
  ["thumbs-up", "like"],
  ["thumbsup", "like"],
  ["like", "like"],
  ["thumb", "like"],
  ["ok", "like"],
  ["thumbs_down", "dislike"],
  ["thumbsdown", "dislike"],
  ["thumbs-down", "dislike"],
  ["dislike", "dislike"],
  ["boo", "dislike"],
  ["no", "dislike"],
  // Laugh
  ["haha", "laugh"],
  ["lol", "laugh"],
  ["lmao", "laugh"],
  ["rofl", "laugh"],
  ["\u{1F602}", "laugh"],
  ["\u{1F923}", "laugh"],
  ["xd", "laugh"],
  ["laugh", "laugh"],
  // Emphasize / exclaim
  ["emphasis", "emphasize"],
  ["emphasize", "emphasize"],
  ["exclaim", "emphasize"],
  ["!!", "emphasize"],
  ["\u203C", "emphasize"],
  ["\u203C\uFE0F", "emphasize"],
  ["\u2757", "emphasize"],
  ["important", "emphasize"],
  ["bang", "emphasize"],
  // Question
  ["question", "question"],
  ["?", "question"],
  ["\u2753", "question"],
  ["\u2754", "question"],
  ["ask", "question"],
  // Apple/Messages names
  ["loved", "love"],
  ["liked", "like"],
  ["disliked", "dislike"],
  ["laughed", "laugh"],
  ["emphasized", "emphasize"],
  ["questioned", "question"],
  // Colloquial / informal
  ["fire", "love"],
  ["\u{1F525}", "love"],
  ["wow", "emphasize"],
  ["!", "emphasize"],
  // Edge: generic emoji name forms
  ["heart_eyes", "love"],
  ["smile", "laugh"],
  ["smiley", "laugh"],
  ["happy", "laugh"],
  ["joy", "laugh"]
]);
const REACTION_EMOJIS = /* @__PURE__ */ new Map([
  // Love
  ["\u2764\uFE0F", "love"],
  ["\u2764", "love"],
  ["\u2665\uFE0F", "love"],
  ["\u2665", "love"],
  ["\u{1F60D}", "love"],
  ["\u{1F495}", "love"],
  // Like
  ["\u{1F44D}", "like"],
  ["\u{1F44C}", "like"],
  // Dislike
  ["\u{1F44E}", "dislike"],
  ["\u{1F645}", "dislike"],
  // Laugh
  ["\u{1F602}", "laugh"],
  ["\u{1F923}", "laugh"],
  ["\u{1F606}", "laugh"],
  ["\u{1F601}", "laugh"],
  ["\u{1F639}", "laugh"],
  // Emphasize
  ["\u203C\uFE0F", "emphasize"],
  ["\u203C", "emphasize"],
  ["!!", "emphasize"],
  ["\u2757", "emphasize"],
  ["\u2755", "emphasize"],
  ["!", "emphasize"],
  // Question
  ["\u2753", "question"],
  ["\u2754", "question"],
  ["?", "question"]
]);
function resolveAccount(params) {
  return resolveBlueBubblesServerAccount(params);
}
function normalizeBlueBubblesReactionInput(emoji, remove) {
  const trimmed = emoji.trim();
  if (!trimmed) {
    throw new Error("BlueBubbles reaction requires an emoji or name.");
  }
  let raw = trimmed.toLowerCase();
  if (raw.startsWith("-")) {
    raw = raw.slice(1);
  }
  const aliased = REACTION_ALIASES.get(raw) ?? raw;
  const mapped = REACTION_EMOJIS.get(trimmed) ?? REACTION_EMOJIS.get(raw) ?? aliased;
  if (!REACTION_TYPES.has(mapped)) {
    throw new Error(`Unsupported BlueBubbles reaction: ${trimmed}`);
  }
  return remove ? `-${mapped}` : mapped;
}
async function sendBlueBubblesReaction(params) {
  const chatGuid = params.chatGuid.trim();
  const messageGuid = params.messageGuid.trim();
  if (!chatGuid) {
    throw new Error("BlueBubbles reaction requires chatGuid.");
  }
  if (!messageGuid) {
    throw new Error("BlueBubbles reaction requires messageGuid.");
  }
  const reaction = normalizeBlueBubblesReactionInput(params.emoji, params.remove);
  const { baseUrl, password, accountId } = resolveAccount(params.opts ?? {});
  if (getCachedBlueBubblesPrivateApiStatus(accountId) === false) {
    throw new Error(
      "BlueBubbles reaction requires Private API, but it is disabled on the BlueBubbles server."
    );
  }
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: "/api/v1/message/react",
    password
  });
  const payload = {
    chatGuid,
    selectedMessageGuid: messageGuid,
    reaction,
    partIndex: typeof params.partIndex === "number" ? params.partIndex : 0
  };
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    },
    params.opts?.timeoutMs
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`BlueBubbles reaction failed (${res.status}): ${errorText || "unknown"}`);
  }
}
export {
  normalizeBlueBubblesReactionInput,
  sendBlueBubblesReaction
};
