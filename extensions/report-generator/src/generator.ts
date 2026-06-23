import type { PluginRuntime } from "../api.js";
import type { PluginLogger } from "../api.js";
import { buildStatsDigest, computeDailyAverage } from "./data-digest.js";
import {
  buildPlanPrompt,
  DEFAULT_QUERY_PLAN,
  extractQueryPlan,
  type CollectedStats,
  type QueryPlan,
} from "./query-plan.js";
import { ToolActivityNarrator, type ActivityStep, type StepCategory } from "./tool-activity.js";
import type { GeneratedReport, ReportPeriod } from "./types.js";

interface GenerateOptions {
  period: ReportPeriod;
  requirement: string;
  dateScope: string;
  /**
   * Executes a validated QueryPlan against the database (injected by the
   * caller — FeedCollector.collectStats). Generation never touches the DB
   * directly; the LLM only proposes the plan.
   */
  collectStats: (plan: QueryPlan) => Promise<CollectedStats>;
  template: string;
  userId: string;
  /** Topic the report covers (download.topicId). */
  topicId: number;
  /** Slave topic id when the task uses slave-topic matching (0 otherwise). */
  slaveTopicId: number;
  /**
   * Per-user agent to run the generation under (e.g. "rabbitmq-1749") so the
   * report inherits that agent's workspace persona and templates. The agent
   * has no database access — all report data arrives pre-queried in the
   * prompt. Falls back to the default agent when absent (legacy tasks).
   */
  agentId?: string;
  /** Called with each LLM text delta for real-time streaming to the frontend. */
  onDelta?: (delta: string) => void;
  /**
   * Called with sanitized activity status lines while the agent runs tools
   * (tool phases produce no text deltas — without these the frontend sees a
   * dead stream). Messages carry only generic labels; tool args (paths,
   * credentials) never reach this callback.
   */
  onActivity?: (message: string) => void;
  /**
   * Called with structured timeline steps (start/end) for the frontend's
   * collapsible "工作过程" panel on the report card. The report-writing run
   * bans tools, so progress is milestone-based (template analysis → stats →
   * writing); steps carry only sanitized labels/categories, never raw data.
   */
  onStep?: (step: ActivityStep) => void;
}

/**
 * The report-writing run needs no tools: every number it may cite is
 * pre-queried and embedded in the prompt. Tool phases (file writes, docx
 * conversion attempts) emit no text deltas — they starve the frontend stream
 * and routinely blow the run deadline (Task #13624) — so ban them outright.
 */
const PURE_WRITING_SYSTEM_PROMPT = [
  "本次运行是纯写作任务：报告所需的全部数据已在用户消息中提供。",
  "禁止调用任何工具（exec、read、write、edit、file_share、feed_query 等一律不得使用）。",
  "禁止读写任何文件，禁止生成或转换 Word/PDF 等附件文件。",
  "直接以文本输出完整的 Markdown 报告正文，从标题行（# 开头）开始。",
].join("\n");

/** Query planning only emits a JSON plan — equally tool-free. */
const PURE_PLANNING_SYSTEM_PROMPT =
  "本次运行是纯文本任务：直接输出 JSON 查询计划，禁止调用任何工具、禁止读写文件。";

/** Minimum salvageable report length after a run timeout (chars). */
const MIN_SALVAGE_LENGTH = 200;

/**
 * Salvage a report from streamed deltas after a run timeout: the body often
 * finishes streaming long before the run ends (the agent may linger on
 * follow-up chores). Returns the text from the first markdown heading onward
 * when it looks substantive, "" otherwise (treated as a real timeout).
 */
