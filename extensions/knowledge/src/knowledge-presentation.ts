import type { ControlUiAgent } from "openclaw/plugin-sdk/control-ui";
import { IDENTITY_KEY } from "./merge.js";
import type { Envelope } from "./model.js";
import { icon } from "./ui-icons.js";
/**
 * Aliases worth showing as other names. Lookup still uses every alias; this hides
 * account keys such as `discord:123`, titles of pages merged into this one, and
 * disambiguating labels like "Jacob (standup participant)" whose base name is
 * already the title or another shown alias.
 */
export function displayAliases(
  title: string,
  aliases: readonly string[],
  mergedTitles: readonly string[],
) {
  const key = (name: string) => name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  const merged = new Set(mergedTitles.map(key));
  const hidden = (alias: string) => IDENTITY_KEY.test(alias.trim()) || merged.has(key(alias));
  // Unlabelled names are the bases a labelled variant is checked against.
  const known = new Set(
    [title, ...aliases.filter((alias) => !hidden(alias) && !/\s\(.+\)$/u.test(alias.trim()))].map(
      key,
    ),
  );
  return aliases.filter((alias) => {
    if (hidden(alias)) {
      return false;
    }
    const labelled = /^(.+?)\s+\(.+\)$/u.exec(alias.trim());
    return !labelled || !known.has(key(labelled[1]!));
  });
}
export function agentDisplayName(id: string | undefined, agents: readonly ControlUiAgent[]) {
  if (!id) {
    return undefined;
  }
  const agent = agents.find((candidate) => candidate.id === id);
  return agent?.identity?.name?.trim() || agent?.name?.trim() || id;
}
export function confidenceView(
  confidence?: Pick<NonNullable<Envelope["attribution_confidence"]>, "level" | "basis">,
  compact = false,
) {
  const node = document.createElement("span");
  node.className = "knowledge-confidence";
  // Compact rows omit an unrecorded level: most records lack one, so repeating
  // "not recorded" on every row adds noise. Evidence captions still state it.
  if (!confidence) {
    if (compact) {
      node.hidden = true;
    } else {
      node.append(icon("circleQuestionMark", 12), "Attribution confidence not recorded");
    }
    return node;
  }
  node.title = confidence.basis;
  const bars = document.createElement("span");
  bars.className = "knowledge-confidence-bars";
  bars.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) {
    const bar = document.createElement("i");
    bar.dataset.filled = String(i < { low: 1, medium: 2, high: 3 }[confidence.level]);
    bars.append(bar);
  }
  node.append(
    bars,
    `${confidence.level[0]!.toUpperCase()}${confidence.level.slice(1)}${compact ? "" : " attribution confidence"}`,
  );
  return node;
}
export function identityTag(status?: string) {
  const node = document.createElement("span");
  node.className = "knowledge-identity-tag";
  if (status === "partial") {
    node.append(icon("shieldQuestion", 12), "Identity unresolved");
  } else {
    node.hidden = true;
  }
  return node;
}
export function assertionOrigin(value?: string, attribution?: string, agentName?: string) {
  return value === "source"
    ? "From source"
    : value === "user_belief"
      ? attribution
        ? `Statement by ${attribution}`
        : "Statement by an unidentified user"
      : value === "agent_inference"
        ? agentName
          ? `${agentName} inferred`
          : "Agent inference"
        : "Origin not recorded";
}
