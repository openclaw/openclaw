/**
 * soul-chip pause detector
 *
 * Listens for the pause keyword in user messages and toggles
 * the meditation state. The pause word halts all five elements;
 * the resume word re-awakens them.
 *
 * Detection happens in the `message_received` plugin hook so it
 * runs before the agent even starts processing.
 */

import type { SoulStore } from "./store.js";
import type { SoulChipConfig } from "./types.js";

export function createPauseDetector(store: SoulStore, config: SoulChipConfig) {
  /**
   * Check if a message text contains the pause or resume keyword.
   * Returns "pause" | "resume" | null.
   */
  function detect(text: string): "pause" | "resume" | null {
    const trimmed = text.trim();
    // Exact match or the keyword appears as a standalone word
    if (containsKeyword(trimmed, config.pauseKeyword)) return "pause";
    if (containsKeyword(trimmed, config.resumeKeyword)) return "resume";
    return null;
  }

  function containsKeyword(text: string, keyword: string): boolean {
    if (!keyword) return false;
    // Exact match (just the keyword, nothing else)
    if (text === keyword) return true;
    // The keyword appears surrounded by spaces, punctuation, or at boundaries
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp("(?:^|\\s|[,;!?])" + escaped + "(?:$|\\s|[,;!?])", "i");
    return regex.test(text);
  }

  /**
   * Handle a user message. Returns an override response if the
   * keyword was detected, or null to let normal processing continue.
   */
  async function onMessage(
    text: string,
    workspaceDir: string,
    sessionKey: string,
  ): Promise<{ action: "pause" | "resume"; response: string } | null> {
    const action = detect(text);
    if (!action) return null;

    if (action === "pause") {
      const current = await store.readPauseState(workspaceDir);
      if (current.paused) {
        return {
          action: "pause",
          response: "Already in meditation. All elements are at rest.",
        };
      }
      await store.pause(workspaceDir, sessionKey, "Triggered by keyword: " + config.pauseKeyword);
      return {
        action: "pause",
        response:
          "Entering meditation. All five elements are now at rest.\n" +
          "Only pure observation remains. To resume, speak the awakening word.",
      };
    }

    // action === "resume"
    const current = await store.readPauseState(workspaceDir);
    if (!current.paused) {
      return {
        action: "resume",
        response: "Not in meditation. All elements are already active.",
      };
    }

    const pausedAt = current.pausedAt;
    await store.resume(workspaceDir);
    return {
      action: "resume",
      response:
        "Awakening. All five elements resume their flow.\n" +
        (pausedAt ? "Meditation duration: since " + pausedAt : ""),
    };
  }

  return { detect, onMessage };
}