export function salvageStreamedReport(streamedText: string): string {
  const text = streamedText.trim();
  const headingIndex = text.search(/^#{1,6}\s/m);
  if (headingIndex < 0) {
    return "";
  }
  const report = text.slice(headingIndex).trim();
  return report.length >= MIN_SALVAGE_LENGTH ? report : "";
}

function extractAssistantDelta(data: Record<string, unknown>): string {
  const delta = data.delta;
  const text = data.text;
  if (typeof delta === "string") {
    return delta;
  }
  if (typeof text === "string") {
    return text;
  }
  return "";
}

/**
 * Extract plain text from a session message's content, which is a string in
 * simple sessions but an array of content blocks ([{type:"text", text}, ...])
 * in tool-using (autonomous) sessions.
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
          const b = block as { type?: unknown; text?: unknown };
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

export class ReportGenerator {
  private readonly runtime: PluginRuntime;

  constructor(runtime: PluginRuntime) {
    this.runtime = runtime;
  }

  /**
   * Generate a report: LLM plans the queries from the template, code
   * validates and executes them (full-set SQL aggregation), then the LLM
   * writes the report from the real results.
   */
  async generate(options: GenerateOptions, logger: PluginLogger): Promise<GeneratedReport> {
    const {
      period,
      requirement,
      dateScope,
      collectStats,
      template,
      userId,
      agentId,
      onDelta,
      onActivity,
      onStep,
    } = options;

    logger.info(`[REPORT_GENERATOR] Generating ${period} report for requirement: ${requirement}`);

    // Milestone step emitter for the frontend "工作过程" timeline. The writing
    // run bans tools, so steps come from these phase milestones rather than
    // tool events. Each carries only a sanitized label/category.
    let stepSeq = 0;
    const beginStep = (label: string, category: StepCategory) => {
      stepSeq += 1;
      const stepId = `report-${stepSeq}`;
      const index = stepSeq;
      const startedAt = Date.now();
      onStep?.({ phase: "start", stepId, index, label, category, status: "running" });
      return (status: "completed" | "failed") =>
        onStep?.({
          phase: "end",
          stepId,
          index,
          label,
          category,
          status,
          durationMs: Math.max(0, Date.now() - startedAt),
        });
    };

    // Step 1: LLM reads the template and proposes WHAT to aggregate
    // (validated against whitelists; falls back to the default plan).
    onActivity?.("正在分析模板数据需求…");
    const endPlanStep = beginStep("正在分析模板数据需求", "read");
    const plan = await this.planQueries(template, userId, logger);
    endPlanStep("completed");

    // Step 2: code executes the plan — full-set SQL aggregation, real rows.
    onActivity?.("正在统计舆情数据…");
    const endStatsStep = beginStep("正在统计舆情数据", "query");
    const stats = await collectStats(plan);
    endStatsStep("completed");
    const dataDigest = buildStatsDigest(stats);
    const totalCount = stats.total;

    // Run under the requesting user's agent when known so the report keeps
    // the same workspace persona and templates as the chat session.
    const sessionKey = agentId
      ? `agent:${agentId}:report-gen:${userId}:${Date.now()}`
      : `report-gen:${userId}:${Date.now()}`;

    // Sanitized tool-activity narration: tool phases emit no assistant
    // deltas, leaving the frontend stream dead. Tool starts surface as
    // generic status lines (tool name only — args never leak).
    const narrator = onActivity ? new ToolActivityNarrator({ push: onActivity }) : null;

    // Stream LLM text deltas to the caller and accumulate them as a fallback
    // source for the final report text. Events are filtered by sessionKey
    // (the agent runtime attaches it to every event of this run), so parallel
    // chat sessions never bleed into the report stream.
    let streamedText = "";
    const unsubscribe = this.runtime.events.onAgentEvent((evt) => {
      if (evt.sessionKey !== sessionKey) {
        return;
      }
      if (evt.stream === "tool") {
        narrator?.handleAgentEvent(evt);
        return;
      }
      if (evt.stream !== "assistant") {
        return;
      }
      const delta = extractAssistantDelta(evt.data);
      if (delta) {
        streamedText += delta;
        onDelta?.(delta);
      }
    });

    // Step 3: the LLM writes the report from the pre-queried digest.
    const endWriteStep = beginStep("正在撰写报告", "write");
    try {
      const reportPrompt = this.buildReportPrompt({
        period,
        requirement,
        dateScope,
        totalCount,
        dataDigest,
        template,
        topicId: options.topicId,
        slaveTopicId: options.slaveTopicId,
      });

      const runResult = await this.runtime.subagent.run({
        sessionKey,
        message: reportPrompt,
        deliver: false,
        extraSystemPrompt: PURE_WRITING_SYSTEM_PROMPT,
      });

      const waitResult = await this.runtime.subagent.waitForRun({
        runId: runResult.runId,
        // Per-user agents may run tools (template/workspace reads); allow more time.
        timeoutMs: agentId ? 300_000 : 120_000,
      });

      if (waitResult.status === "error") {
        throw new Error(waitResult.error ?? "Report generation failed");
      }

      let generatedText = "";
      if (waitResult.status === "timeout") {
        // A timeout with a complete-looking streamed report is a delivery,
        // not a failure: salvage it instead of discarding the whole task.
        generatedText = salvageStreamedReport(streamedText);
        if (!generatedText) {
          throw new Error("Report generation timed out");
        }
        logger.warn(
          "[REPORT_GENERATOR] Run timed out after streaming a report body; salvaging streamed text",
        );
      } else {
        // Get the generated report from session messages
        // Autonomous sessions interleave tool calls/results with assistant
        // messages, so fetch a wider tail than the simple-session default.
        const sessionMessages = await this.runtime.subagent.getSessionMessages({
          sessionKey,
          limit: 20,
        });

        // Collect every non-empty assistant message text. In autonomous mode the
        // model often appends a short closing remark ("报告已生成，请查收") as a
        // separate, NEWER assistant message after the report, so "newest" is the
        // wrong pick — the report is the substantive body, not the chatter.
        const assistantTexts: string[] = [];
        if (sessionMessages.messages && Array.isArray(sessionMessages.messages)) {
          for (const msg of sessionMessages.messages.toReversed()) {
            const m = msg as { role?: string; content?: unknown };
            if (m.role !== "assistant") {
              continue;
            }
            const text = extractMessageText(m.content).trim();
            if (text) {
              assistantTexts.push(text);
            }
          }
        }

        // Pick the longest message that carries a markdown heading of ANY level
        // (`#`..`######`) — older logic required a top-level `# ` and silently
        // fell back to the closing remark when the report opened with `## `.
        // The report dwarfs any remark in length, so longest-with-heading is a
        // robust selector; degrade to the longest assistant text, then to the
        // streamed text.
        const byLengthDesc = (a: string, b: string) => b.length - a.length;
        const withHeading = assistantTexts.filter((t) => /^#{1,6}\s/m.test(t));
        generatedText =
          withHeading.toSorted(byLengthDesc)[0] ?? assistantTexts.toSorted(byLengthDesc)[0] ?? "";

        // Fallback: use the streamed text we collected ourselves, trimmed to the
        // last heading so working narration ("先查询数据库…") that precedes the
        // report body is dropped.
        if (!generatedText && streamedText.trim()) {
          const headings = [...streamedText.matchAll(/^#{1,6}\s/gm)];
          const lastHeading = headings.length > 0 ? headings[headings.length - 1].index : -1;
          generatedText = lastHeading >= 0 ? streamedText.slice(lastHeading) : streamedText;
          logger.warn(
            "[REPORT_GENERATOR] Session messages yielded no text; falling back to streamed text",
          );
        }
      }

      if (!generatedText) {
        throw new Error("No report content generated");
      }

      // Extract title from first heading (any level)
      const titleMatch = generatedText.match(/^#{1,6}\s+(.+)/m);
      const title = titleMatch ? titleMatch[1].trim() : `${period}舆情报告`;

      logger.info(`[REPORT_GENERATOR] Generated report: ${title}`);

      endWriteStep("completed");
      return {
        title,
        content: generatedText,
        summary: this.extractSummary(generatedText),
      };
    } catch (error) {
      logger.error(`[REPORT_GENERATOR] Generation failed: ${String(error)}`);
      endWriteStep("failed");
      throw error;
    } finally {
      unsubscribe();
    }
  }

  /**
   * Ask the LLM to read the template and emit a JSON QueryPlan. Any failure
   * (timeout, unparseable output, hallucinated dimensions) degrades to
   * DEFAULT_QUERY_PLAN — planning can improve a report, never break one.
   */
  private async planQueries(
    template: string,
    userId: string,
    logger: PluginLogger,
  ): Promise<QueryPlan> {
    const sessionKey = `report-plan:${userId}:${Date.now()}`;
    try {
      const runResult = await this.runtime.subagent.run({
        sessionKey,
        message: buildPlanPrompt(template),
        deliver: false,
        extraSystemPrompt: PURE_PLANNING_SYSTEM_PROMPT,
      });
      const waitResult = await this.runtime.subagent.waitForRun({
        runId: runResult.runId,
        timeoutMs: 60_000,
      });
      if (waitResult.status !== "ok") {
        throw new Error(`plan run ended with status ${waitResult.status}`);
      }
      const sessionMessages = await this.runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 5,
      });
      for (const msg of (sessionMessages.messages ?? []).toReversed()) {
        const m = msg as { role?: string; content?: unknown };
        if (m.role !== "assistant") {
          continue;
        }
        const plan = extractQueryPlan(extractMessageText(m.content));
        if (plan) {
          logger.info(`[REPORT_GENERATOR] Query plan: ${JSON.stringify(plan)}`);
          return plan;
        }
      }
      throw new Error("no parseable query plan in assistant reply");
    } catch (error) {
      logger.warn(`[REPORT_GENERATOR] Query planning failed, using default plan: ${String(error)}`);
      return DEFAULT_QUERY_PLAN;
    }
  }

  private buildReportPrompt(data: {
    period: ReportPeriod;
    requirement: string;
    dateScope: string;
    totalCount: number;
    dataDigest: string;
    template: string;
    topicId: number;
    slaveTopicId: number;
  }): string {
    const topicFilter =
      data.slaveTopicId > 0
        ? `slaveTopicId = ${data.slaveTopicId}（本专题使用从属专题匹配；主 topicId = ${data.topicId}）`
        : `topicId = ${data.topicId}`;

    // Template placeholders like {totalCount}/{dailyAvg} get exact
    // code-computed values here, so the model copies numbers instead of
    // doing arithmetic.
    const daily = computeDailyAverage(data.dateScope, data.totalCount);
    const dailyAvgLine = daily
      ? `\n- 日均数据量（dailyAvg）：${daily.dailyAvg} 条/天（统计范围 ${daily.days} 天）`
      : "";

    return `你是一个专业的舆情分析报告生成助手。

用户需求：${data.requirement}

请生成一份${data.period}舆情报告。

## 任务参数（模板变量直接取用以下数值）
- 专题过滤条件：${topicFilter}
- 统计时间范围（dateScope）：${data.dateScope}
- 数据总量（totalCount）：${data.totalCount} 条${dailyAvgLine}

## 舆情数据（数据库真实查询结果，已按专题与时间过滤、排除 skip=1）
${data.dataDigest}

## 数据使用规则（必须遵守）
- 以上就是本报告的全部数据来源，统计数字必须与"统计概览"完全一致
- **严禁编造、推测或补充任何数据**（包括条目、数字、日期、平台、作者）
- 不要尝试查询数据库——数据已经查好并完整提供在上方
- 如果某项模板内容没有对应数据，如实标注"暂无数据"

## 报告模板
${data.template}

严格按照模板格式生成报告，用上方真实数据替换模板中的占位符，不要省略任何部分。

报告语言：中文
报告格式：Markdown

最后一条回复必须是完整的报告正文（以 # 标题开头），不要附加多余的说明文字。`;
  }

  private extractSummary(content: string): string {
    // Extract first 200 chars as summary
    const clean = content.replace(/^#.*$/gm, "").replace(/\n+/g, " ").trim();
    return clean.slice(0, 200) + (clean.length > 200 ? "..." : "");
  }
}
