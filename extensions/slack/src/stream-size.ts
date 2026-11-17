import type { AnyChunk } from "@slack/types";

/**
 * Size accounting for one native Slack stream message.
 *
 * Slack documents no total size for a streamed message, but chat.startStream
 * and chat.appendStream answer `msg_too_long` once a message that carries text
 * passes a threshold. Measured 2026-11-15 against the live API with exact
 * boundary searches (one more unit was rejected), through both methods:
 *
 * - Slack counts the message as it stores it: the plan block serialized as
 *   JSON plus the markdown text, against one ceiling of 13,200.
 * - In the plan block each task costs its JSON, 46 plus its id; titles,
 *   `details` and `output` are JSON-escaped: ASCII is one unit (`"`, `\` and
 *   `/` two), every other UTF-16 unit six, so CJK costs six per character and
 *   an emoji twelve. `details` and `output` are rich text: 132 for the field,
 *   appends extend it, and an emoji in it becomes an element of about 50.
 * - Text counts one per character (ASCII, accented Latin and CJK alike), with
 *   an emoji counted as its `:shortcode:` (🧠 7, 👍 4, ✅ 18), and is capped
 *   at 12,000 characters on its own.
 * - Rows on a message without text are not checked (a 20,000-character title
 *   was accepted), nor was the plan title. The API accepts more than 50 task
 *   ids but renders 50.
 *
 * The ledger keeps the current value of every field (a title replaced by a
 * longer one counts once) and measures it the same way, rounding up where the
 * exact cost needs a table: every status as `in_progress`, an emoji at 20 in
 * text (the longest measured shortcode is 18) and at 80 in rich text (the
 * element plus the text element after it), and the plan title as if it
 * counted. The budgets sit about 20% under the measured ceilings; the
 * pipeline still treats `msg_too_long` as a signal to continue on a new
 * message.
 */
const SLACK_STREAM_MESSAGE_BUDGET_UNITS = 10_500;
/**
 * Plan block units after which new rows go to a continuation message, so a
 * 3,000-3,500 character answer still fits on the message that ends the turn.
 */
const SLACK_STREAM_MESSAGE_ROW_BUDGET_UNITS = 7_000;
/** Text units on one message, 20% under the 12,000-character text cap. */
const SLACK_STREAM_MESSAGE_TEXT_BUDGET_UNITS = 9_600;
/** Task rows Slack renders per plan block; later ids are accepted but not shown. */
export const SLACK_STREAM_MESSAGE_TASK_BUDGET = 50;
// `{"type":"plan","block_id":"plan-id","title":"","tasks":[]}`
const SLACK_PLAN_BLOCK_UNITS = 58;
// `{"task_id":"","title":"","status":"in_progress"},`, the longest status.
const SLACK_TASK_ROW_UNITS = 49;
// `,"details":{"type":"rich_text","block_id":"XXXXXX","elements":[{"type":"rich_text_section","elements":[{"type":"text","text":""}]}]}`
const SLACK_RICH_FIELD_UNITS = 132;
const SLACK_TEXT_EMOJI_UNITS = 20;
const SLACK_RICH_TEXT_EMOJI_UNITS = 80;
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/**
 * Age after which a streamed message rolls at its next update. Measured
 * 2026-11 against the live API: Slack closes a native stream about 600-610 s
 * after chat.startStream however recently it was appended to, and later
 * appends and the stop then fail with message_not_in_streaming_state. Eight
 * minutes leaves room for a paced update to land first.
 */
export const SLACK_STREAM_MESSAGE_MAX_AGE_MS = 8 * 60_000;

export type SlackStreamMessageUpdate = {
  text?: string;
  chunks?: readonly AnyChunk[];
};

export type SlackStreamMessageBudget = {
  units: number;
  rowUnits: number;
  textUnits: number;
  tasks: number;
};

