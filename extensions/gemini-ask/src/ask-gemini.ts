/**
 * gemini-ask: browser automation for querying Gemini AI.
 *
 * Replaces the unreliable multi-step browser snapshot/click/type dance
 * with a single deterministic tool call.
 *
 * Real Gemini DOM structure (observed 2026-02-24, zh-CN locale):
 *
 *   Input area:
 *     textbox "为 Gemini 输入提示" [ref=e314]
 *
 *   Model selector (bottom, near input):
 *     button "打开模式选择器" [ref=e338]
 *       generic [ref=e341]: 快速           <-- current model label
 *       img: keyboard_arrow_down
 *
 *   After clicking model selector, dropdown options appear as:
 *     button "快速" [ref=eXXX]
 *     button "思考" [ref=eXXX]
 *     button "Pro" [ref=eXXX]
 *
 *   No separate "Send" button: use type(..., submit: true) to press Enter.
 */

import {
  browserAct,
  browserNavigate,
  type BrowserActRequest,
} from "../../../src/browser/client-actions-core.js";
import {
  browserOpenTab,
  browserSnapshot,
  type SnapshotResult,
} from "../../../src/browser/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GeminiModel = "flash" | "pro" | "thinking";

export type AskGeminiOpts = {
  question: string;
  model?: GeminiModel;
  profile?: string;
  /** Max ms to wait for Gemini to finish generating (default 60 000) */
  timeoutMs?: number;
};

export type AskGeminiResult = {
  ok: boolean;
  answer?: string;
  model?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GEMINI_URL = "https://gemini.google.com/app";
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Take an AI-format snapshot and return the text + targetId.
 */
async function snap(
  baseUrl: string | undefined,
  targetId: string,
  profile?: string,
): Promise<{ text: string; targetId: string }> {
  const result: SnapshotResult = await browserSnapshot(baseUrl, {
    format: "ai",
    targetId,
    profile,
    maxChars: 30000,
  });
  if (result.format === "ai") {
    return { text: result.snapshot, targetId: result.targetId };
  }
  return { text: JSON.stringify(result.nodes), targetId: result.targetId };
}

async function act(baseUrl: string | undefined, req: BrowserActRequest, profile?: string) {
  return await browserAct(baseUrl, req, { profile });
}

// ---------------------------------------------------------------------------
// DOM parsing (based on real Gemini AI snapshot format)
// ---------------------------------------------------------------------------

// Model labels in both Chinese and English UI
const MODEL_LABELS: Record<GeminiModel, RegExp> = {
  flash: /快速|Flash/i,
  thinking: /思考|Thinking/i,
  pro: /\bPro\b/i,
};

/**
 * Find the "打开模式选择器" / "Open mode selector" button and read the
 * current model from its child text node.
 *
 * Real DOM:
 *   button "打开模式选择器" [ref=e338]
 *     generic [ref=e341]: 快速
 *     img: keyboard_arrow_down
 */
function findModelSelector(snapshotText: string):
  | {
      ref: string;
      currentLabel: string;
    }
  | undefined {
  const lines = snapshotText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/button/i.test(line) && /模式选择器|mode.*selector|model.*selector/i.test(line)) {
      const refMatch = line.match(/\[ref=(\w+)\]/);
      if (!refMatch) continue;
      // The next few lines contain the current model label
      let currentLabel = "";
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const child = lines[j];
        // Look for "generic [ref=eXXX]: 快速" pattern
        const labelMatch = child.match(/generic\s+\[ref=\w+\]:\s*(.+)/);
        if (labelMatch) {
          currentLabel = labelMatch[1].trim();
          break;
        }
      }
      return { ref: refMatch[1], currentLabel };
    }
  }
  return undefined;
}

/**
 * After opening the model dropdown, find the button for the desired model.
 */
function findModelOption(snapshotText: string, pattern: RegExp): string | undefined {
  const lines = snapshotText.split("\n");
  for (const line of lines) {
    // Match option buttons like: button "快速" [ref=e363]
    // or: generic "Flash" [ref=e200]
    const labelMatch = line.match(/"([^"]+)"/);
    if (!labelMatch) continue;
    const label = labelMatch[1];
    if (!pattern.test(label)) continue;
    // Must be a button or clickable element
    if (!/button|option|menuitem|cursor=pointer/i.test(line)) continue;
    const refMatch = line.match(/\[ref=(\w+)\]/);
    if (refMatch) return refMatch[1];
  }
  return undefined;
}

/**
 * Find the main text input area.
 *
 * Real DOM:
 *   textbox "为 Gemini 输入提示" [ref=e314]
 */
function findInputRef(snapshotText: string): string | undefined {
  const lines = snapshotText.split("\n");
  for (const line of lines) {
    if (/textbox/i.test(line) && /Gemini|输入提示|Enter.*prompt/i.test(line)) {
      const m = line.match(/\[ref=(\w+)\]/);
      if (m) return m[1];
    }
  }
  // Fallback: any textbox with a ref
  for (const line of lines) {
    if (/textbox/i.test(line)) {
      const m = line.match(/\[ref=(\w+)\]/);
      if (m) return m[1];
    }
  }
  return undefined;
}

/**
 * Detect whether Gemini is currently generating.
 * During generation the snapshot shows "停止生成" / "Stop generating" or
 * a spinning stop_circle icon.
 */
function isGenerating(snapshotText: string): boolean {
  return /停止生成|Stop generating|stop_circle/i.test(snapshotText);
}

