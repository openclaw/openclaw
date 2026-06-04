import type { PluginRuntime } from "../api.js";
import type { PluginLogger } from "../api.js";
import type { FeedRecord, GeneratedReport, ReportPeriod } from "./types.js";

interface GenerateOptions {
  period: ReportPeriod;
  requirement: string;
  dateScope: string;
  feedData: FeedRecord[];
  template: string;
  userId: string;
  /** Topic the report covers (download.topicId; 328-349 means slave-topic matching). */
  topicId: number;
  /** Original topic id when the task uses slave-topic matching (0 otherwise). */
  slaveTopicId: number;
  /**
   * Per-user agent to run the generation under (e.g. "rabbitmq-1749").
   * The subagent then inherits that agent's workspace, DB skills, and schema
   * knowledge so it can query the database autonomously. Falls back to the
   * default agent when absent (legacy tasks).
   */
  agentId?: string;
  /** Called with each LLM text delta for real-time streaming to the frontend. */
  onDelta?: (delta: string) => void;
}

/**
 * Condensed schema of the feed tables, distilled from
 * extensions/feed-search/src/feed_monitor_item.sql and
 * feed_monitor_item_data.sql, injected into the autonomous prompt so the
 * agent writes correct SQL without guessing column names.
 */
const FEED_TABLE_SCHEMA = `### feed_monitor_item（舆情条目主表，主键 id）
- topicId / slaveTopicId：专题归属（mediumint；从属专题模式按 slaveTopicId 过滤）
- date：发布时间（datetime，有索引）；updateDate：更新时间
- platform：平台名（varchar）；platformType / originType：平台与来源类型
- contentType：enum('Article','Video','Comment')
- emotion：情感 enum('Positive','Neutral','Negative')
- level：风险级别 enum('Red','Orange','Yellow','Blue')（Red 最高）
- mediaLevel：媒体级别 enum('Central','Local','Government','Institute','Enterprise','Other')
- fansNumber 粉丝量 / readCount 阅读量 / comments 评论量 / forwardNumber 转发量 / praiseNum 点赞量 / topicInteractionCount 互动量
- author 作者 / city 城市 / link 原文链接 / official 是否官方 / original 是否原创
- skip：tinyint，=1 表示已忽略，**统计必须加 WHERE skip = 0**
- duplicated：是否重复条目

### feed_monitor_item_data（内容详情表，与主表 1:1，主键 id = feed_monitor_item.id）
- title / titleClean：标题；content：正文；summary：摘要
- keywords / keySentences / label：关键词、关键句、标签
- author / reporter
- 全文索引 ft_search_index(title, author, summary, content)

联表方式：FROM feed_monitor_item f JOIN feed_monitor_item_data d ON d.id = f.id`;

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
   * Generate a report using subagent with LLM based on feed data and template.
   */
  async generate(options: GenerateOptions, logger: PluginLogger): Promise<GeneratedReport> {
    const { period, requirement, dateScope, feedData, template, userId, agentId, onDelta } =
      options;

    // Prepare feed data summary for prompt
    const dataSummary = this.prepareDataSummary(feedData);
    const platforms = [...new Set(feedData.map((r) => r.platform))].join("、");
    const totalCount = feedData.length;

    logger.info(`[REPORT_GENERATOR] Generating ${period} report for requirement: ${requirement}`);

    // Run under the requesting user's agent when known so the subagent has the
    // same workspace skills (DB schema + query scripts) as the chat session.
    const sessionKey = agentId
      ? `agent:${agentId}:report-gen:${userId}:${Date.now()}`
      : `report-gen:${userId}:${Date.now()}`;

    // Stream LLM text deltas to the caller and accumulate them as a fallback
    // source for the final report text. Events are filtered by sessionKey
    // (the agent runtime attaches it to every event of this run), so parallel
    // chat sessions never bleed into the report stream.
    let streamedText = "";
    const unsubscribe = this.runtime.events.onAgentEvent((evt) => {
      if (evt.stream !== "assistant" || evt.sessionKey !== sessionKey) {
        return;
      }
      const delta = extractAssistantDelta(evt.data);
      if (delta) {
        streamedText += delta;
        onDelta?.(delta);
      }
    });

    try {
      const reportPrompt = this.buildReportPrompt({
        period,
        requirement,
        dateScope,
        totalCount,
        platforms,
        dataSummary,
        template,
        topicId: options.topicId,
        slaveTopicId: options.slaveTopicId,
        autonomous: Boolean(agentId),
      });

      const runResult = await this.runtime.subagent.run({
        sessionKey,
        message: reportPrompt,
        deliver: false,
      });

      const waitResult = await this.runtime.subagent.waitForRun({
        runId: runResult.runId,
        // Autonomous mode runs multi-turn SQL tool calls; allow more time.
        timeoutMs: agentId ? 300_000 : 120_000,
      });

      if (waitResult.status === "error") {
        throw new Error(waitResult.error ?? "Report generation failed");
      }

      if (waitResult.status === "timeout") {
        throw new Error("Report generation timed out");
      }

      // Get the generated report from session messages
      // Autonomous sessions interleave tool calls/results with assistant
      // messages, so fetch a wider tail than the simple-session default.
      const sessionMessages = await this.runtime.subagent.getSessionMessages({
        sessionKey,
        limit: 20,
      });

      // Prefer the newest assistant message that contains a markdown heading
      // (the report body); fall back to the newest non-empty one (the model
      // sometimes appends a short closing remark after the report).
      let generatedText = "";
      let newestNonEmpty = "";
      if (sessionMessages.messages && Array.isArray(sessionMessages.messages)) {
        for (const msg of sessionMessages.messages.toReversed()) {
          const m = msg as { role?: string; content?: unknown };
          if (m.role !== "assistant") {
            continue;
          }
          const text = extractMessageText(m.content);
          if (!text.trim()) {
            continue;
          }
          if (!newestNonEmpty) {
            newestNonEmpty = text;
          }
          if (/^#\s/m.test(text)) {
            generatedText = text;
            break;
          }
        }
      }
      if (!generatedText) {
        generatedText = newestNonEmpty;
      }

      // Fallback: use the streamed text we collected ourselves, trimmed to the
      // last top-level heading so working narration ("先查询数据库…") that
      // precedes the report body is dropped.
      if (!generatedText && streamedText.trim()) {
        const headings = [...streamedText.matchAll(/^#\s/gm)];
        const lastHeading = headings.length > 0 ? headings[headings.length - 1].index : -1;
        generatedText = lastHeading >= 0 ? streamedText.slice(lastHeading) : streamedText;
        logger.warn(
          "[REPORT_GENERATOR] Session messages yielded no text; falling back to streamed text",
        );
      }

      if (!generatedText) {
        throw new Error("No report content generated");
      }

      // Extract title from first heading
      const titleMatch = generatedText.match(/^#\s+(.+)/m);
      const title = titleMatch ? titleMatch[1].trim() : `${period}舆情报告`;

      logger.info(`[REPORT_GENERATOR] Generated report: ${title}`);

      return {
        title,
        content: generatedText,
        summary: this.extractSummary(generatedText),
      };
    } catch (error) {
      logger.error(`[REPORT_GENERATOR] Generation failed: ${String(error)}`);
      throw error;
    } finally {
      unsubscribe();
    }
  }

  private prepareDataSummary(feedData: FeedRecord[]): string {
    if (feedData.length === 0) {
      return "暂无数据";
    }

    const items = feedData.slice(0, 20).map((r, i) => {
      return `${i + 1}. [${r.platform}] ${r.title} (${new Date(r.date).toLocaleDateString("zh-CN")}) - 情感:${r.emotion}`;
    });

    return items.join("\n");
  }

  private buildReportPrompt(data: {
    period: ReportPeriod;
    requirement: string;
    dateScope: string;
    totalCount: number;
    platforms: string;
    dataSummary: string;
    template: string;
    topicId: number;
    slaveTopicId: number;
    autonomous: boolean;
  }): string {
    if (data.autonomous) {
      const topicFilter =
        data.slaveTopicId > 0
          ? `slaveTopicId = ${data.slaveTopicId}（本专题使用从属专题匹配；主 topicId = ${data.topicId}）`
          : `topicId = ${data.topicId}`;

      return `你是一个专业的舆情分析报告生成助手。

用户需求：${data.requirement}

请生成一份${data.period}舆情报告。

## 任务参数
- 专题过滤条件：${topicFilter}
- 统计时间范围：${data.dateScope}
- 预统计参考：该范围内约 ${data.totalCount} 条数据，涉及平台：${data.platforms || "未知"}

## 数据获取要求
请利用你的数据库查询技能，参考下方表结构自主编写 SQL 查询本专题在统计时间范围内的舆情数据（按上述专题过滤条件和 date 范围过滤，并排除 skip = 1 的记录）。建议自主统计分析：
- 数据总量、按平台分布、按情感(emotion)分布、按风险级别(level)分布、按日期走势
- 高影响力条目（fansNumber、readCount、comments、topicInteractionCount 较高者）与重点内容摘要
- 负面(Negative)/高风险(Red/Orange)信息识别

## 数据表结构
${FEED_TABLE_SCHEMA}

## 报告模板
${data.template}

完成数据查询和分析后，严格按照模板格式生成报告，用查询到的实际数据替换模板中的占位符。不要省略任何部分。如果某项没有数据，请标注"暂无数据"。

报告语言：中文
报告格式：Markdown

最后一条回复必须是完整的报告正文（以 # 标题开头），不要附加多余的说明文字。`;
    }

    return `你是一个专业的舆情分析报告生成助手。

用户需求：${data.requirement}

请根据以下舆情数据生成一份${data.period}舆情报告。

## 数据概览
- 时间范围：${data.dateScope}
- 数据总量：${data.totalCount} 条
- 涉及平台：${data.platforms}

## 舆情数据（最新20条）
${data.dataSummary}

## 报告模板
${data.template}

请严格按照模板格式生成报告，将数据填入模板中的占位符。不要省略任何部分，用实际数据替换占位符。如果没有数据，请标注"暂无数据"。

报告语言：中文
报告格式：Markdown

请直接生成报告，不要有多余的说明文字。`;
  }

  private extractSummary(content: string): string {
    // Extract first 200 chars as summary
    const clean = content.replace(/^#.*$/gm, "").replace(/\n+/g, " ").trim();
    return clean.slice(0, 200) + (clean.length > 200 ? "..." : "");
  }
}
