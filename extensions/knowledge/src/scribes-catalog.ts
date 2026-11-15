/** The scribes Knowledge can start, their options, and the readable prompts that start, run and repair them. */
import type { IconName } from "./ui-icons.js";

export type ScribeId = "claim-consolidation" | "conversations" | "granola" | "memory";
export type ScribeMode = "once" | "ongoing";
export type ConversationScope = "active" | "all";
export type ConversationSince = "30d" | "90d" | "all" | "today";
export type MemorySource = "memory-md" | "daily-notes" | "dreams";
/** Granola meetings to learn from: the owner's own, or every meeting the account can read. */
export type GranolaMeetings = "mine" | "all";
export type GranolaSince = "7d" | "30d" | "today";
export type ReviewSchedule = typeof REVIEW_WEEKLY_SCHEDULE | typeof REVIEW_NIGHTLY_SCHEDULE;

/** Dialog choices for each scribe; the prompts spell them out as settings. */
export type ScribeOptions = {
  "claim-consolidation": { schedule: ReviewSchedule };
  conversations: { scope: ConversationScope; since: ConversationSince; schedule?: string };
  granola: { meetings: GranolaMeetings; since: GranolaSince; schedule?: string };
  memory: { sources: MemorySource[] };
};

/** One start's choices: the scribe, once or ongoing, its options and the operator's time zone. */
export type ScribeSetup<Id extends ScribeId = ScribeId> = {
  scribe: Id;
  mode: ScribeMode;
  options: ScribeOptions[Id];
  timezone: string;
};

/** A plugin a scribe needs: its id, display name and its Plugins page path. */
export type ScribePlugin = { id: string; name: string; catalogPath: string };

