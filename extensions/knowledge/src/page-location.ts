/** Public Knowledge page state. The host owns URL encoding and browser history. */
export type KnowledgeLocation = {
  agent: string;
  vault: string;
  tab: "recent" | "browse" | "search" | "settings";
  record: string;
  section: "stores" | "vocab" | "status" | "maintenance";
  kind: "page" | "claim" | "relationship";
  type: string;
  query: string;
  filter: string;
  history: boolean;
  origin: string;
  offset: number;
  back: number[];
  since: string;
  until: string;
  timeField: "occurred_at" | "recorded_at" | "updated_at" | "due_at";
  cursor?: { upperSequence: number; beforeSequence: number };
};
// True when `value` holds a C0 control character or DEL.
const hasControlCharacter = (value: string) => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
};
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max && !hasControlCharacter(value) ? value : "";
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "string" &&
  /^\d{1,16}$/.test(value) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) <= max
    ? Number(value)
    : 0;

export function readLocation(params: Readonly<Record<string, string>> = {}): KnowledgeLocation {
  const view = params.view ?? "",
    origin = params.origin ?? "",
    timeField = params.timeField ?? "";
  const tab = (["browse", "search", "settings"] as const).find((t) => t === view) ?? "recent";
  const upperSequence = integer(params.upper),
    beforeSequence = integer(params.before);
  const offset = integer(params.offset, 500);
  const trail = text(params.back, 2000);
  const back =
    trail && /^(0|[1-9]\d*)(,(0|[1-9]\d*))*$/.test(trail) ? trail.split(",").map(Number) : [];
  const validBack = back.every(
    (n, i) => Number.isSafeInteger(n) && n < offset && (i === 0 || n > back[i - 1]!),
  );
  return {
    agent: text(params.agent, 64),
    vault: text(params.vault, 120),
    tab,
    record: text(params.record, 96),
    section:
      params.section === "vocab" || params.section === "status" || params.section === "maintenance"
        ? params.section
        : "stores",
    kind: params.kind === "claim" || params.kind === "relationship" ? params.kind : "page",
    type: text(params.type, 64),
    query: text(params.q, 200),
    filter: text(params.filter, 200),
    history: params.history === "1",
    origin: ["source", "user_belief", "agent_inference"].includes(origin) ? origin : "",
    offset,
    back: validBack ? back : [],
    since: text(params.since, 40),
    until: text(params.until, 40),
    timeField:
      (["recorded_at", "updated_at", "due_at"] as const).find((f) => f === timeField) ??
      "occurred_at",
    ...(upperSequence && beforeSequence && beforeSequence <= upperSequence
      ? { cursor: { upperSequence, beforeSequence } }
      : {}),
  };
}

export function locationParams(state: KnowledgeLocation): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      agent: state.agent,
      vault: state.vault,
      view: state.tab === "recent" ? "" : state.tab,
      record: state.record,
      section: state.tab === "settings" && state.section !== "stores" ? state.section : "",
      kind: state.kind === "page" ? "" : state.kind,
      type: state.type,
      q: state.query,
      filter: state.filter,
      history: state.history ? "1" : "",
      origin: state.origin,
      offset: state.offset ? String(state.offset) : "",
      back: state.back.filter((n) => n < state.offset).join(","),
      since: state.since,
      until: state.until,
      timeField: state.timeField === "occurred_at" ? "" : state.timeField,
      upper: state.cursor ? String(state.cursor.upperSequence) : "",
      before: state.cursor ? String(state.cursor.beforeSequence) : "",
    }).filter(([, value]) => value !== ""),
  );
}

export const locationKey = (state: KnowledgeLocation) => JSON.stringify(locationParams(state));
