import type { PluginLogger, PluginRuntime } from "../api.js";
import type { TopicInfo } from "./topic-resolver.js";

/**
 * Minimal subagent surface this picker needs. Declared structurally (not as the
 * full PluginRuntime["subagent"]) so tests can mock it without the deprecated
 * methods, and so an older runtime missing deleteSession still type-checks.
 */
export type TopicPickerSubagent = Pick<
  PluginRuntime["subagent"],
  "run" | "waitForRun" | "getSessionMessages"
> &
  Partial<Pick<PluginRuntime["subagent"], "deleteSession">>;

export interface LlmTopicPickDeps {
  /** The user's natural-language report request (the requirement text). */
  requirement: string;
  /** The user's authorized topics — the model may ONLY pick from these. */
  topics: TopicInfo[];
  subagent: TopicPickerSubagent;
  /** Trusted userId; scopes the throwaway session (never from tool params). */
  userId: string;
  /** Uniqueness token (e.g. historyId) so concurrent picks never collide. */
  token: string | number;
  logger: PluginLogger;
  /** Wait budget for the classification run. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Keep the classifier on a tight leash: the per-user agent owns DB tools
 * (feed_query etc.), so we explicitly forbid tool use and demand bare JSON.
 */
const CLASSIFIER_SYSTEM_PROMPT =
  "你是一个监测项目匹配分类器。禁止调用任何工具、禁止查询数据库，" +
  "只输出题目要求的 JSON 对象，不要任何解释或代码块。";

/** Build the classification message: the candidate set plus the requirement. */
function buildMessage(requirement: string, candidates: TopicInfo[]): string {
  const list = candidates.map((t) => ({ topicId: t.topicId, topicName: t.topicName }));
  return [
    "用户想为【某一个】舆情监测项目生成报告。下面是该用户有权访问的项目列表，",
    "你只能从中选择，不得编造其它 id：",
    JSON.stringify(list),
    "",
    `用户请求：${JSON.stringify(requirement)}`,
    "",
    "请判断用户指的是哪一个项目。按语义匹配，支持简称与部分名称",
    "（例如“农行”=农业银行、“工行”=工商银行、“广本”=广汽本田）。",
    "若没有任何项目能明确对应，topicId 返回 null。",
    '只输出一个 JSON 对象：{"topicId": <项目id 或 null>}',
  ].join("\n");
}

/**
 * Extract plain text from a session message's content, which is a string in
 * simple sessions but an array of content blocks ([{type:"text", text}, ...])
 * in tool-using sessions. Mirrors report-generator's extractMessageText (each
 * extension is self-contained, so the small helper is duplicated by design).
 *
 * Handling the array form is essential: the classifier's "{topicId: N}" answer
 * arrives as content blocks, and reading only string content silently dropped
 * it — the picker then fell back to substring matching even though the model
 * had answered correctly.
 */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (block && typeof block === "object") {
          const b = block as { text?: unknown };
          if (typeof b.text === "string") {
            return b.text;
          }
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** The latest assistant turn's text, or null when there is none. */
function latestAssistantText(messages: unknown[]): string | null {
  for (const msg of [...messages].toReversed()) {
    const m = msg as { role?: string; content?: unknown };
    if (m.role === "assistant") {
      const text = extractMessageText(m.content).trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}

/**
 * Extract topicId from the model's reply. Scans for the last {...} block so
 * trailing prose or a code fence around the JSON does not break parsing. A
 * missing/non-numeric topicId (including the "unsure" null) yields null.
 */
function parseTopicId(messages: unknown[]): number | null {
  const text = latestAssistantText(messages);
  if (!text) {
    return null;
  }
  const blocks = text.match(/\{[^{}]*\}/g);
  if (!blocks) {
    return null;
  }
  try {
    const parsed = JSON.parse(blocks[blocks.length - 1]) as { topicId?: unknown };
    const id = parsed.topicId;
    return typeof id === "number" && Number.isFinite(id) ? Math.trunc(id) : null;
  } catch {
    return null;
  }
}

/**
 * Ask the model which authorized topic the requirement refers to. Returns the
 * matched TopicInfo, or null when the model is unsure / unavailable / picks an
 * unauthorized id — the caller then falls back to deterministic matching.
 *
 * The candidate set is the user's already-authorized topics, so the model can
 * never reach a project the user does not own: an out-of-set id is rejected.
 * The run is isolated (its own session key, deliver:false) and torn down after,
 * so it neither streams to the frontend nor pollutes the user's chat history.
 */
export async function pickTopicByLlm(deps: LlmTopicPickDeps): Promise<TopicInfo | null> {
  const { requirement, topics, subagent, userId, token, logger } = deps;
  const candidates = topics.filter((t) => t.topicName?.trim());
  // With 0-1 named candidates there is nothing to disambiguate.
  if (!requirement.trim() || candidates.length < 2) {
    return null;
  }

  const sessionKey = `agent:rabbitmq-${userId}:topic-pick:${userId}:${token}`;
  try {
    const { runId } = await subagent.run({
      sessionKey,
      message: buildMessage(requirement, candidates),
      extraSystemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      deliver: false,
      idempotencyKey: `topic-pick:${userId}:${token}`,
    });
    const wait = await subagent.waitForRun({
      runId,
      timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (wait.status !== "ok") {
      logger.warn(
        `[TOPIC_LLM] pick run ${wait.status} for user ${userId}; falling back to substring match`,
      );
      return null;
    }

    const { messages } = await subagent.getSessionMessages({ sessionKey, limit: 5 });
    const topicId = parseTopicId(messages);
    if (topicId === null) {
      return null;
    }
    const match = candidates.find((t) => t.topicId === topicId) ?? null;
    if (!match) {
      logger.warn(
        `[TOPIC_LLM] model returned unauthorized topicId=${topicId} for user ${userId}; ignoring`,
      );
    }
    return match;
  } catch (err) {
    logger.warn(`[TOPIC_LLM] pick failed for user ${userId}: ${String(err)}; falling back`);
    return null;
  } finally {
    // Best-effort cleanup; a leftover throwaway session is harmless.
    try {
      await subagent.deleteSession?.({ sessionKey, deleteTranscript: true });
    } catch {
      // ignore
    }
  }
}
