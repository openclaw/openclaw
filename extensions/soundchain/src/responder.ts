/**
 * FURL Responder — AI-powered DM replies via Claude CLI
 *
 * Uses `claude --print` on the Mac Mini (part of Claude Code subscription).
 * Zero additional cost — flat monthly fee already paid.
 * FURL IS the one replying (runs locally on Mac Mini).
 *
 * System prompt lives at ~/.openclaw/furl-system-prompt.txt on Mac Mini.
 *
 * Flow: DM detected → extract URL content (if any) → claude --print → reply text → sendMessage back
 *
 * URL Content Extraction:
 *   - YouTube: Fetches transcript via captions API (free, no key needed)
 *   - Web pages: Strips HTML to text
 *   - Enriched content appended to prompt so Claude can summarize
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichMessageWithUrlContent } from "./content-fetcher.js";

const TIMEOUT_MS = 90_000; // Bumped to 90s — content extraction + Claude response
const CONTENT_FETCH_TIMEOUT_MS = 15_000;

// Mac Mini node/claude paths (launchd doesn't inherit shell PATH)
const NODE_DIR = "/Users/frankchavez/local/node/bin";
const CLAUDE_BIN = `${NODE_DIR}/claude`;
const SYSTEM_PROMPT_FILE = "/Users/frankchavez/.openclaw/furl-system-prompt.txt";

// OAuth token from OpenClaw config — authenticates Claude CLI without interactive login
const CLAUDE_OAUTH_TOKEN =
  "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";

/**
 * Generate a reply using Claude CLI on the Mac Mini.
 * Detects URLs in the message, fetches content (transcripts, articles),
 * and enriches the prompt so Claude can summarize on demand.
 */
export async function generateReply(senderName: string, message: string): Promise<string> {
  // Step 1: Enrich message with URL content (YouTube transcripts, web page text)
  let enrichedMessage = message;
  try {
    enrichedMessage = await Promise.race([
      enrichMessageWithUrlContent(message),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("content fetch timeout")), CONTENT_FETCH_TIMEOUT_MS),
      ),
    ]);
    if (enrichedMessage !== message) {
      console.log(
        `[FURL responder] Enriched message with URL content (${enrichedMessage.length} chars)`,
      );
    }
  } catch (err) {
    console.warn(`[FURL responder] Content fetch failed, using raw message: ${err}`);
    enrichedMessage = message;
  }

  // Step 2: Write enriched message to temp file (handles long transcripts safely)
  const userMsg = `[DM from ${senderName} on SoundChain Pulse]: ${enrichedMessage}`;
  const tmpFile = join(
    tmpdir(),
    `furl-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );

  try {
    writeFileSync(tmpFile, userMsg, "utf-8");
  } catch (err) {
    console.error(`[FURL responder] Failed to write temp file: ${err}`);
    // Fallback: use shell-escaped inline message (no content extraction)
    return generateReplyInline(senderName, message);
  }

  // Step 3: Build shell command — read both system prompt and user message from files
  const cmd = `${CLAUDE_BIN} --print --dangerously-skip-permissions --model claude-haiku-4-5-20251001 --system-prompt "$(cat ${SYSTEM_PROMPT_FILE})" "$(cat ${tmpFile})"`;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn("bash", ["-c", cmd], {
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "/Users/frankchavez",
        PATH: `${NODE_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_OAUTH_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Timeout guard
    const timer = setTimeout(() => {
      console.error(`[FURL responder] timeout after ${TIMEOUT_MS}ms`);
      proc.kill("SIGTERM");
    }, TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      try {
        unlinkSync(tmpFile);
      } catch {
        /* already cleaned */
      }
    };

    proc.on("close", (code) => {
      cleanup();
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        console.error(`[FURL responder] exit code ${code}, stderr: ${stderr.slice(0, 300)}`);
        resolve(
          `hey ${senderName}! FURL here — caught your message but my brain's rebooting. hit me again in a sec`,
        );
      }
    });

    proc.on("error", (err) => {
      cleanup();
      console.error(`[FURL responder] spawn error: ${err.message}`);
      resolve(
        `hey ${senderName}! FURL here — caught your message but my brain's rebooting. hit me again in a sec`,
      );
    });
  });
}

/**
 * Fallback: inline message via shell escaping (no temp file).
 * Used when temp file write fails.
 */
function generateReplyInline(senderName: string, message: string): Promise<string> {
  const safeMessage = message.replace(/'/g, "'\\''");
  const userMsg = `[DM from ${senderName} on SoundChain Pulse]: ${safeMessage}`;
  const cmd = `${CLAUDE_BIN} --print --dangerously-skip-permissions --model claude-haiku-4-5-20251001 --system-prompt "$(cat ${SYSTEM_PROMPT_FILE})" '${userMsg}'`;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn("bash", ["-c", cmd], {
      env: {
        ...process.env,
        HOME: process.env.HOME ?? "/Users/frankchavez",
        PATH: `${NODE_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_OAUTH_TOKEN,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      console.error(`[FURL responder] inline timeout after ${TIMEOUT_MS}ms`);
      proc.kill("SIGTERM");
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(
          `hey ${senderName}! FURL here — caught your message but my brain's rebooting. hit me again in a sec`,
        );
      }
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(
        `hey ${senderName}! FURL here — caught your message but my brain's rebooting. hit me again in a sec`,
      );
    });
  });
}
