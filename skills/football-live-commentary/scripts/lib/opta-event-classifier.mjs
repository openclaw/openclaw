/**
 * Map Opta / Stats Perform–style event labels to priority tiers.
 * Raw feeds vary: we match case-insensitive substrings on a normalized type string.
 */

/** @param {Record<string, unknown>} e */
export function eventTypeString(e) {
  const parts = [];
  const t = e.type;
  if (typeof t === "string") parts.push(t);
  else if (t && typeof t === "object") {
    parts.push(String(t.name ?? t.type ?? t.id ?? ""));
  }
  if (typeof e.eventType === "string") parts.push(e.eventType);
  if (typeof e.typeName === "string") parts.push(e.typeName);
  if (Array.isArray(e.qualifiers)) {
    for (const q of e.qualifiers) {
      if (typeof q === "string") parts.push(q);
      else if (q && typeof q === "object") {
        parts.push(String(q.name ?? q.value ?? q.type ?? ""));
      }
    }
  }
  if (typeof e.outcome === "string") parts.push(e.outcome);
  if (typeof e.outcomeType === "string") parts.push(e.outcomeType);
  return parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Map common Chinese labels (e.g. Nami 实时) to English tokens for the same regex tiering. */
function augmentCjkHints(s) {
  const h = [];
  if (/进球|破门/.test(s)) h.push("goal");
  if (/黄牌/.test(s)) h.push("yellow card");
  if (/红牌|两黄变一红/.test(s)) h.push("red card");
  if (/点球/.test(s)) h.push("penalty kick");
  if (/换人|替补|换下|换上/.test(s)) h.push("substitution");
  if (/VAR|视频助理/.test(s)) h.push("var");
  if (/射正|打正/.test(s)) h.push("on target");
  if (/射门/.test(s)) h.push("shot");
  if (/传球/.test(s)) h.push("pass");
  if (/开球|界外|角球|任意球/.test(s)) h.push("kick");
  return h.length ? ` ${h.join(" ")}` : "";
}

/** @returns {'high'|'medium'|'low'} */
export function classifyPriority(typeStr, e) {
  const s = `${typeStr}${augmentCjkHints(typeStr)}`;

  if (
    /\b(goal|scored|scores)\b/.test(s) ||
    /\bown goal\b/.test(s) ||
    (/\bshot\b/.test(s) && /\bgoal\b/.test(s))
  ) {
    return "high";
  }
  if (/\b(red card|second yellow|sending off|dismissal)\b/.test(s)) return "high";
  if (/\b(yellow card|caution|booking)\b/.test(s) && !/second yellow/.test(s)) return "high";
  if (
    /\bpenalty kick\b/.test(s) ||
    (/\bpenalty\b/.test(s) && /\b(awarded|given|taken|missed|saved|score|goal)\b/.test(s))
  ) {
    return "high";
  }
  if (/\bsubstitution|sub (on|off)|replacement|player off\b/.test(s)) return "high";
  if (/\bvar\b|video assistant|pitchside review|review decision/.test(s)) return "high";

  if (
    /\b(on target|on-target|woodwork|crossbar|post|saved|save\b|block(ed)?\s+shot)\b/.test(s) ||
    (/\bshot\b/.test(s) && /\b(off target|wide|high)\b/.test(s))
  ) {
    return "medium";
  }
  if (/\binterception|blocked cross|clearance\b/.test(s) && isLikelyDefensiveThird(s, e)) {
    return "medium";
  }
  if (/\bfoul\b/.test(s) && /\b(box|area|18|penalty)\b/.test(s)) return "medium";

  if (/\bpass\b/.test(s) || s.includes("pass")) return "low";
  if (/\b(throw.?in|throw in|corner|kick.?off|free kick taken)\b/.test(s)) return "low";
  if (/\b(offside|tackle|duel|aerial)\b/.test(s)) return "low";

  return "low";
}

function isLikelyDefensiveThird(typeStr, e) {
  if (/\b(box|six yard|goal line|line clearance)\b/.test(typeStr)) return true;
  const x = e.x ?? e.endX ?? e.position?.x;
  if (typeof x === "number" && (x < 26 || x > 74)) return true;
  return false;
}

export function isPassEvent(typeStr) {
  return /\bpass\b/.test(typeStr) || typeStr.includes("pass") || /传球/.test(typeStr);
}

export function isGoalEvent(typeStr) {
  return (
    /\b(goal|scored)\b/.test(typeStr) ||
    (/\bshot\b/.test(typeStr) && /\bgoal\b/.test(typeStr)) ||
    /\bown goal\b/.test(typeStr) ||
    /进球|破门/.test(typeStr)
  );
}
