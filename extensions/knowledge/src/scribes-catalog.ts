/** The scribes Knowledge can start, their options, and the fixed messages that start them. */
import type { IconName } from "./ui-icons.js";

export type ScribeId = "unlinked-review" | "conversations" | "memory";
export type ScribeMode = "once" | "ongoing";
export type ConversationScope = "active" | "all";
export type ConversationSince = "30d" | "90d" | "all" | "today";
export type MemorySource = "memory-md" | "daily-notes" | "dreams";

/** Dialog choices for each scribe; serialized as the setup message's `options`. */
export type ScribeOptions = {
  "unlinked-review": Record<string, never>;
  conversations: { scope: ConversationScope; since: ConversationSince; schedule?: string };
  memory: { sources: MemorySource[] };
};

/** The JSON a setup or repair message carries: fixed fields plus the dialog's options only. */
export type ScribeSetup<Id extends ScribeId = ScribeId> = {
  scribe: Id;
  mode: ScribeMode;
  options: ScribeOptions[Id];
  timezone: string;
  agentId: string;
};

/** Static description of one scribe, shared by the list, detail and start dialog. */
export type ScribeDefinition = {
  id: ScribeId;
  title: string;
  blurb: string;
  skill: "knowledge-unlinked-claims" | "knowledge-ingest";
  icon: IconName;
  tone: "blue" | "teal" | "amber";
  modes: readonly ScribeMode[];
  /** Chip text for how often it runs. */
  cadence: string;
  /** Row button that opens the start dialog. */
  startLabel: string;
  dialogTitle: string;
  submitLabel: string;
};

/** Schedule an ongoing conversations scribe uses: daily at 4:00 AM in the operator's timezone. */
export const CONVERSATIONS_SCHEDULE = "0 4 * * *";

export const SCRIBES: readonly ScribeDefinition[] = [
  {
    id: "unlinked-review",
    title: "Review unlinked claims",
    blurb:
      "After each nightly tidy-up, files claims that name no page, creates pages for subjects that deserve one, and folds outcomes into page State.",
    skill: "knowledge-unlinked-claims",
    icon: "link",
    tone: "blue",
    modes: ["ongoing"],
    cadence: "Ongoing",
    startLabel: "Turn on…",
    dialogTitle: "Review unlinked claims",
    submitLabel: "Turn on",
  },
  {
    id: "conversations",
    title: "Learn from conversations",
    blurb:
      "Reads your conversations and saves the decisions, preferences, commitments and lessons in them. Run it once, or keep it learning as new conversations finish.",
    skill: "knowledge-ingest",
    icon: "messageSquare",
    tone: "teal",
    modes: ["ongoing", "once"],
    cadence: "Once or ongoing",
    startLabel: "Set up…",
    dialogTitle: "Learn from conversations",
    submitLabel: "Start",
  },
  {
    id: "memory",
    title: "Learn from Memory",
    blurb:
      "Brings what Memory already knows (MEMORY.md, daily notes and Dreaming promotions) into Knowledge, once. Memory itself is left as it is.",
    skill: "knowledge-ingest",
    icon: "brain",
    tone: "amber",
    modes: ["once"],
    cadence: "One time",
    startLabel: "Import…",
    dialogTitle: "Import from Memory",
    submitLabel: "Start import",
  },
];

/** Catalog entry for `id`, or undefined for an unknown id. */
export const scribeById = (id: string) => SCRIBES.find((scribe) => scribe.id === id);
/** Display name of a scribe's conversation; the page finds the session by it. */
export const scribeLabel = (scribe: ScribeDefinition) => `Scribe · ${scribe.title}`;
/** declarationKey of the one automation an ongoing scribe creates. */
export const scribeDeclarationKey = (id: ScribeId) => `knowledge:scribe:${id}`;
/**
 * chat.send idempotency key for one start attempt in one session. A scribe reuses its
 * conversation across starts, so each attempt (one dialog) gets its own key; retries within
 * the attempt stay deduplicated.
 */
export const setupIdempotencyKey = (id: ScribeId, sessionKey: string, attempt: string) =>
  `knowledge:scribe:${id}:${sessionKey}:${attempt}`;

/** Default dialog choices: conservative (active conversations, last 30 days). */
export function defaultOptions<Id extends ScribeId>(id: Id): ScribeOptions[Id] {
  const defaults: ScribeOptions = {
    "unlinked-review": {},
    conversations: { scope: "active", since: "30d", schedule: CONVERSATIONS_SCHEDULE },
    memory: { sources: ["memory-md", "daily-notes"] },
  };
  return defaults[id];
}

/** Setup JSON for one start. A once scribe carries no schedule. */
export function scribeSetup<Id extends ScribeId>(
  id: Id,
  mode: ScribeMode,
  options: ScribeOptions[Id],
  agentId: string,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): ScribeSetup<Id> {
  // A once run has no schedule; an undefined key is left out of the JSON.
  const opts =
    mode === "once" && "schedule" in options ? { ...options, schedule: undefined } : options;
  return { scribe: id, mode, options: opts, timezone, agentId };
}

// Fixed skill pointer plus the options JSON. Never include vault content here.
function scribeMessage(heading: string, setup: ScribeSetup) {
  const scribe = scribeById(setup.scribe)!;
  const json = JSON.stringify({
    scribe: setup.scribe,
    mode: setup.mode,
    options: setup.options,
    timezone: setup.timezone,
    agentId: setup.agentId,
  });
  return [
    `${heading}: ${setup.scribe}`,
    `Follow the "Scribe setup" section of the ${scribe.skill} skill with these options.`,
    "```json",
    json,
    "```",
  ].join("\n");
}

/** Message the page sends a new scribe conversation with `chat.send`. */
export const setupMessage = (setup: ScribeSetup) => scribeMessage("Knowledge scribe setup", setup);
/** Message that asks a scribe conversation to re-check and recreate its automation. */
export const repairMessage = (setup: ScribeSetup) =>
  scribeMessage("Knowledge scribe repair", setup);
