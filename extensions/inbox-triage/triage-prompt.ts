/**
 * Builds the prompt sent to Claude for triage. Returns plain text — the
 * caller wraps it as a system event to the gateway.
 *
 * The model is asked to return STRICT JSON so we can reliably render the
 * brief and (optionally) draft replies. The schema is small on purpose;
 * additional fields can be added without breaking the renderer.
 */

import type { GmailMessageSummary } from "./gmail-client.js";
import type { WhatsAppMessageSummary } from "./whatsapp-source.js";

export type TriageInput = {
  gmail: GmailMessageSummary[];
  whatsapp: WhatsAppMessageSummary[];
  draftReplies: boolean;
};

export function buildTriagePrompt(input: TriageInput): string {
  const lines: string[] = [];
  lines.push(
    "You are the user's personal inbox assistant. Triage the following messages from the last 24 hours.",
    "",
    "For each item, assign exactly one category:",
    "  - URGENT      : needs action today, or someone is blocked on the user",
    "  - NEEDS_REPLY : a reply is expected but not urgent",
    "  - FYI         : informational, no reply expected",
    "  - IGNORE      : marketing, automated noise, spam",
    "",
    "Return STRICT JSON with this shape and no commentary outside the JSON:",
    "",
    "{",
    '  "summary": "two-sentence overview of the day so far",',
    '  "items": [',
    "    {",
    '      "id": "string (use the source id provided)",',
    '      "channel": "gmail" | "whatsapp",',
    '      "from": "sender",',
    '      "subject_or_chat": "subject line or chat name",',
    '      "category": "URGENT" | "NEEDS_REPLY" | "FYI" | "IGNORE",',
    '      "one_line": "what this is, in <=15 words",',
    '      "draft_reply": "OPTIONAL: a short reply draft if category is NEEDS_REPLY or URGENT"',
    "    }",
    "  ]",
    "}",
    "",
  );

  if (!input.draftReplies) {
    lines.push(
      "DO NOT include `draft_reply` in any item — the user has disabled reply drafting.",
      "",
    );
  }

  lines.push("=== GMAIL UNREAD ===");
  if (input.gmail.length === 0) {
    lines.push("(none)");
  } else {
    for (const m of input.gmail) {
      lines.push(
        `- id=${m.id} thread=${m.threadId} from="${m.from}" subject="${m.subject}" snippet="${m.snippet.replace(/\s+/g, " ").slice(0, 240)}"`,
      );
    }
  }

  lines.push("", "=== WHATSAPP RECENT INBOUND ===");
  if (input.whatsapp.length === 0) {
    lines.push("(none)");
  } else {
    for (const m of input.whatsapp) {
      lines.push(
        `- id=${m.id} from="${m.from}" chat=${m.chatId} text="${m.text.replace(/\s+/g, " ").slice(0, 240)}"`,
      );
    }
  }

  return lines.join("\n");
}

export type TriageItem = {
  id: string;
  channel: "gmail" | "whatsapp";
  from: string;
  subject_or_chat: string;
  category: "URGENT" | "NEEDS_REPLY" | "FYI" | "IGNORE";
  one_line: string;
  draft_reply?: string;
};

export type TriageOutput = {
  summary: string;
  items: TriageItem[];
};

/**
 * Tolerant JSON extractor — Claude occasionally wraps JSON in fences or
 * preamble despite instructions, so we look for the first balanced { ... }.
 */
export function parseTriageOutput(text: string): TriageOutput {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("triage: no JSON object found in model output");
  }
  const slice = text.slice(firstBrace, lastBrace + 1);
  const parsed = JSON.parse(slice) as TriageOutput;
  if (!parsed.summary || !Array.isArray(parsed.items)) {
    throw new Error("triage: model output missing required fields");
  }
  return parsed;
}

/**
 * Render a Markdown brief for delivery on a chat channel. WhatsApp accepts
 * a small subset of Markdown (bold via *...*) so we keep it simple.
 */
export function renderBrief(triage: TriageOutput): string {
  const buckets: Record<TriageItem["category"], TriageItem[]> = {
    URGENT: [],
    NEEDS_REPLY: [],
    FYI: [],
    IGNORE: [],
  };
  for (const item of triage.items) {
    buckets[item.category].push(item);
  }

  const sections: string[] = [];
  sections.push("*Morning brief*", "", triage.summary, "");

  const order: Array<TriageItem["category"]> = ["URGENT", "NEEDS_REPLY", "FYI", "IGNORE"];
  for (const cat of order) {
    const items = buckets[cat];
    if (items.length === 0) continue;
    sections.push(`*${cat.replace("_", " ")}* (${items.length})`);
    for (const it of items) {
      const tag = it.channel === "gmail" ? "📧" : "💬";
      sections.push(`${tag} *${it.from}* — ${it.one_line}`);
      if (it.draft_reply) {
        sections.push(`   draft: _${it.draft_reply}_`);
        sections.push(`   reply id: \`${it.id}\``);
      }
    }
    sections.push("");
  }

  sections.push(
    "_Reply with `Y <id>` to send a draft, `E <id>` to edit, or `S <id>` to skip._",
  );
  return sections.join("\n");
}
