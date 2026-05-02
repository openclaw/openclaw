import crypto from "node:crypto";
import { parseModelRef, resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import type {
  AnyAgentTool,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { ResolvedStructuredMemoryConfig } from "./config";
import {
  getOrOpenDatabase,
  insertRecord,
  updateRecord,
  findRecords,
  findConflictingRecords,
  touchAccessTime,
  archiveRecord,
  recordExists,
  findRecordById,
} from "./db";
import { computeRelevance } from "./decay";
import { analyzeMessage } from "./perceptor";
import type { ClassificationResult, ClassificationError, MemoryRecord } from "./types";

const MemoryRecordAddSchema = Type.Object({
  id: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  summary: Type.String(),
  confidence: Type.Optional(Type.Number()),
  critical: Type.Optional(Type.Boolean()),
  activate_at: Type.Optional(Type.String()),
  expire_at: Type.Optional(Type.String()),
  keywords: Type.Optional(Type.String()),
  attributes: Type.Optional(Type.String()),
});

const MemoryRecordFindSchema = Type.Object({
  type: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  importance_min: Type.Optional(Type.Number()),
  confidence_min: Type.Optional(Type.Number()),
  keywords_contains: Type.Optional(Type.String()),
  text_contains: Type.Optional(Type.String()),
  max_results: Type.Optional(Type.Number()),
});

const MemoryRecordArchiveSchema = Type.Object({
  id: Type.String(),
  reason: Type.Optional(Type.String()),
});

const THINKING_MODEL_PATTERNS = /claude-opus|o1|o3|o4|deepseek-r1|thinking/i;

function resolveClassificationModel(params: {
  configModel?: string;
  agentId: string;
  config: OpenClawConfig;
}): { provider?: string; model?: string } {
  if (params.configModel && params.configModel.trim()) {
    const parsed = parseModelRef(params.configModel.trim(), "anthropic");
    if (parsed) {
      if (THINKING_MODEL_PATTERNS.test(parsed.model)) {
        // RFC §6.1.1: thinking/reasoning models are forbidden for classification
        // fall through to agent primary model instead
      } else {
        return { provider: parsed.provider, model: parsed.model };
      }
    }
  }
  const primaryRef = resolveDefaultModelForAgent({ cfg: params.config, agentId: params.agentId });
  if (primaryRef && !THINKING_MODEL_PATTERNS.test(primaryRef.model)) {
    return { provider: primaryRef.provider, model: primaryRef.model };
  }
  return {};
}

function buildClassificationPrompt(rawText: string): string {
  return `You are a memory classification assistant. Analyze the following text and classify it into a structured memory record.

Classify into ONE of these types:
- entity: A person, organization, object, or named thing
- event: Something that happened at a point in time
- fact: A factual statement or piece of knowledge
- rule: A conditional rule or constraint
- impression: A subjective opinion, feeling, or assessment
- plan: A future intention, goal, or plan
- reflex: An automatic behavior, habit, or instinctive response
- preference: A stated like, dislike, or preference

Assign an importance score (1-10) where:
10 = Critical, must remember (identity, core goals, safety rules)
7-9 = Very important (key preferences, recurring patterns)
4-6 = Moderately important (contextual details)
1-3 = Minor (trivia, passing remarks)

Assign a confidence score (0.0-1.0) based on how clearly the text conveys this information.

Also refine the summary to be concise (100 chars or fewer) and extract key space-separated lowercase keywords.

Respond ONLY with a valid JSON object with these fields:
{
  "type": "<one of: entity, event, fact, rule, impression, plan, reflex, preference>",
  "importance": <integer 1-10>,
  "confidence": <number 0.0-1.0>,
  "summary_refined": "<concise summary, 100 chars max>",
  "keywords": "<space-separated lowercase keywords>"
}

Text to classify:
${rawText}`;
}

export function parseClassificationResponse(raw: string): ClassificationResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let jsonStr = trimmed;
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (
      !parsed.type ||
      !parsed.summary_refined ||
      typeof parsed.importance !== "number" ||
      typeof parsed.confidence !== "number"
    ) {
      return null;
    }

    const validTypes = [
      "entity",
      "event",
      "fact",
      "rule",
      "impression",
      "plan",
      "reflex",
      "preference",
    ];
    if (!validTypes.includes(parsed.type)) return null;

    return {
      type: parsed.type,
      importance: Math.max(1, Math.min(10, Math.round(parsed.importance))),
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
      summary_refined: String(parsed.summary_refined).slice(0, 100),
      keywords: String(parsed.keywords ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    };
  } catch {
    return null;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

// RFC §6.2: pure-rule fallback classifier — no LLM call, <1ms
export function runRuleBasedClassification(rawText: string): ClassificationResult | null {
  // Correction / negation patterns (RFC: confidence 0.90)
  if (/不对|上次说的不对|不是.{1,4}是|说错了|记错了|纠正/.test(rawText)) {
    return {
      type: "fact" as ClassificationResult["type"],
      importance: 7,
      confidence: 0.9,
      summary_refined: rawText.slice(0, 100),
      keywords: rawText
        .replace(/[^a-z0-9一-鿿]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    };
  }

  // Rule / constraint patterns (RFC: confidence 0.90)
  if (/必须|禁止|不得|不允许|一定要|决不能|千万别|不准|严禁|务必|只能|不可以/.test(rawText)) {
    return {
      type: "rule" as ClassificationResult["type"],
      importance: 8,
      confidence: 0.9,
      summary_refined: rawText.slice(0, 100),
      keywords: rawText
        .replace(/[^a-z0-9一-鿿]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    };
  }

  // Preference patterns (RFC: confidence 0.85)
  if (/不喜欢|更倾向|最好用|更喜欢|更爱|更想|讨厌|受不了|宁愿|倾向|最爱|偏好|宁可/.test(rawText)) {
    return {
      type: "preference" as ClassificationResult["type"],
      importance: 6,
      confidence: 0.85,
      summary_refined: rawText.slice(0, 100),
      keywords: rawText
        .replace(/[^a-z0-9一-鿿]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    };
  }

  return null;
}

async function runClassification(params: {
  api: OpenClawPluginApi;
  config: ResolvedStructuredMemoryConfig;
  agentId: string;
  sessionKey: string;
  rawText: string;
  resolvedModel: { provider?: string; model?: string };
}): Promise<{ result: ClassificationResult } | { error: ClassificationError }> {
  const subagentSessionId = `structured-mem-classify-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const subagentSessionKey = `${params.sessionKey}:structured-memory:classify:${crypto.randomUUID().slice(0, 8)}`;
  const prompt = buildClassificationPrompt(params.rawText);

  try {
    const result = await params.api.runtime.agent.runEmbeddedPiAgent({
      sessionId: subagentSessionId,
      sessionKey: subagentSessionKey,
      agentId: params.agentId,
      prompt,
      provider: params.resolvedModel.provider,
      model: params.resolvedModel.model,
      timeoutMs: params.config.classification.timeoutMs,
      runId: subagentSessionId,
      trigger: "manual",
      toolsAllow: [],
      disableMessageTool: true,
      bootstrapContextMode: "lightweight",
      silentExpected: true,
      verboseLevel: "off",
      thinkLevel: "off",
      reasoningLevel: "off",
      cleanupBundleMcpOnRunEnd: true,
    });

    const rawReply = (result.payloads ?? [])
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();

    const classification = parseClassificationResponse(rawReply);
    if (!classification) {
      return {
        error: { code: "PARSE_FAILURE", message: "Failed to parse classification response." },
      };
    }
    return { result: classification };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAbortError(err)) {
      return { error: { code: "TIMEOUT", message } };
    }
    if (message.includes("429") || message.includes("rate") || message.includes("quota")) {
      return { error: { code: "RATE_LIMITED", message } };
    }
    return { error: { code: "MODEL_UNAVAILABLE", message } };
  }
}

export function createMemoryRecordAddTool(
  config: ResolvedStructuredMemoryConfig,
  api: OpenClawPluginApi,
): (ctx: OpenClawPluginToolContext) => AnyAgentTool {
  return (ctx) => {
    const agentId = ctx.agentId ?? "main";
    const sessionKey = ctx.sessionKey ?? `agent:${agentId}:default`;

    return {
      name: "memory_record_add",
      label: "memory_record_add",
      description:
        "Add or update a structured typed memory record. If an id is provided and exists, the existing record is merged. Otherwise a new record is created. The record is automatically classified by type, importance, and confidence using an embedded agent turn.",
      parameters: MemoryRecordAddSchema,
      execute: async (_toolCallId, toolParams) => {
        const params = toolParams as Record<string, unknown>;
        const summary = String(params.summary ?? "").trim();
        if (!summary) {
          return {
            content: [{ type: "text" as const, text: "Error: summary is required." }],
            details: { ok: false },
          };
        }

        const configSnapshot = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
        if (!configSnapshot) {
          return {
            content: [{ type: "text" as const, text: "Error: no configuration available." }],
            details: { ok: false },
          };
        }

        const providedId = String(params.id ?? "").trim() || undefined;
        const db = getOrOpenDatabase(agentId);

        const existingRecord = providedId ? findRecordById(db, providedId) : null;
        const isUpdate = existingRecord !== null;

        const resolvedModel = resolveClassificationModel({
          configModel: config.classification.model,
          agentId,
          config: configSnapshot,
        });

        // RFC §5: Perceptor high-confidence signal → skip LLM classification
        const perceptorResult = analyzeMessage(summary);
        let classification: ClassificationResult;

        if (perceptorResult.signal && perceptorResult.signal.confidence >= 0.8) {
          const s = perceptorResult.signal;
          classification = {
            type: s.type,
            importance: s.importance,
            confidence: s.confidence,
            summary_refined: summary.slice(0, 100),
            keywords: s.keywords.join(" "),
          };
        } else {
          const classificationResp = await runClassification({
            api,
            config,
            agentId,
            sessionKey,
            rawText: summary,
            resolvedModel,
          });

          if ("error" in classificationResp) {
            const ruleResult = runRuleBasedClassification(summary);
            if (ruleResult) {
              classification = ruleResult;
            } else {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Classification failed: [${classificationResp.error.code}] ${classificationResp.error.message}`,
                  },
                ],
                details: { ok: false, error: classificationResp.error },
              };
            }
          } else {
            classification = classificationResp.result;
          }
        }

        const userType =
          typeof params.type === "string" && params.type.trim()
            ? params.type.trim()
            : classification.type;
        const keywords = String(params.keywords ?? classification.keywords)
          .toLowerCase()
          .replace(/[^a-z0-9一-鿿\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        let allowCoexistence: 0 | 1 = 0;
        let contradictionFlag: 0 | 1 = 0;
        if (userType) {
          const conflicting = findConflictingRecords(
            db,
            userType as MemoryRecord["type"],
            keywords,
            agentId,
          );
          if (conflicting.length > 0) {
            contradictionFlag = 1;
            // check if any conflicting record allows coexistence
            if (conflicting.some((r) => r.allow_coexistence === 1)) {
              allowCoexistence = 1;
            }
          }
        }

        const rawConfidence =
          typeof params.confidence === "number" ? params.confidence : classification.confidence;
        const finalConfidence =
          contradictionFlag && !allowCoexistence ? Math.min(rawConfidence, 0.5) : rawConfidence;

        if (isUpdate && providedId) {
          const success = updateRecord(db, providedId, {
            summary: classification.summary_refined,
            confidence: finalConfidence,
            importance: classification.importance,
            keywords,
            content: summary,
            attributes: typeof params.attributes === "string" ? params.attributes : undefined,
            expire_at: typeof params.expire_at === "string" ? params.expire_at : undefined,
            activate_at: typeof params.activate_at === "string" ? params.activate_at : undefined,
            critical: params.critical === true ? 1 : 0,
            status: "active",
            allow_coexistence: allowCoexistence,
          });

          if (!success) {
            return {
              content: [
                { type: "text" as const, text: `Error: failed to update record ${providedId}.` },
              ],
              details: { ok: false },
            };
          }

          // RFC: increment consolidation count on each user-driven update
          db.prepare(
            "UPDATE memory_records SET consolidation_count = consolidation_count + 1 WHERE id = ?",
          ).run(providedId);

          const action =
            existingRecord.status === "archived" ? "re-activated and updated" : "updated";
          return {
            content: [
              {
                type: "text" as const,
                text: `Memory record ${providedId} ${action} (type: ${userType}, importance: ${classification.importance}, confidence: ${finalConfidence.toFixed(2)})${contradictionFlag ? " — possible contradiction detected" : ""}`,
              },
            ],
            details: {
              ok: true,
              id: providedId,
              type: userType,
              importance: classification.importance,
              confidence: finalConfidence,
              contradiction_flag: contradictionFlag,
              action: "updated",
            },
          };
        }

        const recordId = insertRecord(db, {
          id: providedId,
          type: userType,
          summary: classification.summary_refined,
          confidence: finalConfidence,
          importance: classification.importance,
          expire_at: typeof params.expire_at === "string" ? params.expire_at : null,
          activate_at: typeof params.activate_at === "string" ? params.activate_at : null,
          critical: params.critical === true ? 1 : 0,
          keywords,
          agent_id: agentId,
          allow_coexistence: allowCoexistence,
          source_session_id: sessionKey,
          content: summary,
          attributes: typeof params.attributes === "string" ? params.attributes : "{}",
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Memory record ${recordId} added (type: ${userType}, importance: ${classification.importance}, confidence: ${finalConfidence.toFixed(2)})${contradictionFlag ? " — possible contradiction detected" : ""}`,
            },
          ],
          details: {
            ok: true,
            id: recordId,
            type: userType,
            importance: classification.importance,
            confidence: finalConfidence,
            contradiction_flag: contradictionFlag,
            action: "created",
          },
        };
      },
    };
  };
}

export function createMemoryRecordFindTool(
  config: ResolvedStructuredMemoryConfig,
): (ctx: OpenClawPluginToolContext) => AnyAgentTool {
  return (ctx) => {
    const agentId = ctx.agentId ?? "main";

    return {
      name: "memory_record_find",
      label: "memory_record_find",
      description:
        "Search structured memory records by type, importance, confidence, keywords, or text content. Results are sorted by relevance with time-based decay applied.",
      parameters: MemoryRecordFindSchema,
      execute: async (_toolCallId, toolParams) => {
        const params = toolParams as Record<string, unknown>;
        const db = getOrOpenDatabase(agentId);

        const filters = {
          type:
            typeof params.type === "string" && params.type.trim()
              ? [params.type.trim()]
              : undefined,
          status:
            typeof params.status === "string" && params.status.trim()
              ? params.status.trim()
              : "active",
          importance_min:
            typeof params.importance_min === "number" ? params.importance_min : undefined,
          confidence_min:
            typeof params.confidence_min === "number" ? params.confidence_min : undefined,
          keywords_contains:
            typeof params.keywords_contains === "string" ? params.keywords_contains : undefined,
          text_contains:
            typeof params.text_contains === "string" ? params.text_contains : undefined,
          max_results:
            typeof params.max_results === "number" && params.max_results > 0
              ? params.max_results
              : config.recall.maxResults,
        };

        const rawRecords = findRecords(db, filters);

        const results = rawRecords.map((record) => ({
          record,
          relevance: computeRelevance(record, { decay: config.decay }),
        }));

        results.sort((a, b) => b.relevance.relevance - a.relevance.relevance);
        const truncated = results.slice(0, filters.max_results ?? 15);

        const resultIds = truncated.map((r) => r.record.id);
        touchAccessTime(db, resultIds);

        if (truncated.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No matching records found." }],
            details: { ok: true, count: 0, results: [] },
          };
        }

        const lines = truncated.map(
          (r, i) =>
            `${i + 1}. [${r.record.type}] ${r.record.summary} (importance: ${r.record.importance}, relevance: ${r.relevance.relevance.toFixed(3)}, id: ${r.record.id})`,
        );

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            ok: true,
            count: truncated.length,
            results: truncated.map((r) => ({
              id: r.record.id,
              type: r.record.type,
              summary: r.record.summary,
              importance: r.record.importance,
              confidence: r.record.confidence,
              relevance: r.relevance.relevance,
              created_at: r.record.created_at,
              updated_at: r.record.updated_at,
            })),
          },
        };
      },
    };
  };
}

export function createMemoryRecordArchiveTool(
  _config: ResolvedStructuredMemoryConfig,
): (ctx: OpenClawPluginToolContext) => AnyAgentTool {
  return (ctx) => {
    const agentId = ctx.agentId ?? "main";

    return {
      name: "memory_record_archive",
      label: "memory_record_archive",
      description:
        "Archive a structured memory record by its ID. Archived records are excluded from search results but are retained in the database.",
      parameters: MemoryRecordArchiveSchema,
      execute: async (_toolCallId, toolParams) => {
        const params = toolParams as Record<string, unknown>;
        const id = String(params.id ?? "").trim();
        if (!id) {
          return {
            content: [{ type: "text" as const, text: "Error: id is required." }],
            details: { ok: false },
          };
        }

        const db = getOrOpenDatabase(agentId);

        if (!recordExists(db, id)) {
          return {
            content: [{ type: "text" as const, text: `Error: record ${id} not found.` }],
            details: { ok: false },
          };
        }

        const reason =
          typeof params.reason === "string" && params.reason.trim()
            ? params.reason.trim()
            : "user_request";
        archiveRecord(db, id, reason);

        return {
          content: [{ type: "text" as const, text: `Record ${id} archived (reason: ${reason}).` }],
          details: { ok: true, id, reason },
        };
      },
    };
  };
}
