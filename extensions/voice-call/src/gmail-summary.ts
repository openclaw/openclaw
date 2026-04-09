/**
 * Post-call Gmail summary: generates a call summary via Haiku and
 * creates a Gmail draft using the `gog` CLI.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VOICE_DEBUG_ENABLED = !!process.env.VOICE_DEBUG;
const VOICE_DEBUG_LOG = VOICE_DEBUG_ENABLED
  ? path.join(os.homedir(), ".openclaw", "voice-debug.log")
  : null;
function voiceDebug(msg: string): void {
  if (!VOICE_DEBUG_ENABLED) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  if (VOICE_DEBUG_LOG) {
    try { fs.appendFileSync(VOICE_DEBUG_LOG, line); } catch { /* ignore */ }
  }
  console.log(`[voice-debug] ${msg}`);
}

type TranscriptEntry = {
  timestamp: number;
  speaker: "bot" | "user";
  text: string;
  isFinal?: boolean;
};

type CallSummaryInput = {
  callId: string;
  from: string;
  startedAt: number;
  endedAt?: number;
  transcript: TranscriptEntry[];
  wasTransferred: boolean;
  wasBooked: boolean;
  summaryRecipient: string;
  apiKey: string;
  baseUrl?: string;
};

/** Run a gog CLI command and return stdout. */
function runGog(args: string[], timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gog", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`gog ${args[0]} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Format a timestamp as human-readable local time. */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Format duration in seconds to "Xm Ys" string. */
function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}

/** Build a plain-text transcript for the summary prompt. */
function buildTranscriptText(transcript: TranscriptEntry[]): string {
  return transcript
    .filter((e) => e.isFinal !== false)
    .map((e) => `${e.speaker === "user" ? "Caller" : "AI"}: ${e.text}`)
    .join("\n");
}

/** Generate a call summary using Haiku. */
async function generateSummary(
  transcript: TranscriptEntry[],
  from: string,
  duration: string,
  wasTransferred: boolean,
  wasBooked: boolean,
  apiKey: string,
  baseUrl = "https://api.anthropic.com",
): Promise<string> {
  const transcriptText = buildTranscriptText(transcript);

  if (!transcriptText.trim()) {
    return "No conversation recorded (caller may have hung up immediately).";
  }

  const prompt = `Summarize this phone call for the business owner. Be concise and actionable.

Call from: ${from}
Duration: ${duration}
${wasBooked ? "Calendar appointment was booked during the call." : ""}
${wasTransferred ? "Call was transferred to a human." : ""}

Transcript:
${transcriptText}

Write a brief summary with:
1. **Caller intent** — what did they want? (1 sentence)
2. **Key details** — names, dates, numbers mentioned
3. **Outcome** — what happened (booked, transferred, question answered, etc.)
4. **Action items** — anything the business owner needs to follow up on (or "None")

Keep it under 150 words. No greetings or sign-offs.`;

  const normalizedBase = baseUrl.replace(/\/v1\/?$/, "");

  const response = await fetch(`${normalizedBase}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`Anthropic API error (${response.status}): ${errBody.slice(0, 200)}`);
  }

  const data = (await response.json()) as any;
  const text = data?.content?.[0]?.text;
  if (!text) throw new Error("No text in Anthropic response");
  return text;
}

/**
 * Generate a post-call summary and create a Gmail draft.
 * Fires asynchronously after call.ended — errors are logged, not thrown.
 */
export async function createPostCallSummary(input: CallSummaryInput): Promise<void> {
  const {
    callId,
    from,
    startedAt,
    endedAt,
    transcript,
    wasTransferred,
    wasBooked,
    summaryRecipient,
    apiKey,
    baseUrl,
  } = input;

  const duration = endedAt ? formatDuration(endedAt - startedAt) : "unknown";
  const callTime = formatTime(startedAt);

  voiceDebug(`[gmail] Generating post-call summary for ${callId} (${transcript.length} transcript entries)`);

  try {
    // Generate summary via Haiku
    const summary = await generateSummary(
      transcript,
      from,
      duration,
      wasTransferred,
      wasBooked,
      apiKey,
      baseUrl,
    );

    voiceDebug(`[gmail] Summary generated (${summary.length} chars)`);

    // Build email body
    const body = `Call Summary — ${callTime}
From: ${from}
Duration: ${duration}
${wasBooked ? "📅 Appointment booked\n" : ""}${wasTransferred ? "📞 Transferred to human\n" : ""}
---

${summary}

---
Full Transcript:

${buildTranscriptText(transcript) || "(empty)"}`;

    const subject = `Voice Call Summary: ${from} — ${callTime}`;

    // Create Gmail draft via gog CLI
    await runGog([
      "gmail", "drafts", "create",
      "--to", summaryRecipient,
      "--subject", subject,
      "--body", body,
      "--force",
    ]);

    voiceDebug(`[gmail] Draft created for ${callId} → ${summaryRecipient}`);
    console.log(`[voice-call] Post-call summary draft created for ${from}`);
  } catch (err) {
    // Non-fatal — log and continue, never crash the gateway
    voiceDebug(`[gmail] ERROR creating summary: ${err}`);
    console.error(`[voice-call] Failed to create post-call summary: ${err}`);
  }
}
