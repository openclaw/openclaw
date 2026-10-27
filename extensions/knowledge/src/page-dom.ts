/** DOM builders and display formatters shared by the Knowledge page views. */
import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import { formatSourceDate } from "./temporal.js";
import { icon, type IconName } from "./ui-icons.js";

export type Summary = FeatureOutput<typeof contract, "records">["records"][number];
export const isFullSummary = (r: { id: string }): r is Summary =>
  "path" in r && "revision" in r && "lifecycle" in r && "valid" in r;
export type Detail = FeatureOutput<typeof contract, "record">;
export type RecordDetail = NonNullable<Detail["record"]>;
export type ClaimPresentation = {
  record: Omit<NonNullable<Detail["record"]>, "metadata"> & {
    metadata?: Partial<NonNullable<NonNullable<Detail["record"]>["metadata"]>>;
  };
  truncated: boolean;
  evidenceTotal?: number;
  evidenceSourceTotal?: number;
};
export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
) => {
  const n = document.createElement(tag);
  if (text !== undefined) {
    n.textContent = text;
  }
  if (className) {
    n.className = className;
  }
  return n;
};
export const button = (text: string, run: () => void, className = "knowledge-button") => {
  const n = el("button", text, className);
  n.type = "button";
  n.addEventListener("click", run);
  return n;
};
export const chip = (text: string) => el("span", text, "chip knowledge-chip");
export const human = (text: string) => text.replaceAll("_", " ").replaceAll("-", " ");
export const label = (text: string) => human(text).replace(/^./, (c) => c.toUpperCase());
const typeIcons: Record<string, [IconName, string]> = {
  person: ["circleUser", "teal"],
  company: ["box", "blue"],
  organization: ["box", "blue"],
  project: ["kanban", "green"],
  concept: ["spark", "amber"],
  meeting: ["users", "red"],
  email: ["mail", "neutral"],
  source: ["paperclip", "neutral"],
  decision: ["flag", "neutral"],
  commitment: ["listChecks", "neutral"],
  preference: ["star", "neutral"],
  fact: ["info", "neutral"],
  belief: ["brain", "neutral"],
  event: ["calendarClock", "neutral"],
};
export const tile = (type: string, size = 28, kind = "page") => {
  const [glyph, tone] = (Object.hasOwn(typeIcons, type) ? typeIcons[type] : undefined) ?? [
    kind === "relationship" ? "link" : "fileText",
    "neutral",
  ];
  const n = el(
    "span",
    undefined,
    `knowledge-tile knowledge-tone-${tone}${kind === "page" ? "" : " knowledge-tile-plain"}`,
  );
  n.style.setProperty("--tile-size", `${size}px`);
  n.append(icon(glyph, size >= 48 ? 24 : size <= 24 ? 13 : 15));
  return n;
};
export const date = (text: string) => formatSourceDate(text);
export const time = (text: string) =>
  new Date(text).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
export const clock = (text: string) =>
  new Date(text).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** Local day label for grouped rows: Today, Yesterday, or a short date (with year outside the current one). */
export const dayHeading = (text: string) => {
  const day = new Date(text),
    today = new Date(),
    yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) {
    return "Today";
  }
  if (day.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return day.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" as const }),
  });
};

/** Collapsed ingestion reasoning: how an identity was resolved and how speech was attributed. */
export const identificationDetails = (
  context?: string,
  confidence?: { level: string; basis: string },
) => {
  if (!context && !confidence) {
    return undefined;
  }
  const details = el("details", undefined, "knowledge-identification"),
    summary = el("summary", "How this was identified");
  summary.append(icon("chevronDown", 12));
  details.append(summary);
  if (context) {
    details.append(el("p", context));
  }
  if (confidence) {
    details.append(
      el("p", `Speaker attribution confidence: ${confidence.level}. ${confidence.basis}`),
    );
  }
  return details;
};

/** Summary label whose text swaps with its details element's open state. */
export const disclosureLabel = (closed: string, opened: string) => {
  const control = el("span", undefined, "knowledge-disclosure-label");
  control.append(
    el("span", closed, "knowledge-when-closed"),
    el("span", opened, "knowledge-when-open"),
    icon("chevronDown", 14),
  );
  return control;
};
/** Drop a leading `# Title` heading that repeats the page title shown in the entity header. */
export const withoutTitleHeading = (body: string, title: string) => {
  const match = /^\s*#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(body);
  return match && match[1]!.trim() === title.trim()
    ? body.slice(match[0].length).replace(/^\s*\n/, "")
    : body;
};
/** Page bodies longer than this preview behind "Show full notes". */
export const longBodyChars = 3000;
/** Claim text for compact rows: wikilinks read as their labels, since a row is one button. */
/** Plain claim text: wiki links become their labels and internal comments, even ones cut off by a preview, are dropped. */
export const plainLinks = (text: string) =>
  text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (_, target: string, shown?: string) =>
      (shown ?? target).trim(),
    )
    .trim();
/** Short file kind for a retained original, from its recorded media type or extension. */
export const fileKind = (e: { mediaType?: string; filename?: string; path: string }) => {
  const kinds: Record<string, string> = {
    "text/plain": "Text",
    "text/markdown": "Markdown",
    "application/json": "JSON",
    "application/pdf": "PDF",
    "text/html": "HTML",
    "text/csv": "CSV",
  };
  const media = e.mediaType?.split(";")[0]!.trim().toLowerCase();
  return (
    (media && kinds[media]) ?? (e.filename ?? e.path).split(".").at(-1)?.toUpperCase() ?? "File"
  );
};
/** Human-scale byte count, e.g. "49 KB". */
export const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