/**
 * Extract Gemini's last response from the conversation snapshot.
 *
 * After a question is submitted, the page navigates to a conversation URL
 * like gemini.google.com/app/<id>. The real DOM structure is:
 *
 *   heading "Gemini 说" [level=2] [ref=e114]
 *   paragraph [ref=e119]: "2"
 *   ... more paragraphs / generic nodes with answer text ...
 *   button "答得好" ...   <-- feedback buttons mark end of response
 *
 * We look for the last `heading "Gemini 说"` (or "Gemini said") and
 * collect all text content until we hit feedback buttons or the input area.
 */
function extractLastResponse(snapshotText: string): string | undefined {
  const lines = snapshotText.split("\n");
  const textLines: string[] = [];
  let inResponse = false;

  for (const line of lines) {
    // Start marker: heading containing "Gemini 说" or "Gemini said"
    if (/heading.*Gemini\s*(说|said)/i.test(line)) {
      inResponse = true;
      textLines.length = 0; // keep only the last response block
      continue;
    }
    // Also detect model-response / message-content if present
    if (/model-response|message-content/i.test(line)) {
      inResponse = true;
      textLines.length = 0;
      continue;
    }
    if (inResponse) {
      // Stop at feedback buttons or the next input area
      if (/button.*答得好|button.*thumb_up|button.*答得不好|button.*thumb_down/i.test(line)) {
        break;
      }
      if (/textbox.*Gemini|textbox.*输入提示/i.test(line)) {
        break;
      }
      // Extract text content from lines like:
      //   paragraph [ref=e119]: "2"
      //   generic [ref=e200]: some text
      //   text: some text
      const textMatch = line.match(/:\s+(.+)$/);
      if (textMatch) {
        let content = textMatch[1].trim();
        // Strip surrounding quotes if present (e.g. "2" -> 2)
        if (content.startsWith('"') && content.endsWith('"') && content.length > 2) {
          content = content.slice(1, -1);
        }
        // Skip UI control elements
        if (/^button|^link\b|^img\b|^navigation|^menu\b|^heading/i.test(content)) continue;
        // Skip empty refs and icon names
        if (/^(thumb_up|thumb_down|refresh|content_copy|more_vert|share|edit)$/i.test(content))
          continue;
        if (content.length > 0) {
          textLines.push(content);
        }
      }
    }
  }

  const result = textLines.join("\n").trim();
  return result.length > 0 ? result : undefined;
}

/**
 * Check if the desired model is already selected by reading the
 * model selector's current label.
 */
function isModelAlreadySelected(currentLabel: string, desired: GeminiModel): boolean {
  return MODEL_LABELS[desired].test(currentLabel);
}

// ---------------------------------------------------------------------------
// Main workflow
// ---------------------------------------------------------------------------

export async function askGemini(opts: AskGeminiOpts): Promise<AskGeminiResult> {
  const { question, model = "flash", profile = "openclaw", timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  const baseUrl: string | undefined = undefined;

  try {
    // 1. Open a fresh Gemini tab (always start a new conversation)
    const tab = await browserOpenTab(baseUrl, GEMINI_URL, { profile });
    const targetId = tab.targetId;
    await sleep(2500);

    // 2. Take initial snapshot
    let snapshot = await snap(baseUrl, targetId, profile);

    // 3. Switch model if needed
    const selector = findModelSelector(snapshot.text);
    if (selector && !isModelAlreadySelected(selector.currentLabel, model)) {
      // Click the model selector to open dropdown
      await act(baseUrl, { kind: "click", ref: selector.ref, targetId }, profile);
      await sleep(1000);

      // Re-snapshot to see the dropdown
      snapshot = await snap(baseUrl, targetId, profile);
      const optionRef = findModelOption(snapshot.text, MODEL_LABELS[model]);
      if (optionRef) {
        await act(baseUrl, { kind: "click", ref: optionRef, targetId }, profile);
        await sleep(500);
      }
    }

    // 4. Find input box and type the question
    snapshot = await snap(baseUrl, targetId, profile);
    const inputRef = findInputRef(snapshot.text);
    if (!inputRef) {
      return { ok: false, error: "Cannot find Gemini input box. The page may need login." };
    }

    // Use kind:"type" (NOT "fill") to enter text, with submit:true to press Enter
    await act(
      baseUrl,
      { kind: "type", ref: inputRef, text: question, submit: true, targetId },
      profile,
    );

    // 5. Poll until Gemini finishes generating.
    // After submit, the page navigates to a conversation URL. Wait for:
    //   - "Gemini 说" heading to appear (response started)
    //   - generation spinner to disappear (response finished)
    const deadline = Date.now() + timeoutMs;
    await sleep(3000); // initial wait for response to start

    let answer: string | undefined;
    let consecutiveNotGenerating = 0;
    while (Date.now() < deadline) {
      snapshot = await snap(baseUrl, targetId, profile);
      if (isGenerating(snapshot.text)) {
        consecutiveNotGenerating = 0;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      // Not generating: try extracting. Require 2 consecutive non-generating
      // polls to avoid premature extraction during initial page transition.
      consecutiveNotGenerating++;
      if (consecutiveNotGenerating >= 2) {
        answer = extractLastResponse(snapshot.text);
        if (answer) break;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // Final extraction attempt
    if (!answer) {
      snapshot = await snap(baseUrl, targetId, profile);
      answer = extractLastResponse(snapshot.text);
    }

    if (!answer) {
      return { ok: false, error: "Gemini did not produce a response within the timeout." };
    }

    return { ok: true, answer, model };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
