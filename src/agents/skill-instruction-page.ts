import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { AsyncContext } from "../shared/async-context.js";
import {
  formatSkillInstructions,
  type SkillInstructionResult,
} from "./skill-instruction-result.js";
import {
  getToolResultDeliveryProjection,
  DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  toolResultFitsBudget,
  type ToolResultBudget,
} from "./tool-result-limits.js";

export type SkillInstructionPage = SkillInstructionResult & {
  startByte: number;
  endByte: number;
  totalBytes: number;
  nextCursor: string | null;
};

export function formatSkillInstructionPage(page: SkillInstructionPage): string {
  return `${formatSkillInstructions(page)}\n\n[Skill page ${page.startByte}:${page.endByte}/${page.totalBytes}; nextCursor=${JSON.stringify(page.nextCursor)}. Read all pages before applying instructions.]`;
}

/** The source owner re-reads and admits the document on every call; cursors retain no authority. */
export function createSkillInstructionPage(
  document: SkillInstructionResult,
  cursor?: unknown,
  budget: ToolResultBudget = {
    maxChars: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
    maxContextChars: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  },
) {
  const bytes = Buffer.from(document.content, "utf8");
  const fingerprint = sha256Hex(
    JSON.stringify([
      document.name,
      document.location,
      document.relativePath ?? null,
      document.content,
    ]),
  );
  let startByte = 0;
  if (cursor !== undefined) {
    const match = typeof cursor === "string" && /^v1:([a-f0-9]{64}):([1-9][0-9]*)$/u.exec(cursor);
    if (!match || match[1] !== fingerprint) {
      throw new Error("Invalid or stale skill cursor. Restart the read without cursor.");
    }
    startByte = Number(match[2]);
    if (
      !Number.isSafeInteger(startByte) ||
      startByte >= bytes.length ||
      (bytes[startByte]! & 0xc0) === 0x80
    ) {
      throw new Error("Invalid skill cursor boundary. Restart the read without cursor.");
    }
  }
  const projection = getToolResultDeliveryProjection();
  const make = (
    endByte: number,
  ): { content: [{ type: "text"; text: string }]; details: SkillInstructionPage } => {
    const page: SkillInstructionPage = {
      ...document,
      content: bytes.subarray(startByte, endByte).toString("utf8"),
      startByte,
      endByte,
      totalBytes: bytes.length,
      nextCursor: endByte === bytes.length ? null : `v1:${fingerprint}:${endByte}`,
    };
    return {
      content: [{ type: "text", text: formatSkillInstructionPage(page) }],
      details: page,
    };
  };
  const fits = (result: ReturnType<typeof make>) => {
    const text = result.content[0].text;
    return toolResultFitsBudget(text, budget) && (!projection || projection(result, budget));
  };
  const whole = make(bytes.length);
  if (fits(whole)) {
    return whole;
  }
  let low = startByte + 1;
  let high = bytes.length - 1;
  let best: ReturnType<typeof make> | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let end = middle;
    while (end > startByte && (bytes[end]! & 0xc0) === 0x80) {
      end--;
    }
    const trial = make(end);
    if (end > startByte && fits(trial)) {
      best = trial;
      low = middle + 1;
    } else if (end === startByte) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!best) {
    throw new Error(
      "The skill page envelope cannot fit a usable character in this caller's output budget.",
    );
  }
  return best;
}

// Recognition stays outside the filesystem guard; capture stays inside the existing reader.
// Invocation-local state cannot turn arbitrary model arguments into whole-source reads.
const skillReadContext = new AsyncContext<{
  location: string;
  cursor?: unknown;
  budget?: ToolResultBudget;
}>(Symbol("skillRead"));
export const getSkillReadContext = () => skillReadContext.getStore();
export function runWithSkillReadContext<T>(
  context: { location: string; cursor?: unknown; budget?: ToolResultBudget },
  action: () => Promise<T>,
): Promise<T> {
  return skillReadContext.run(context, action);
}