const SLACK_STREAM_MESSAGE_BUDGET: SlackStreamMessageBudget = {
  units: SLACK_STREAM_MESSAGE_BUDGET_UNITS,
  rowUnits: SLACK_STREAM_MESSAGE_ROW_BUDGET_UNITS,
  textUnits: SLACK_STREAM_MESSAGE_TEXT_BUDGET_UNITS,
  tasks: SLACK_STREAM_MESSAGE_TASK_BUDGET,
};

/** A string in the plan block's JSON: ASCII one unit, escapes two, every other UTF-16 unit six. */
function countSlackJsonStringUnits(text: string | undefined): number {
  const value = text ?? "";
  let units = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    units +=
      code >= 0x80 || code < 0x20 ? 6 : code === 0x22 || code === 0x5c || code === 0x2f ? 2 : 1;
  }
  return units;
}

/** Rich text (`details`, `output`): JSON-escaped, with an emoji stored as an emoji element. */
function countSlackRichTextUnits(text: string | undefined): number {
  let units = 0;
  for (const char of text ?? "") {
    units += EMOJI_RE.test(char) ? SLACK_RICH_TEXT_EMOJI_UNITS : countSlackJsonStringUnits(char);
  }
  return units;
}

/** Markdown text: one unit per character, an emoji as its shortcode. */
function countSlackTextUnits(text: string | undefined): number {
  let units = 0;
  for (const char of text ?? "") {
    units += EMOJI_RE.test(char) ? SLACK_TEXT_EMOJI_UNITS : 1;
  }
  return units;
}

/** Units per row: the task with its id and title, then each rich text field. */
type LedgerRow = { task: number; details: number; output: number };

function appendRichField(current: number, text: string | undefined): number {
  const units = countSlackRichTextUnits(text);
  return units === 0 ? current : current + (current === 0 ? SLACK_RICH_FIELD_UNITS : 0) + units;
}

/** Size units (see above) on one streamed message, by field. */
export class SlackStreamMessageLedger {
  /**
   * Task rows this message may hold: Slack's 50-row plan block, or fewer when
   * the account sets `streaming.progress.maxLines` (see
   * `resolveSlackNativeMessageRowLimit`).
   */
  readonly taskLimit: number;
  private readonly rows = new Map<string, LedgerRow>();
  private planTitle: number | undefined;
  private text = 0;
  // A ledger starts with its message (startStream), so this is the stream's start.
  private readonly startedAt = Date.now();

  constructor(taskLimit: number = SLACK_STREAM_MESSAGE_TASK_BUDGET) {
    this.taskLimit = Math.max(1, Math.min(Math.floor(taskLimit), SLACK_STREAM_MESSAGE_TASK_BUDGET));
  }

  /** The message is old enough that it must roll before Slack closes its stream. */
  get expiring(): boolean {
    return Date.now() - this.startedAt >= SLACK_STREAM_MESSAGE_MAX_AGE_MS;
  }

  /** Size units on the message. */
  get size(): number {
    return this.rowSize + this.text;
  }

  /** Size units of the plan block: its title and task rows. */
  get rowSize(): number {
    if (this.planTitle === undefined && this.rows.size === 0) {
      return 0;
    }
    let total = SLACK_PLAN_BLOCK_UNITS + (this.planTitle ?? 0);
    for (const row of this.rows.values()) {
      total += row.task + row.details + row.output;
    }
    return total;
  }

  get textSize(): number {
    return this.text;
  }

  get taskCount(): number {
    return this.rows.size;
  }

  get isEmpty(): boolean {
    return this.rows.size === 0 && this.planTitle === undefined && this.text === 0;
  }

  hasTask(id: string): boolean {
    return this.rows.has(id);
  }

  /** An empty ledger for a new message, with the same task limit. */
  fresh(): SlackStreamMessageLedger {
    return new SlackStreamMessageLedger(this.taskLimit);
  }

