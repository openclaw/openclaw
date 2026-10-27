/** The scribes Knowledge can start, their options, and the readable prompts that start, run and repair them. */
import type { IconName } from "./ui-icons.js";

export type ScribeId = "unlinked-review" | "conversations" | "memory";
export type ScribeMode = "once" | "ongoing";
export type ConversationScope = "active" | "all";
export type ConversationSince = "30d" | "90d" | "all" | "today";
export type MemorySource = "memory-md" | "daily-notes" | "dreams";
export type ReviewSchedule = typeof REVIEW_WEEKLY_SCHEDULE | typeof REVIEW_NIGHTLY_SCHEDULE;

/** Dialog choices for each scribe; the prompts spell them out as settings. */
export type ScribeOptions = {
  "unlinked-review": { schedule: ReviewSchedule };
  conversations: { scope: ConversationScope; since: ConversationSince; schedule?: string };
  memory: { sources: MemorySource[] };
};

/** One start's choices: the scribe, once or ongoing, its options and the operator's time zone. */
export type ScribeSetup<Id extends ScribeId = ScribeId> = {
  scribe: Id;
  mode: ScribeMode;
  options: ScribeOptions[Id];
  timezone: string;
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
/** Default review schedule: Sundays at 3:45 AM in the operator's timezone. */
export const REVIEW_WEEKLY_SCHEDULE = "45 3 * * 0";
/** Nightly review schedule: 3:45 AM, after the default 3:30 AM maintenance relink. */
export const REVIEW_NIGHTLY_SCHEDULE = "45 3 * * *";

export const SCRIBES: readonly ScribeDefinition[] = [
  {
    id: "unlinked-review",
    title: "Review unlinked claims",
    blurb:
      "Weekly or nightly, files claims that name no page, creates pages for subjects that deserve one, and folds outcomes into page State.",
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

/** Default dialog choices: conservative (weekly review; active conversations, last 30 days). */
export function defaultOptions<Id extends ScribeId>(id: Id): ScribeOptions[Id] {
  const defaults: ScribeOptions = {
    "unlinked-review": { schedule: REVIEW_WEEKLY_SCHEDULE },
    conversations: { scope: "active", since: "30d", schedule: CONVERSATIONS_SCHEDULE },
    memory: { sources: ["memory-md", "daily-notes"] },
  };
  return defaults[id];
}

/** One start's choices. A once scribe carries no schedule. */
export function scribeSetup<Id extends ScribeId>(
  id: Id,
  mode: ScribeMode,
  options: ScribeOptions[Id],
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): ScribeSetup<Id> {
  // A once run has no schedule; an undefined key never reaches the prompt.
  const opts =
    mode === "once" && "schedule" in options ? { ...options, schedule: undefined } : options;
  return { scribe: id, mode, options: opts, timezone };
}

// The schedules the dialog offers, in words.
const SCHEDULE_WORDS: Record<string, string> = {
  [REVIEW_WEEKLY_SCHEDULE]: "weekly, Sundays at 3:45 AM",
  [REVIEW_NIGHTLY_SCHEDULE]: "nightly at 3:45 AM",
  [CONVERSATIONS_SCHEDULE]: "daily at 4:00 AM",
};
const SINCE_WORDS: Record<ConversationSince, string> = {
  "30d": "from the last 30 days",
  "90d": "from the last 90 days",
  all: "from any time",
  today: "from today on (new conversations only)",
};
const MEMORY_WORDS: Record<MemorySource, string> = {
  "memory-md": "MEMORY.md",
  "daily-notes": "daily notes (memory/YYYY-MM-DD.md)",
  dreams: "the Dreaming diary (DREAMS.md)",
};

/** "Runs weekly, Sundays at 3:45 AM UTC (cron `45 3 * * 0`)." for a cron schedule. */
function scheduleLine(expr: string, timezone: string) {
  const words = SCHEDULE_WORDS[expr];
  return words
    ? `Runs ${words} ${timezone} (cron \`${expr}\`).`
    : `Runs on cron \`${expr}\`, time zone ${timezone}.`;
}

// "a, b and c".
const listWords = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "none");

// The settings a scribe's work reads: conversations and Memory files. Schedules are separate.
function workSettings(setup: ScribeSetup) {
  const { options } = setup;
  if ("scope" in options) {
    const which = options.scope === "all" ? "active and archived" : "active only";
    return [`Conversations: ${which}, ${SINCE_WORDS[options.since] ?? options.since}.`];
  }
  if ("sources" in options) {
    return [`Memory files: ${listWords(options.sources.map((source) => MEMORY_WORDS[source]))}.`];
  }
  return [];
}

// What the scribe does, and the skill that does the work.
const PURPOSE: Record<ScribeId, string> = {
  "unlinked-review":
    "This scribe reviews Knowledge claims that name no page: it files each one on the right page, creates pages for subjects that deserve one, supersedes status snapshots by their outcome, and folds the outcomes into page State.",
  conversations:
    "This scribe reads the owner's conversations and saves the decisions, preferences, commitments and lessons in them to Knowledge.",
  memory:
    "This scribe brings what Memory already knows into Knowledge. Memory itself is left as it is.",
};

// The work step: the skill section that does it, applied to the settings.
const WORK: Record<ScribeId, string> = {
  "unlinked-review":
    'Follow the "Scribe runs" section of the knowledge-unlinked-claims skill: review every claim that names no page until none is left to decide.',
  conversations:
    'Follow "Learn from conversations" in the "Scribe runs" section of the knowledge-ingest skill, for the conversations in the settings.',
  memory:
    'Follow "Learn from Memory" in the "Scribe runs" section of the knowledge-ingest skill, for the Memory files in the settings. Never change Memory files.',
};

// What the closing sentence counts after the work.
const COUNTS: Record<ScribeId, string> = {
  "unlinked-review": "claims examined, linked, superseded, withdrawn and left",
  conversations: "conversations learned and skipped, claims and pages written",
  memory: "files read, items saved, already known and skipped",
};

const UNATTENDED = "Don't ask questions: nobody is watching this turn.";

// Step 1 of every prompt; `fix` says how the owner restores access.
const accessStep = (fix: string) =>
  `Call knowledge_status. Go on when the scope is private and writes are enabled, or the store is unprovisioned (a vault that was never written reports writes off until its first write). Otherwise stop: this conversation lacks the owner's private Knowledge access. ${fix}`;

// The last step of every prompt: the closing status line.
const endStep = (state: "on" | "done", what: string) =>
  `End your reply with one line: \`Scribe status: ${state} — <${what}>\`.`;
// The rule after every prompt's steps.
const FAILED =
  "If a step fails, stop and end with `Scribe status: failed — <why>` instead. The status line is shown outside the vault: give counts, never vault content.";

// Numbered steps; continuation lines of a step stay indented under it.
const numbered = (steps: string[]) =>
  steps.map((step, i) => `${i + 1}. ${step.replaceAll("\n", "\n   ")}`);

/**
 * Steps that declare an ongoing scribe's one automation in this conversation: clear same-key
 * jobs of other conversations (carrying a pause over), add, then check the target. `keep` is a
 * repair's condition for leaving a healthy automation alone.
 */
function automationSteps(scribe: ScribeDefinition, schedule: string, keep = "") {
  const key = scribeDeclarationKey(scribe.id);
  return [
    `With the automations tool, list automations including disabled ones and take those with declaration key \`${key}\`.${keep} Remove each one owned by another conversation, noting whether it was paused. If this conversation owns one that targets another session, update its session target to this conversation.`,
    [
      "Add the automation with the automations tool:",
      `- name: Knowledge scribe · ${scribe.title}`,
      `- declaration key: \`${key}\``,
      `- schedule: ${schedule}`,
      "- session target: `session:` followed by this conversation's session key (from Runtime)",
      "- payload: an agent turn whose message is the run message below, exactly as written inside the fence",
      "- delivery: none; failure alert after 2 failed runs",
      "Adding with an existing declaration key updates this conversation's automation in place. Pass `enabled: false` only when a removed automation was paused and this conversation had none, so the pause carries over. Otherwise leave `enabled` out: never turn on a paused automation.",
    ].join("\n"),
    "Get the automation and check that it targets this conversation.",
  ];
}

// A run message in a fence, after the prompt that installs it.
const runMessageBlock = (message: string) => ["Run message:", "", "```text", message, "```"];

/**
 * The message an ongoing scribe's automation sends each run: the work settings, the work step
 * and the closing line. Editing it on the automation changes what later runs do.
 */
export function runPrompt(setup: ScribeSetup) {
  const scribe = scribeById(setup.scribe)!;
  const settings = workSettings(setup);
  return [
    `Scheduled run of the Knowledge scribe "${scribe.title}". ${UNATTENDED}`,
    ...(settings.length ? ["", "Settings:", ...settings.map((line) => `- ${line}`)] : []),
    "",
    "Steps:",
    ...numbered([
      accessStep("A repair from the Scribes page fixes it."),
      `${WORK[scribe.id]} This run can't change automations: if its setup looks broken, say a repair is needed.`,
      endStep("on", `one sentence with counts: ${COUNTS[scribe.id]}`),
    ]),
    "",
    FAILED,
  ].join("\n");
}

/**
 * The message the page sends to start a scribe: what it does, its settings as bullets, and
 * numbered steps. An ongoing scribe declares its automation and carries its run message; a once
 * scribe does the work in this turn. Never includes vault content.
 */
export function setupPrompt(setup: ScribeSetup) {
  const scribe = scribeById(setup.scribe)!;
  const schedule =
    setup.options && "schedule" in setup.options ? setup.options.schedule : undefined;
  const settings = [
    ...(setup.mode === "ongoing" && schedule
      ? [scheduleLine(schedule, setup.timezone)]
      : ["Runs once, now, in this turn. Nothing is scheduled."]),
    ...workSettings(setup),
  ].map((line) => `- ${line}`);
  const access = accessStep("Starting the scribe again from the Scribes page fixes it.");
  if (setup.mode === "once") {
    return [
      `Run the Knowledge scribe "${scribe.title}" once, in this conversation. ${UNATTENDED}`,
      "",
      `${PURPOSE[scribe.id]} The ${scribe.skill} skill does the work.`,
      "",
      "Settings:",
      ...settings,
      "",
      "Steps:",
      ...numbered([
        access,
        WORK[scribe.id],
        endStep("done", `one sentence with counts: ${COUNTS[scribe.id]}`),
      ]),
      "",
      FAILED,
    ].join("\n");
  }
  return [
    `Set up the Knowledge scribe "${scribe.title}" in this conversation. ${UNATTENDED}`,
    "",
    `${PURPOSE[scribe.id]} The ${scribe.skill} skill does the work on each run.`,
    "",
    "Settings:",
    ...settings,
    "",
    "Steps:",
    ...numbered([
      access,
      ...automationSteps(scribe, "the cron expression and time zone in the settings"),
      "Don't start a run from this turn: a run started here is skipped when the turn ends. The Scribes page starts the first run.",
      `Report the automation's ID and next run time. ${endStep("on", "one sentence: the automation and its next run")}`,
    ]),
    "",
    FAILED,
    "",
    ...runMessageBlock(runPrompt(setup)),
  ].join("\n");
}

/** First words of every repair prompt; the page never forces a first run after one. */
export const REPAIR_HEADING = "Repair the Knowledge scribe";

/** What a repair keeps from the scribe's current automation. */
export type RepairSource = {
  schedule: { kind: string; expr?: string; tz?: string };
  runMessage?: string;
};

/**
 * The message that asks a scribe's conversation to re-check its setup and take over its
 * automation, keeping the automation's schedule and run message. It does no work.
 */
export function repairPrompt(id: ScribeId, current: RepairSource) {
  const scribe = scribeById(id)!;
  const { schedule } = current;
  const timezone = schedule.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scheduleSetting =
    schedule.kind === "cron" && schedule.expr
      ? scheduleLine(schedule.expr, timezone)
      : "Keeps the schedule of its current automation.";
  const runMessage =
    current.runMessage ?? runPrompt(scribeSetup(id, "ongoing", defaultOptions(id), timezone));
  return [
    `${REPAIR_HEADING} "${scribe.title}" in this conversation. Don't do its work in this turn. ${UNATTENDED}`,
    "",
    "Settings, kept from its current automation:",
    `- ${scheduleSetting}`,
    "- Run message: the text below.",
    "",
    "Steps:",
    ...numbered([
      accessStep("Starting the scribe again from the Scribes page fixes it."),
      ...automationSteps(
        scribe,
        "the schedule in the settings",
        " If exactly one exists, this conversation owns it and it targets this conversation, leave it as it is and go to the last step.",
      ),
      `Report whether the automation is enabled; never turn on a paused one. ${endStep("on", "one sentence: whether the automation is enabled")}`,
    ]),
    "",
    FAILED,
    "",
    ...runMessageBlock(runMessage),
  ].join("\n");
}
