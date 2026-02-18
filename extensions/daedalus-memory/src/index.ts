/**
 * DAEDALUS Memory Plugin — complete entry point.
 *
 * Wires trust-scored memory (db, validator, retrieval, commands)
 * into the OpenClaw plugin API: tools, hooks, CLI, and service.
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { createDaedalusDb } from "./db.js";
import type { FactInput } from "./db.js";
import { validateFact, formatViolations } from "./validator.js";
import type { FactLookup } from "./validator.js";
import { formatRelevantMemoriesContext, formatSearchResultsForTool } from "./retrieval.js";
import { registerDaedalusMemoryCli } from "./commands.js";

// ============================================================================
// Config
// ============================================================================

interface DaedalusConfig {
  staleness_days: number;
  show_trust_tags: boolean;
  data_dir: string;
  autoCapture: boolean;
  autoRecall: boolean;
}

function parseConfig(raw: unknown): DaedalusConfig {
  const cfg =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  return {
    staleness_days: typeof cfg.staleness_days === "number" ? cfg.staleness_days : 7,
    show_trust_tags: typeof cfg.show_trust_tags === "boolean" ? cfg.show_trust_tags : true,
    data_dir: typeof cfg.data_dir === "string" ? cfg.data_dir : "daedalus-memory",
    autoCapture: cfg.autoCapture === true,
    autoRecall: cfg.autoRecall !== false,
  };
}

const daedalusConfigSchema = {
  parse(value: unknown): DaedalusConfig {
    return parseConfig(value);
  },
  uiHints: {
    staleness_days: {
      label: "Staleness Threshold (days)",
      placeholder: "7",
    },
    data_dir: {
      label: "Database Path",
      advanced: true,
    },
    autoCapture: {
      label: "Auto-Capture",
    },
    autoRecall: {
      label: "Auto-Recall",
    },
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      staleness_days: {
        type: "number",
        minimum: 1,
        default: 7,
        description: "Days before unvalidated (green) facts auto-expire to red",
      },
      show_trust_tags: {
        type: "boolean",
        default: true,
        description: "Include [VERIFIED]/[SUGGESTED] tags in agent context injection",
      },
      data_dir: {
        type: "string",
        description: "Custom path for facts.db (default: ~/.openclaw/daedalus/)",
      },
      autoCapture: {
        type: "boolean",
        default: false,
        description: "Automatically extract and store facts from conversations",
      },
      autoRecall: {
        type: "boolean",
        default: true,
        description: "Automatically inject relevant memories before each prompt build",
      },
    },
  },
};

// ============================================================================
// Plugin
// ============================================================================

const daedalusMemoryPlugin = {
  id: "daedalus-memory",
  name: "Memory (DAEDALUS)",
  description:
    "Trust-scored memory with tri-color provenance (blue/green/red). AI-suggested facts require human approval.",
  kind: "memory" as const,
  configSchema: daedalusConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    const resolvedPath = api.resolvePath(cfg.data_dir);
    const db = createDaedalusDb(resolvedPath);

    // ========================================================================
    // Tools
    // ========================================================================

    // -- memory_search -------------------------------------------------------

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search (DAEDALUS)",
        description:
          "Search long-term memory. Returns trust-tagged results: [VERIFIED] = human-approved, [SUGGESTED] = AI-proposed.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
        }),
        async execute(_toolCallId, params) {
          const { query, limit = 5 } = params as { query: string; limit?: number };
          const results = db.searchFacts(query, { limit });
          const text = formatSearchResultsForTool(results, query);
          return {
            content: [{ type: "text", text }],
            details: { count: results.length, query },
          };
        },
      },
      { name: "memory_search" },
    );

    // -- memory_store --------------------------------------------------------

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store (DAEDALUS)",
        description:
          "Store a fact in long-term memory. All AI-stored facts enter as [SUGGESTED] and require human approval to become [VERIFIED].",
        parameters: Type.Object({
          subject: Type.String({ description: "Who or what the fact is about" }),
          predicate: Type.String({
            description: "Relationship type (e.g. 'works_at', 'prefers')",
          }),
          object: Type.String({ description: "The value or target" }),
          fact_text: Type.String({
            description: "Human-readable statement of the fact",
          }),
        }),
        async execute(_toolCallId, rawParams) {
          const params = rawParams as {
            subject: string;
            predicate: string;
            object: string;
            fact_text: string;
          };

          // Build FactInput — agent calls ALWAYS produce green
          const input: FactInput = {
            subject: params.subject,
            predicate: params.predicate,
            object: params.object,
            fact_text: params.fact_text,
            origin: "ai_suggested" as const,
            source_agent: "openclaw",
          };

          // Validate before writing
          const factLookup: FactLookup = (s, p, o) => db.findExactTriple(s, p, o);
          const validation = validateFact(input, factLookup);
          if (!validation.valid) {
            const msg = formatViolations(validation.violations);
            return {
              content: [{ type: "text", text: `Validation failed:\n${msg}` }],
              details: { valid: false, violations: validation.violations },
            };
          }

          const fact = db.writeFact(input);
          return {
            content: [
              {
                type: "text",
                text: `Stored as [SUGGESTED] (id: ${fact.id}). Requires human approval via 'daedalus approve ${fact.id}' to become [VERIFIED].`,
              },
            ],
            details: { id: fact.id, trust_level: fact.trust_level },
          };
        },
      },
      { name: "memory_store" },
    );

    // -- memory_forget -------------------------------------------------------

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget (DAEDALUS)",
        description:
          "Quarantine a memory entry. Moves it to red (hidden from search). Does not permanently delete.",
        parameters: Type.Object({
          id: Type.String({ description: "Fact ID to forget" }),
        }),
        async execute(_toolCallId, rawParams) {
          const params = rawParams as { id: string };
          const existing = db.getFact(params.id);
          if (!existing) {
            return {
              content: [{ type: "text", text: `No fact found with id: ${params.id}` }],
              details: { id: params.id, found: false },
            };
          }
          if (existing.trust_level === "red") {
            return {
              content: [{ type: "text", text: `Fact ${params.id} is already quarantined.` }],
              details: { id: params.id, trust_level: "red", already: true },
            };
          }
          db.updateTrustLevel(params.id, "red", "human_reject", "agent");
          return {
            content: [
              {
                type: "text",
                text: `Fact ${params.id} moved to [QUARANTINED]. It will no longer appear in search results.`,
              },
            ],
            details: { id: params.id, trust_level: "red" },
          };
        },
      },
      { name: "memory_forget" },
    );

    // ========================================================================
    // Hooks
    // ========================================================================

    // -- Auto-Recall: before_prompt_build ------------------------------------

    if (cfg.autoRecall) {
      api.on("before_prompt_build", async (event) => {
        if (!event.prompt || event.prompt.length < 5) return;
        try {
          const results = db.searchFacts(event.prompt, { limit: 3 });
          if (results.length === 0) return;
          return {
            prependContext: formatRelevantMemoriesContext(results, cfg.show_trust_tags),
          };
        } catch (err) {
          api.logger.warn(`daedalus-memory: recall failed: ${String(err)}`);
        }
      });
    }

    // -- Auto-Capture: agent_end ---------------------------------------------

    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) return;
        try {
          let captured = 0;
          for (const msg of event.messages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;
            if (msgObj.role !== "user") continue;

            const content = msgObj.content;
            let text = "";
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              text = content
                .filter(
                  (b): b is Record<string, unknown> =>
                    !!b &&
                    typeof b === "object" &&
                    (b as Record<string, unknown>).type === "text",
                )
                .map((b) => b.text as string)
                .join(" ");
            }
            if (text.length < 20) continue;

            // Conservative heuristic: only capture messages with explicit memory intent signals
            const intentPatterns = [
              /\bremember\b/i,
              /\bdon'?t forget\b/i,
              /\bkeep in mind\b/i,
              /\bnote that\b/i,
              /\bfor (future|later) reference\b/i,
              /\bmy\s+(name|email|phone|address|preference|birthday)\b/i,
              /\bi (?:work|live|am|prefer|like|hate|use|need)\b/i,
            ];
            if (!intentPatterns.some((p) => p.test(text))) continue;

            const input: FactInput = {
              subject: "user",
              predicate: "stated",
              object: text.slice(0, 200),
              fact_text: text.slice(0, 500),
              origin: "ai_suggested" as const,
              source_agent: "openclaw",
              session_id: ctx.sessionId,
            };

            const factLookup: FactLookup = (s, p, o) => db.findExactTriple(s, p, o);
            const validation = validateFact(input, factLookup);
            if (validation.valid) {
              db.writeFact(input);
              captured++;
            }
          }
          if (captured > 0) {
            api.logger.info(
              `daedalus-memory: auto-captured ${captured} fact(s) from conversation`,
            );
          }
        } catch (err) {
          api.logger.warn(`daedalus-memory: auto-capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // CLI
    // ========================================================================

    api.registerCli(
      ({ program }) => registerDaedalusMemoryCli({ program, db, logger: api.logger }),
      { commands: ["daedalus"] },
    );

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "daedalus-memory",
      start: () => {
        api.logger.info(`daedalus-memory: initialized (db: ${resolvedPath})`);
      },
      stop: async () => {
        db.close();
        api.logger.info("daedalus-memory: stopped");
      },
    });
  },
};

export default daedalusMemoryPlugin;
