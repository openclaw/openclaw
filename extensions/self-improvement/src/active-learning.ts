/**
 * Loop 2: Active Learning
 *
 * Hook-driven capture of corrections and preferences.
 * Uses structural signals (negation words, edit distance, tool overrides),
 * NOT LLM judgment. bmo's data shows LLMs are poor at distinguishing
 * corrections from new information.
 *
 * Learned facts are stored as structured entries in agent memory,
 * indexed by context for retrieval in future sessions.
 */
import type { BotPluginApi } from "bot/plugin-sdk";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LearnedFact {
  id: string;
  type: "correction" | "preference" | "tool_preference" | "rule";
  captured_at: string;
  session_id: string;
  description: string;
  payload: Record<string, unknown>;
  confidence: number;
  applied: number;
  last_applied?: string;
}

/** Negation/correction cue words. */
const CORRECTION_CUES = [
  "no,",
  "no ",
  "nope",
  "wrong",
  "actually",
  "not that",
  "instead",
  "don't",
  "stop",
  "never",
  "that's wrong",
  "that's not",
  "incorrect",
];

/** Preference cue patterns. */
const PREFERENCE_CUES = [
  "always use",
  "always ",
  "i prefer",
  "i like",
  "i want",
  "use this",
  "use pnpm",
  "use bun",
  "use npm",
  "use yarn",
  "please use",
  "from now on",
  "remember that",
  "remember to",
  "don't ever",
  "never use",
];

let factsDir: string | null = null;
let learnedFacts: LearnedFact[] = [];

function loadFacts(): void {
  if (!factsDir) return;
  const file = join(factsDir, "learned-facts.json");
  if (existsSync(file)) {
    try {
      learnedFacts = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      learnedFacts = [];
    }
  }
}

function saveFacts(): void {
  if (!factsDir) return;
  try {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(factsDir, "learned-facts.json"), JSON.stringify(learnedFacts, null, 2));
  } catch {
    // Best-effort persistence
  }
}

function addFact(fact: Omit<LearnedFact, "id" | "captured_at" | "confidence" | "applied">): void {
  const entry: LearnedFact = {
    ...fact,
    id: `fact-${randomUUID()}`,
    captured_at: new Date().toISOString(),
    confidence: 1.0, // User-stated facts are always confidence 1.0
    applied: 0,
  };

  learnedFacts.push(entry);
  saveFacts();

  // Also append to JSONL log for telemetry
  if (factsDir) {
    try {
      appendFileSync(join(factsDir, "learning-events.jsonl"), JSON.stringify(entry) + "\n");
    } catch {
      // Best-effort
    }
  }
}

export function createActiveLearningHooks(api: BotPluginApi) {
  // Initialize storage
  const baseDir = api.resolvePath("~/.hanzo/bot/self-improvement");
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true });
  }
  factsDir = baseDir;
  loadFacts();

  /** Track recent agent outputs for correction detection. */
  let lastAgentOutput: string | null = null;
  let lastToolUsed: string | null = null;

  return {
    /** Hook: message_received -- detect corrections and preferences in user messages. */
    onMessageReceived: async (event: any, _ctx: any) => {
      const text: string = event.text ?? event.body ?? "";
      if (!text || text.length < 3) return;

      const lower = text.toLowerCase().trim();

      // Check for correction cues
      for (const cue of CORRECTION_CUES) {
        if (lower.startsWith(cue) || lower.includes(`. ${cue}`)) {
          addFact({
            type: "correction",
            session_id: "current",
            description: text.slice(0, 300),
            payload: {
              trigger: cue,
              user_message: text.slice(0, 500),
              previous_agent_output: lastAgentOutput?.slice(0, 300),
              previous_tool: lastToolUsed,
            },
          });
          api.logger.info(`[Loop 2] Correction captured: "${text.slice(0, 80)}..."`);
          return;
        }
      }

      // Check for preference cues
      for (const cue of PREFERENCE_CUES) {
        if (lower.includes(cue)) {
          addFact({
            type: "preference",
            session_id: "current",
            description: text.slice(0, 300),
            payload: {
              trigger: cue,
              user_message: text.slice(0, 500),
            },
          });
          api.logger.info(`[Loop 2] Preference captured: "${text.slice(0, 80)}..."`);
          return;
        }
      }
    },

    /** Hook: after_tool_call -- track what tools the agent uses for correction context. */
    onToolResult: async (event: any, _ctx: any) => {
      lastToolUsed = event.toolName ?? event.name ?? null;

      // If the tool produced text output, save it for correction detection
      if (event.result?.content) {
        const textParts = event.result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text);
        if (textParts.length > 0) {
          lastAgentOutput = textParts.join("\n").slice(0, 500);
        }
      }
    },

    /** Get learned facts for injection into agent context. */
    getLearnedFacts(): LearnedFact[] {
      return learnedFacts;
    },

    /** Get facts count by type for telemetry. */
    getFactsSummary() {
      const byType: Record<string, number> = {};
      for (const fact of learnedFacts) {
        byType[fact.type] = (byType[fact.type] ?? 0) + 1;
      }
      return { total: learnedFacts.length, byType };
    },
  };
}
