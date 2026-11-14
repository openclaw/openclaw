import type { AnyChunk } from "@slack/types";
import { countSlackTextUtf8Bytes } from "./truncate.js";

/**
 * Size accounting for one native Slack stream message.
 *
 * Slack documents no total size for a streamed message, but `chat.appendStream`
 * answers `msg_too_long` once the content already on the message passes a
 * threshold. Measured 2026-09-09/10 against the live API: the check applies
 * once the message carries body text and counts task titles, `details` (about
 * double, they render as rich text) and the text in UTF-8 bytes against a
 * ceiling of roughly 10,600-11,300 bytes. A text-only stream held 9,064 bytes
 * and rejected the next 2,990; a 48-row plan with 11,215 bytes of titles
 * rejected a 92-byte answer; 24 emoji-only rows (10,418 bytes, 5,606 UTF-16
 * units, 3,200 code points) rejected a 3,045-byte answer, while 50 emoji-only
 * rows with no body text (22,900 bytes) were accepted and rendered; with 100
 * characters of `details` per row, rejection came at 8,471 bytes of titles and
 * details. The API accepts more than 50 task ids but renders 50. Slack counts
 * what is on the message, not what was sent: a title replaced by a longer one
 * counts once.
 *
 * The ledger therefore keeps the current value of every field, measures it in
 * UTF-8 bytes (code points and UTF-16 units each fit only part of the runs),
 * weighs `details` and `output` at 2 and everything else at 1. The budgets sit
 * about 19% under the ceiling for any script (Latin text is one byte per
 * character, CJK three, emoji four). They bound a handful of measured points,
 * not a documented limit; the pipeline still treats `msg_too_long` as a signal
 * to continue on a new message.
 */
const SLACK_STREAM_MESSAGE_BUDGET_CHARS = 9_000;
/**
 * Weighted UTF-8 bytes of plan title plus task rows after which new rows go
 * to a continuation message, so a 2,000-3,000 character answer still fits on
 * the message that ends the turn.
 */
const SLACK_STREAM_MESSAGE_ROW_BUDGET_CHARS = 6_000;
/** Task rows Slack renders per plan block; later ids are accepted but not shown. */
const SLACK_STREAM_MESSAGE_TASK_BUDGET = 50;
const SLACK_STREAM_RICH_FIELD_WEIGHT = 2;

export type SlackStreamMessageUpdate = {
  text?: string;
  chunks?: readonly AnyChunk[];
};

export type SlackStreamMessageBudget = {
  chars: number;
  rowChars: number;
  tasks: number;
};

const SLACK_STREAM_MESSAGE_BUDGET: SlackStreamMessageBudget = {
  chars: SLACK_STREAM_MESSAGE_BUDGET_CHARS,
  rowChars: SLACK_STREAM_MESSAGE_ROW_BUDGET_CHARS,
  tasks: SLACK_STREAM_MESSAGE_TASK_BUDGET,
};

/** UTF-8 bytes, the unit Slack's size check counts. */
function countSlackStreamChars(text: string | undefined): number {
  return text ? countSlackTextUtf8Bytes(text) : 0;
}

type LedgerRow = { title: number; details: number; output: number };

/** Weighted UTF-8 bytes on one streamed message, by field. */
export class SlackStreamMessageLedger {
  private readonly rows = new Map<string, LedgerRow>();
  private planTitle = 0;
  private text = 0;

  /** Weighted UTF-8 bytes on the message. */
  get size(): number {
    return this.rowSize + this.text;
  }

  /** Weighted UTF-8 bytes of the plan title and task rows. */
  get rowSize(): number {
    let total = this.planTitle;
    for (const row of this.rows.values()) {
      total += row.title + row.details + row.output;
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
    return this.rows.size === 0 && this.planTitle === 0 && this.text === 0;
  }

  hasTask(id: string): boolean {
    return this.rows.has(id);
  }

  clone(): SlackStreamMessageLedger {
    const copy = new SlackStreamMessageLedger();
    for (const [id, row] of this.rows) {
      copy.rows.set(id, { ...row });
    }
    copy.planTitle = this.planTitle;
    copy.text = this.text;
    return copy;
  }

  recordText(text: string | undefined): void {
    this.text += countSlackStreamChars(text);
  }

  recordChunk(chunk: AnyChunk): void {
    if (chunk.type === "plan_update") {
      this.planTitle = countSlackStreamChars(chunk.title);
      return;
    }
    if (chunk.type === "markdown_text") {
      this.text += countSlackStreamChars(chunk.text);
      return;
    }
    if (chunk.type !== "task_update") {
      return;
    }
    // Titles replace; details and output append per id (verified live 2026-08-17).
    const row = this.rows.get(chunk.id) ?? { title: 0, details: 0, output: 0 };
    row.title = countSlackStreamChars(chunk.title);
    row.details += SLACK_STREAM_RICH_FIELD_WEIGHT * countSlackStreamChars(chunk.details);
    row.output += SLACK_STREAM_RICH_FIELD_WEIGHT * countSlackStreamChars(chunk.output);
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
  const textChars = countSlackStreamChars(update.text);
  const textFits = textChars === 0 || empty || base.size + textChars <= budget.chars;
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
      next.taskCount <= budget.tasks &&
      next.rowSize <= budget.rowChars &&
      next.size <= budget.chars;
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
