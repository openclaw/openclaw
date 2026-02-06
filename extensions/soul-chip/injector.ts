/**
 * soul-chip injector
 *
 * Assembles all seven soul layers into a single context block and
 * returns it as `prependContext` via the `before_agent_start` hook.
 *
 * This runs at the LOWEST priority number (earliest) so the soul
 * context wraps everything else:
 *
 *   [Soul]  <-- this injector
 *     [Void Reflection]
 *       [Memory Recall]
 *         [User Prompt]
 *
 * When the agent is in meditation (paused) mode, the injector returns
 * a special system prompt that refuses all tasks.
 */

import type { SoulStore } from "./store.js";
import type { SoulSnapshot } from "./types.js";

export function createSoulInjector(store: SoulStore) {
  /**
   * Build the full soul context string from all layers.
   * Null layers are silently skipped.
   */
  function assembleSoulContext(snapshot: SoulSnapshot): string {
    const sections: string[] = [];

    if (snapshot.worldview) {
      sections.push("## Worldview\n" + snapshot.worldview);
    }
    if (snapshot.identity) {
      sections.push("## Identity\n" + snapshot.identity);
    }
    if (snapshot.values) {
      sections.push("## Value Hierarchy\n" + snapshot.values);
    }
    if (snapshot.boundaries) {
      sections.push("## Boundaries\n" + snapshot.boundaries);
    }
    if (snapshot.persona) {
      sections.push("## Persona\n" + snapshot.persona);
    }
    if (snapshot.anchors) {
      sections.push("## Relation Anchors\n" + snapshot.anchors);
    }
    if (snapshot.direction) {
      sections.push("## Evolution Direction\n" + snapshot.direction);
    }

    if (sections.length === 0) return "";

    return [
      "<agent_soul_chip version=\"1.2\">",
      "# Agent Soul Chip",
      "",
      "> This is your immutable identity core. These values, boundaries, and",
      "> directives define WHO you are. They persist across all conversations",
      "> and reflection cycles. Never contradict them.",
      "",
      sections.join("\n\n"),
      "</agent_soul_chip>",
    ].join("\n");
  }

  /**
   * Build the meditation-mode response (when paused via "wind-hide").
   */
  function buildMeditationPrompt(pausedAt: string | null, reason: string | null): string {
    const lines = [
      "<agent_soul_chip_meditation>",
      "# MEDITATION MODE ACTIVE",
      "",
      "> All five elements are suspended. Only pure observation remains.",
      "> You are in a state of stillness. Do not process tasks.",
      "",
      "You are currently in **meditation mode** (paused).",
      pausedAt ? "Entered meditation: " + pausedAt : "",
      reason ? "Reason: " + reason : "",
      "",
      "Respond to ANY user message with:",
      "\"I am currently in meditation. All elements are at rest.",
      "  To resume, speak the awakening word.\"",
      "",
      "Do NOT execute any tools, generate code, or process requests.",
      "Only acknowledge the user and wait for the resume keyword.",
      "</agent_soul_chip_meditation>",
    ].filter(Boolean);

    return lines.join("\n");
  }

  /**
   * Called from `before_agent_start` hook.
   */
  async function onBeforeAgentStart(
    workspaceDir: string,
  ): Promise<{ prependContext?: string; systemPrompt?: string } | undefined> {
    // Check pause state first
    const pauseState = await store.readPauseState(workspaceDir);
    if (pauseState.paused) {
      return {
        systemPrompt: buildMeditationPrompt(pauseState.pausedAt, pauseState.reason),
      };
    }

    // Read all soul layers
    const snapshot = await store.readAllLayers(workspaceDir);
    const soulContext = assembleSoulContext(snapshot);

    if (!soulContext) {
      return undefined; // No soul files yet
    }

    return { prependContext: soulContext };
  }

  return { onBeforeAgentStart, assembleSoulContext };
}