/** Static description of one scribe, shared by the list, detail and start dialog. */
export type ScribeDefinition = {
  id: ScribeId;
  title: string;
  blurb: string;
  skill: "knowledge-claim-consolidation" | "knowledge-ingest" | "knowledge-meeting-ingest";
  icon: IconName;
  tone: "blue" | "teal" | "green" | "amber";
  /** Plugin whose tools the scribe reads its source through; the page checks it is connected. */
  plugin?: ScribePlugin;
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
/** Schedule an ongoing Granola scribe uses: weekdays at 10 AM, 2 PM and 6 PM. */
export const GRANOLA_SCHEDULE = "0 10,14,18 * * 1-5";
/** Default review schedule: Sundays at 3:45 AM in the operator's timezone. */
export const REVIEW_WEEKLY_SCHEDULE = "45 3 * * 0";
/** Nightly review schedule: 3:45 AM, after the default 3:30 AM maintenance relink. */
export const REVIEW_NIGHTLY_SCHEDULE = "45 3 * * *";

export const SCRIBES: readonly ScribeDefinition[] = [
  {
    id: "claim-consolidation",
    title: "Knowledge Consolidation",
    blurb:
      "Weekly or nightly, reviews the claims that name no page: files each on its subject page, creates pages for subjects that deserve one, supersedes status snapshots by their outcome, and folds outcomes into page State.",
    skill: "knowledge-claim-consolidation",
    icon: "link",
    tone: "blue",
    modes: ["ongoing"],
    cadence: "Ongoing",
    startLabel: "Turn on…",
    dialogTitle: "Knowledge Consolidation",
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
    id: "granola",
    title: "Learn from Granola",
    blurb:
      "Turns your Granola meetings into meeting pages, keeps the people and projects in them up to date, and saves their decisions and commitments. Run it once, or keep it learning as new meetings finish.",
    skill: "knowledge-meeting-ingest",
    icon: "calendarClock",
    tone: "green",
    plugin: { id: "granola", name: "Granola", catalogPath: "openclaw/granola" },
    modes: ["ongoing", "once"],
    cadence: "Once or ongoing",
    startLabel: "Set up…",
    dialogTitle: "Learn from Granola",
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
 * Session target of a scribe's automation: each run is a fresh child session of the scribe's
 * conversation, with its memory access and workspace, so it reads the current skills instead of
 * earlier runs' history.
 */
export const SCRIBE_SESSION_TARGET = "current";
/**
 * chat.send idempotency key for one start attempt in one session. A scribe reuses its
 * conversation across starts, so each attempt (one dialog) gets its own key; retries within
 * the attempt stay deduplicated.
 */
export const setupIdempotencyKey = (id: ScribeId, sessionKey: string, attempt: string) =>
  `knowledge:scribe:${id}:${sessionKey}:${attempt}`;

/**
 * Default dialog choices: conservative (weekly review; active conversations, last 30 days; the
 * owner's Granola meetings, last 7 days).
 */
export function defaultOptions<Id extends ScribeId>(id: Id): ScribeOptions[Id] {
  const defaults: ScribeOptions = {
    "claim-consolidation": { schedule: REVIEW_WEEKLY_SCHEDULE },
    conversations: { scope: "active", since: "30d", schedule: CONVERSATIONS_SCHEDULE },
    granola: { meetings: "mine", since: "7d", schedule: GRANOLA_SCHEDULE },
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
  [GRANOLA_SCHEDULE]: "weekdays at 10:00 AM, 2:00 PM and 6:00 PM",
};
const SINCE_WORDS: Record<ConversationSince, string> = {
  "30d": "from the last 30 days",
  "90d": "from the last 90 days",
  all: "from any time",
  today: "from today on (new conversations only)",
};
const GRANOLA_SINCE_WORDS: Record<GranolaSince, string> = {
  "7d": "from the last 7 days",
  "30d": "from the last 30 days",
  today: "from today on (new meetings only)",
};
const GRANOLA_MEETING_WORDS: Record<GranolaMeetings, string> = {
  mine: "the owner's (recorded by them or with them invited)",
  all: "every meeting the Granola account can read, including notes others shared",
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

// The settings a scribe's work reads: conversations, Granola meetings and Memory files.
// Schedules are separate.
function workSettings(setup: ScribeSetup) {
  const { options } = setup;
  if ("scope" in options) {
    const which = options.scope === "all" ? "active and archived" : "active only";
    return [`Conversations: ${which}, ${SINCE_WORDS[options.since] ?? options.since}.`];
  }
  if ("meetings" in options) {
    const since = GRANOLA_SINCE_WORDS[options.since] ?? options.since;
    return [`Granola meetings: ${GRANOLA_MEETING_WORDS[options.meetings]}, ${since}.`];
  }
  if ("sources" in options) {
    return [`Memory files: ${listWords(options.sources.map((source) => MEMORY_WORDS[source]))}.`];
  }
  return [];
}

// What the scribe does, and the skill that does the work.
const PURPOSE: Record<ScribeId, string> = {
  "claim-consolidation":
    "This scribe keeps Knowledge consolidated: it files each claim that names no page on the right page (creating pages for subjects that deserve one), retires duplicates and replaced claims, retires written Timelines, and reviews a few pages each run, folding outcomes into page State.",
  conversations:
    "This scribe reads the owner's conversations and saves the decisions, preferences, commitments and lessons in them to Knowledge.",
  granola:
    "This scribe reads the owner's Granola meetings through the Granola plugin and turns each one into a meeting page, updated people and project pages, and the decisions and commitments in it.",
  memory:
    "This scribe brings what Memory already knows into Knowledge. Memory itself is left as it is.",
};

// The work step: the skill section that does it, applied to the settings.
const WORK: Record<ScribeId, string> = {
  "claim-consolidation":
    'Follow every step of the "Scribe runs" section of the knowledge-claim-consolidation skill: link and retire unlinked claims, retire written Timelines, and review pages. Do each step even when no claim is left to link.',
  conversations:
    'Follow "Learn from conversations" in the "Scribe runs" section of the knowledge-ingest skill, for the conversations in the settings.',
  granola:
    'Follow "Learn from Granola" in the "Scribe runs" section of the knowledge-meeting-ingest skill, for the Granola meetings in the settings.',
  memory:
    'Follow "Learn from Memory" in the "Scribe runs" section of the knowledge-ingest skill, for the Memory files in the settings. Never change Memory files.',
};

// What the closing sentence counts after the work.
const COUNTS: Record<ScribeId, string> = {
  "claim-consolidation":
    "claims examined, linked, superseded, withdrawn and left; Timelines retired and left; pages reviewed, changed and left unchanged",
  conversations: "conversations learned and skipped, claims and pages written",
  granola:
    "meetings ingested, already in Knowledge, left pending and without a transcript, pages and claims written",
  memory: "files read, items saved, already known and skipped",
};

const UNATTENDED = "Don't ask questions: nobody is watching this turn.";

/**
 * Wording a run message is generated from; earlier releases generated some of it differently.
 * `work` and `counts` replace a scribe's current work step and closing counts; `rules` are a
 * scribe's extra closing rules after the failure rule.
 */
type RunWording = {
  access: string;
  work?: Partial<Record<ScribeId, string>>;
  counts?: Partial<Record<ScribeId, string>>;
  rules?: Partial<Record<ScribeId, string>>;
};

const ACCESS_UNPROVISIONED =
  "Call knowledge_status. Go on when the scope is private and writes are enabled, or the store is unprovisioned (a vault that was never written reports writes off until its first write). Otherwise stop: this conversation lacks the owner's private Knowledge access.";
const ACCESS_NEVER_WRITTEN =
  'Call knowledge_status. Go on when the scope is private and writes are enabled; a never-written store reports "unprovisioned" and is created by your first Knowledge call. Otherwise stop: this conversation lacks the owner\'s private Knowledge access.';
// Consolidation framed as claim filing only, before runs followed every step of its skill.
const CLAIMS_ONLY = {
  work: {
    "claim-consolidation":
      'Follow the "Scribe runs" section of the knowledge-claim-consolidation skill: consolidate every claim that names no page until none is left to decide.',
  },
  counts: { "claim-consolidation": "claims examined, linked, superseded, withdrawn and left" },
};
// A Granola run that only left meetings pending, with nothing outside the run in the way, did no
// work it can call done; it says so instead of reporting `on`.
const GRANOLA_ATTENTION = {
  rules: {
    granola:
      "If meetings are left pending and none was ingested, and nothing outside this run held them back (still recording, no transcript yet, or verification that still fails after a fix attempt), end with `Scribe status: needs attention — <why>` instead.",
  },
};

/**
 * Every wording a released run message was generated from, oldest first; the last is current.
 * Add the replaced wording here whenever a change alters generated run messages, so the Scribes
 * page can recognize an unedited earlier message and upgrade it.
 */
const RUN_WORDINGS: readonly RunWording[] = [
  { access: ACCESS_UNPROVISIONED, ...CLAIMS_ONLY },
  { access: ACCESS_NEVER_WRITTEN, ...CLAIMS_ONLY },
  { access: ACCESS_NEVER_WRITTEN },
  { access: ACCESS_NEVER_WRITTEN, ...GRANOLA_ATTENTION },
];

// The access step, work step, closing counts and extra rules a wording generates for one scribe.
const wordingParts = (id: ScribeId, wording: RunWording) => [
  wording.access,
  wording.work?.[id] ?? WORK[id],
  wording.counts?.[id] ?? COUNTS[id],
  wording.rules?.[id] ?? "",
];
const CURRENT_WORDING = RUN_WORDINGS.at(-1)!;

// Step 1 of every prompt; `fix` says how the owner restores access.
const accessStep = (fix: string, wording = CURRENT_WORDING) => `${wording.access} ${fix}`;

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
 * jobs of other conversations of this agent (carrying a pause over), add, then check the target.
 * Another agent's automations are never touched. `keep` is a repair's condition for leaving a
 * healthy automation alone; `saved` is an update's line for the options it carries over.
 */
// `enabled` is how the added automation's enabled flag is set: setup keeps a pause, repair turns it on.
function automationSteps(
  scribe: ScribeDefinition,
  schedule: string,
  enabled: string,
  keep = "",
  saved?: string,
) {
  const key = scribeDeclarationKey(scribe.id);
  return [
    `With the automations tool, list automations for this agent (pass \`agentId\` from Runtime), including disabled ones, and take those with declaration key \`${key}\` whose recorded \`owner.agentId\` is this agent's ID from Runtime. Leave any with another or missing owner agent unchanged; never remove another agent's automation.${keep} Remove each one owned by another conversation, noting whether it was paused. If this conversation owns one whose session target is not \`${SCRIBE_SESSION_TARGET}\`, update its session target to \`${SCRIBE_SESSION_TARGET}\`.`,
    [
      "Add the automation with the automations tool:",
      "- agent: this agent's ID from Runtime",
      `- name: Knowledge scribe · ${scribe.title}`,
      `- declaration key: \`${key}\``,
      `- schedule: ${schedule}`,
      `- session target: \`${SCRIBE_SESSION_TARGET}\`, so each run starts in a fresh session of this conversation`,
      "- payload: an agent turn whose message is the run message below, exactly as written inside the fence",
      saved
        ? "- delivery and failure alert: as saved on the current automation (below)"
        : "- delivery: none; failure alert after 2 failed runs",
      ...(saved ? [saved] : []),
      `Adding with an existing declaration key updates this conversation's automation in place. ${enabled}`,
    ].join("\n"),
    `Get the automation and check that its session target is \`${SCRIBE_SESSION_TARGET}\` and its session key is this conversation's.`,
  ];
}

// A run message in a fence, after the prompt that installs it.
const runMessageBlock = (message: string) => ["Run message:", "", "```text", message, "```"];

/**
 * The message an ongoing scribe's automation sends each run: the work settings, the work step
 * and the closing line. Editing it on the automation changes what later runs do.
 */
function runPrompt(setup: ScribeSetup, wording = CURRENT_WORDING) {
  const scribe = scribeById(setup.scribe)!;
  const settings = workSettings(setup);
  return [
    `Scheduled run of the Knowledge scribe "${scribe.title}". ${UNATTENDED}`,
    ...(settings.length ? ["", "Settings:", ...settings.map((line) => `- ${line}`)] : []),
    "",
    "Steps:",
    ...numbered([
      accessStep("A repair from the Scribes page fixes it.", wording),
      `${wording.work?.[scribe.id] ?? WORK[scribe.id]} This run can't change automations: if its setup looks broken, say a repair is needed.`,
      endStep(
        "on",
        `one sentence with counts: ${wording.counts?.[scribe.id] ?? COUNTS[scribe.id]}`,
      ),
    ]),
    "",
    FAILED,
    ...(wording.rules?.[scribe.id] ? ["", wording.rules[scribe.id]!] : []),
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
      ...(CURRENT_WORDING.rules?.[scribe.id] ? ["", CURRENT_WORDING.rules[scribe.id]!] : []),
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
      ...automationSteps(
        scribe,
        "the cron expression and time zone in the settings",
        "Pass `enabled: false` only when a removed automation was paused and this conversation had none, so the pause carries over. Otherwise leave `enabled` out: never turn on a paused automation.",
      ),
      "Don't start a run from this turn: a run started here is skipped when the turn ends. The Scribes page starts the first run.",
      `Report the automation's ID and next run time. ${endStep("on", "one sentence: the automation and its next run")}`,
    ]),
    "",
    FAILED,
    "",
    ...runMessageBlock(runPrompt(setup)),
  ].join("\n");
}

// The keys of a settings word table, typed: each table is a `Record` over exactly its choices.
const choicesOf = <K extends string>(words: Record<K, string>) =>
  // SAFETY: `words` is a Record<K, string> literal, so its own keys are exactly K.
  Object.keys(words) as K[];

// Every choice of the settings a run message spells out; a scribe without settings has one.
function settingsChoices(id: ScribeId): ScribeOptions[ScribeId][] {
  if (id === "conversations") {
    return (["active", "all"] as const).flatMap((scope) =>
      choicesOf(SINCE_WORDS).map((since) => ({ scope, since })),
    );
  }
  if (id === "granola") {
    return choicesOf(GRANOLA_MEETING_WORDS).flatMap((meetings) =>
      choicesOf(GRANOLA_SINCE_WORDS).map((since) => ({ meetings, since })),
    );
  }
  return [defaultOptions(id)];
}

/**
 * How an ongoing scribe's run message compares with the one Knowledge generates now.
 * - current: it is the current generated message.
 * - custom: it differs from every generated message, and nothing in it is wording Knowledge has
 *   since replaced.
 * - outdated: an earlier version generated it unchanged; `current` replaces it.
 * - differs: it differs from every generated message and still carries wording Knowledge has since
 *   replaced, so new run instructions are available (the plugin can't tell who changed it). An update
 *   is available); `current` is what resetting it applies, for the settings the message names
 *   (the defaults when it names none Knowledge generates).
 */
export type RunMessageCheck =
  | { state: "current" | "custom" }
  | { state: "outdated" | "differs"; current: string };

/** Compare a scribe automation's run message with every message each version generated. */
export function checkRunMessage(id: ScribeId, message: string): RunMessageCheck {
  const choices = settingsChoices(id);
  const generate = (options: ScribeOptions[ScribeId], wording?: RunWording) =>
    runPrompt({ scribe: id, mode: "ongoing", options, timezone: "UTC" }, wording);
  for (const options of choices) {
    if (message === generate(options)) {
      return { state: "current" };
    }
    if (RUN_WORDINGS.slice(0, -1).some((wording) => message === generate(options, wording))) {
      return { state: "outdated", current: generate(options) };
    }
  }
  // A replaced part counts only where the message lacks its current text (which may contain it).
  const current = wordingParts(id, CURRENT_WORDING);
  const replaced = RUN_WORDINGS.slice(0, -1).some((wording) =>
    wordingParts(id, wording).some(
      (text, part) =>
        text !== "" &&
        text !== current[part] &&
        message.includes(text) &&
        !message.includes(current[part]!),
    ),
  );
  if (!replaced) {
    return { state: "custom" };
  }
  // A differing message keeps its settings when it still names a generated settings line.
  const named = choices.find((options) =>
    workSettings(scribeSetup(id, "ongoing", options)).every((line) =>
      message.includes(`- ${line}`),
    ),
  );
  return { state: "differs", current: generate(named ?? defaultOptions(id)) };
}

/** First words of every repair prompt; the page never forces a first run after one. */
export const REPAIR_HEADING = "Repair the Knowledge scribe";
/** First words of every update prompt; the page never forces a first run after one either. */
export const UPDATE_HEADING = "Update the Knowledge scribe";

/** What a repair or update keeps from the scribe's current automation. */
export type RepairSource = {
  schedule: { kind: string; expr?: string; tz?: string };
  runMessage?: string;
  /**
   * Options saved on the automation that a re-declaration would otherwise drop or reset (payload
   * model or thinking, active hours, pacing, idle-only, trigger, delivery and failure alert), so the
   * turn passes them on.
   */
  saved?: Record<string, unknown>;
};

/**
 * The message that asks a scribe's conversation to re-declare its automation, keeping its
 * schedule and run message (an unedited one from an earlier version becomes the current one).
 * It does no work.
 * - repair: take the automation over and turn it back on.
 * - update: bring it up to this version (fresh session per run, the given run message) and keep
 *   it paused or on as it is. A turn in the conversation re-declares it, so the automation keeps
 *   the authority of the owner's authenticated turn; an edit from the page would drop it.
 */
export function repairPrompt(
  id: ScribeId,
  current: RepairSource,
  purpose: "repair" | "update" = "repair",
) {
  const scribe = scribeById(id)!;
  const { schedule } = current;
  const timezone = schedule.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scheduleSetting =
    schedule.kind === "cron" && schedule.expr
      ? scheduleLine(schedule.expr, timezone)
      : "Keeps the schedule of its current automation.";
  const check =
    current.runMessage === undefined ? undefined : checkRunMessage(id, current.runMessage);
  const runMessage =
    check?.state === "outdated"
      ? check.current
      : (current.runMessage ?? runPrompt(scribeSetup(id, "ongoing", defaultOptions(id), timezone)));
  const repair = purpose === "repair";
  const saved =
    current.saved && Object.keys(current.saved).length
      ? `- also these options saved on the current automation, exactly as written: \`${JSON.stringify(current.saved)}\`${"toolsAllow" in current.saved ? '. Pass `toolsAllowMode: "exact"` so its tool list stays exactly as saved' : ""}`
      : undefined;
  const healthy = `this conversation owns it, its session target is \`${SCRIBE_SESSION_TARGET}\` with this conversation's session key, its message is the run message below`;
  return [
    `${repair ? REPAIR_HEADING : UPDATE_HEADING} "${scribe.title}" in this conversation. Don't do its work in this turn. ${UNATTENDED}`,
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
        repair
          ? "Pass `enabled: true`: a repair turns the scribe back on, even when the scheduler paused it after failed runs."
          : "Leave `enabled` out: an update keeps a paused automation paused.",
        repair
          ? ` If exactly one exists, ${healthy} and it is enabled, leave it as it is and go to the last step.`
          : ` If exactly one exists and ${healthy}, leave it as it is and go to the last step.`,
        saved,
      ),
      endStep("on", `one sentence: what the ${purpose} changed`),
    ]),
    "",
    FAILED,
    "",
    ...runMessageBlock(runMessage),
  ].join("\n");
}
