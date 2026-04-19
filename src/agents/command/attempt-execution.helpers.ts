import fs from "node:fs/promises";
import readline from "node:readline";
import {
  isSilentReplyPrefixText,
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
} from "../../auto-reply/tokens.js";

/** Maximum number of JSONL records to inspect before giving up. */
const SESSION_FILE_MAX_RECORDS = 500;

/**
 * Check whether a session transcript shows that the latest user message has
 * already been answered — that is, there exists an assistant message **after**
 * the most recent user message in the flushed session file.
 *
 * This is narrower than "has any assistant message anywhere in the transcript":
 * the fallback-retry path in attempt-execution needs to decide whether to treat
 * the current turn as a "continue where you left off" follow-up. A transcript
 * with only prior-turn assistant messages (and a fresh unanswered user turn on
 * top) must NOT count as "already answered" — otherwise the retry context gets
 * injected and the fallback model re-answers a stale turn (#69086).
 */
export async function sessionFileHasContent(sessionFile: string | undefined): Promise<boolean> {
  if (!sessionFile) {
    return false;
  }
  try {
    // Guard against symlink-following (CWE-400 / arbitrary-file-read vector).
    const stat = await fs.lstat(sessionFile);
    if (stat.isSymbolicLink()) {
      return false;
    }

    const fh = await fs.open(sessionFile, "r");
    try {
      const rl = readline.createInterface({ input: fh.createReadStream({ encoding: "utf-8" }) });
      let recordCount = 0;
      let hasAssistantAfterLatestUser = false;
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }
        recordCount++;
        if (recordCount > SESSION_FILE_MAX_RECORDS) {
          break;
        }
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const rec = obj as Record<string, unknown> | null;
        if (rec?.type !== "message") {
          continue;
        }
        const role = (rec.message as Record<string, unknown> | undefined)?.role;
        if (role === "user") {
          // A newer user turn has not been answered yet. Reset the guard so
          // only an assistant message AFTER this line flips it back to true.
          hasAssistantAfterLatestUser = false;
          continue;
        }
        if (role === "assistant") {
          hasAssistantAfterLatestUser = true;
        }
      }
      return hasAssistantAfterLatestUser;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export function resolveFallbackRetryPrompt(params: {
  body: string;
  isFallbackRetry: boolean;
  sessionHasHistory?: boolean;
}): string {
  if (!params.isFallbackRetry) {
    return params.body;
  }
  if (!params.sessionHasHistory) {
    return params.body;
  }
  // Even with persisted session history, fully replacing the body with a
  // generic "continue where you left off" message strips the original task
  // from the fallback model's view. Agents then have to reconstruct the
  // instruction from history alone, which is fragile and sometimes
  // impossible. Prepend the retry context to the original body instead so
  // the fallback model has both the recovery signal AND the task. (#65760)
  return `[Retry after the previous model attempt failed or timed out]\n\n${params.body}`;
}

export function createAcpVisibleTextAccumulator() {
  let pendingSilentPrefix = "";
  let visibleText = "";
  let rawVisibleText = "";
  const startsWithWordChar = (chunk: string): boolean => /^[\p{L}\p{N}]/u.test(chunk);

  const resolveNextCandidate = (base: string, chunk: string): string => {
    if (!base) {
      return chunk;
    }
    if (
      isSilentReplyText(base, SILENT_REPLY_TOKEN) &&
      !chunk.startsWith(base) &&
      startsWithWordChar(chunk)
    ) {
      return chunk;
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      return chunk;
    }
    return `${base}${chunk}`;
  };

  const mergeVisibleChunk = (base: string, chunk: string): { rawText: string; delta: string } => {
    if (!base) {
      return { rawText: chunk, delta: chunk };
    }
    if (chunk.startsWith(base) && chunk.length > base.length) {
      const delta = chunk.slice(base.length);
      return { rawText: chunk, delta };
    }
    return {
      rawText: `${base}${chunk}`,
      delta: chunk,
    };
  };

  return {
    consume(chunk: string): { text: string; delta: string } | null {
      if (!chunk) {
        return null;
      }

      if (!visibleText) {
        const leadCandidate = resolveNextCandidate(pendingSilentPrefix, chunk);
        const trimmedLeadCandidate = leadCandidate.trim();
        if (
          isSilentReplyText(trimmedLeadCandidate, SILENT_REPLY_TOKEN) ||
          isSilentReplyPrefixText(trimmedLeadCandidate, SILENT_REPLY_TOKEN)
        ) {
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (startsWithSilentToken(trimmedLeadCandidate, SILENT_REPLY_TOKEN)) {
          const stripped = stripLeadingSilentToken(leadCandidate, SILENT_REPLY_TOKEN);
          if (stripped) {
            pendingSilentPrefix = "";
            rawVisibleText = leadCandidate;
            visibleText = stripped;
            return { text: stripped, delta: stripped };
          }
          pendingSilentPrefix = leadCandidate;
          return null;
        }
        if (pendingSilentPrefix) {
          pendingSilentPrefix = "";
          rawVisibleText = leadCandidate;
          visibleText = leadCandidate;
          return {
            text: visibleText,
            delta: leadCandidate,
          };
        }
      }

      const nextVisible = mergeVisibleChunk(rawVisibleText, chunk);
      rawVisibleText = nextVisible.rawText;
      if (!nextVisible.delta) {
        return null;
      }
      visibleText = `${visibleText}${nextVisible.delta}`;
      return { text: visibleText, delta: nextVisible.delta };
    },
    finalize(): string {
      return visibleText.trim();
    },
    finalizeRaw(): string {
      return visibleText;
    },
  };
}