  clone(): SlackStreamMessageLedger {
    const copy = new SlackStreamMessageLedger(this.taskLimit);
    for (const [id, row] of this.rows) {
      copy.rows.set(id, { ...row });
    }
    copy.planTitle = this.planTitle;
    copy.text = this.text;
    return copy;
  }

  recordText(text: string | undefined): void {
    this.text += countSlackTextUnits(text);
  }

  recordChunk(chunk: AnyChunk): void {
    if (chunk.type === "plan_update") {
      this.planTitle = countSlackJsonStringUnits(chunk.title);
      return;
    }
    if (chunk.type === "markdown_text") {
      this.text += countSlackTextUnits(chunk.text);
      return;
    }
    if (chunk.type !== "task_update") {
      return;
    }
    // Titles replace; details and output append per id (verified live 2026-08-17).
    const row = this.rows.get(chunk.id) ?? { task: 0, details: 0, output: 0 };
    row.task =
      SLACK_TASK_ROW_UNITS +
      countSlackJsonStringUnits(chunk.id) +
      countSlackJsonStringUnits(chunk.title);
    row.details = appendRichField(row.details, chunk.details);
    row.output = appendRichField(row.output, chunk.output);
    this.rows.set(chunk.id, row);
  }

  /** Accounts for an update the caller is about to send. */
  record(update: SlackStreamMessageUpdate): void {
    this.recordText(update.text);
    for (const chunk of update.chunks ?? []) {
      this.recordChunk(chunk);
    }
  }
}

export type SlackStreamUpdateFit = {
  /** The whole update fits on the current message. */
  fits: boolean;
  /** The streamed text fits; false means it belongs on the next message. */
  textFits: boolean;
  /** New task rows that fit, in update order. */
  admittedTaskIds: Set<string>;
  /** New task rows that need a continuation message, in update order. */
  deferredTaskIds: Set<string>;
};

/**
 * Splits an update into what the current message can still take and what
 * must continue on a new one. Updates to rows already on the message always
 * apply (Slack replaces their titles in place); text and new rows are admitted
 * in order until a budget is reached, and once one new row is deferred every
 * later one is too so the plan keeps its order across messages. An empty
 * message admits at least the text and one row, since rolling could not help.
 */
export function planSlackStreamUpdateFit(
  ledger: SlackStreamMessageLedger,
  update: SlackStreamMessageUpdate,
  budget: SlackStreamMessageBudget = SLACK_STREAM_MESSAGE_BUDGET,
): SlackStreamUpdateFit {
  const empty = ledger.isEmpty;
  const base = ledger.clone();
  const incoming: AnyChunk[] = [];
  for (const chunk of update.chunks ?? []) {
    if (chunk.type === "task_update" && !ledger.hasTask(chunk.id)) {
      incoming.push(chunk);
    } else {
      base.recordChunk(chunk);
    }
  }
  const textUnits = countSlackTextUnits(update.text);
  const textFits =
    textUnits === 0 ||
    empty ||
    (base.size + textUnits <= budget.units && base.textSize + textUnits <= budget.textUnits);
  if (textFits) {
    base.recordText(update.text);
  }
  const admittedTaskIds = new Set<string>();
  const deferredTaskIds = new Set<string>();
  for (const chunk of incoming) {
    if (chunk.type !== "task_update") {
      continue;
    }
    if (deferredTaskIds.size > 0) {
      deferredTaskIds.add(chunk.id);
      continue;
    }
    const next = base.clone();
    next.recordChunk(chunk);
    const fits =
      next.taskCount <= Math.min(budget.tasks, ledger.taskLimit) &&
      next.rowSize <= budget.rowUnits &&
      next.size <= budget.units;
    if (fits || (empty && base.taskCount === 0)) {
      admittedTaskIds.add(chunk.id);
      base.recordChunk(chunk);
      continue;
    }
    deferredTaskIds.add(chunk.id);
  }
  return {
    fits: textFits && deferredTaskIds.size === 0,
    textFits,
    admittedTaskIds,
    deferredTaskIds,
  };
}
