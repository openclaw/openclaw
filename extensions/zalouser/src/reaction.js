import { Reactions } from "./zca-client.js";
const REACTION_ALIAS_MAP = /* @__PURE__ */ new Map([
  ["like", Reactions.LIKE],
  ["\u{1F44D}", Reactions.LIKE],
  [":+1:", Reactions.LIKE],
  ["heart", Reactions.HEART],
  ["\u2764\uFE0F", Reactions.HEART],
  ["<3", Reactions.HEART],
  ["haha", Reactions.HAHA],
  ["laugh", Reactions.HAHA],
  ["\u{1F602}", Reactions.HAHA],
  ["wow", Reactions.WOW],
  ["\u{1F62E}", Reactions.WOW],
  ["cry", Reactions.CRY],
  ["\u{1F622}", Reactions.CRY],
  ["angry", Reactions.ANGRY],
  ["\u{1F621}", Reactions.ANGRY]
]);
function normalizeZaloReactionIcon(raw) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return Reactions.LIKE;
  }
  return REACTION_ALIAS_MAP.get(trimmed.toLowerCase()) ?? REACTION_ALIAS_MAP.get(trimmed) ?? trimmed;
}
export {
  normalizeZaloReactionIcon
};
