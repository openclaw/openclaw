import { executeQuery, resolveConfig, type MySqlConfig } from "./mysql-client.js";
import { validateLlmSql } from "./sql-validator.js";
import { getProjectNamesByUser, resolveProjectNameByLlm } from "./project-resolver.js";
import { getTopicIdsByUser } from "./topic-resolver.js";
import { getVisibleFields, mapRowToRecord } from "./visible-fields.js";
import type { FeedDataSearchRequest, FeedDataSearchResponse, FeedRow } from "./types.js";
import type { PluginLogger, PluginRuntime } from "../api.js";

/** Table schema description used in the LLM SQL generation prompt */
const TABLE_SCHEMA_PROMPT = `## 表结构
### feed_monitor_item (别名 f)
- id (INT, 主键)
- topicId (INT)
- slaveTopicId (INT)
- date (DATETIME, 发布日期)
- platform (VARCHAR, 来源平台)
- link (VARCHAR, 原文链接)
- emotion (VARCHAR, 情感倾向)
- skip (INT, 是否跳过 0/1)
- video (INT, 是否视频 0/1)
- fansNumber (INT, 粉丝数)
- comments (INT, 评论数)
- level (VARCHAR, 风险等级)
- original (INT, 是否原创 0/1)
- contentType (VARCHAR, 内容类型)
- mediaLevel (VARCHAR, 媒体级别)
- refId (VARCHAR, 引用ID)
- city (VARCHAR, 城市)

### feed_monitor_item_data
- id (INT, 主键)
- author (VARCHAR)
- reporter (VARCHAR)
- title (VARCHAR)
- titleClean (VARCHAR)
- content (TEXT)
- label (VARCHAR)
- keywords (TEXT)
- keySentences (TEXT)
- summary (TEXT)
- eventDate (DATETIME)

## JOIN 条件
feed_monitor_item.id = feed_monitor_item_data.id`;

/**
 * Run a single-turn LLM prompt via the OpenClaw subagent runtime and return
 * the assistant response text.
 */
async function llmPrompt(
  runtime: PluginRuntime,
  sessionKey: string,
  prompt: string,
): Promise<string> {
  const runResult = await runtime.subagent.run({
    sessionKey,
    message: prompt,
    deliver: false,
  });

  const waitResult = await runtime.subagent.waitForRun({
    runId: runResult.runId,
    timeoutMs: 30_000,
  });

  if (waitResult.status !== "ok") {
    throw new Error(`LLM run failed: ${waitResult.error ?? waitResult.status}`);
  }

  const sessionMessages = await runtime.subagent.getSessionMessages({
    sessionKey,
    limit: 5,
  });

  // Find the last assistant message
  if (sessionMessages.messages && Array.isArray(sessionMessages.messages)) {
    for (const msg of [...sessionMessages.messages].reverse()) {
      const m = msg as { role?: string; content?: string };
      if (m.role === "assistant" && m.content) {
        return m.content;
      }
    }
  }

  return "";
}

/**
 * Generate a safe SQL query from natural language using an LLM subagent.
 * The generated SQL is validated by validateLlmSql before being returned.
 */
async function generateSqlByLlm(
  runtime: PluginRuntime,
  userQuery: string,
  topicId: number,
  useSlaveTopic: boolean,
  limit: number,
  offset: number,
  logger: PluginLogger,
): Promise<string | null> {
  const topicField = useSlaveTopic ? "slaveTopicId" : "topicId";

  const prompt =
    "你是一个 SQL 生成助手。根据用户的自然语言查询，生成一条 MySQL SELECT 查询。\n\n" +
    `${TABLE_SCHEMA_PROMPT}\n\n` +
    "## 硬性约束\n" +
    `1. 必须包含 WHERE f.${topicField} = ${topicId}\n` +
    "2. 必须包含 AND f.skip = 0\n" +
    `3. 必须加 LIMIT ${limit} OFFSET ${offset}\n` +
    "4. 使用 feed_monitor_item 的别名为 f，feed_monitor_item_data 的别名为 d\n" +
    "5. 只返回纯 SQL，不要任何解释或 markdown 代码块标记\n\n" +
    `## 用户查询\n${userQuery}\n\n` +
    "## SQL";

  try {
    let rawSql = (await llmPrompt(runtime, "feed-search:sql-gen", prompt)).trim();

    // Strip markdown code block markers
    rawSql = rawSql.replace(/^```(?:sql)?\s*/, "").replace(/\s*```$/, "").trim();

    if (!rawSql) {
      logger.warn("[FEED_SEARCH] LLM returned empty SQL");
      return null;
    }

    const validation = validateLlmSql(rawSql, topicId, useSlaveTopic);
    if (!validation.valid) {
      logger.warn(`[FEED_SEARCH] LLM SQL failed validation: ${validation.reason}`);
      return null;
    }

    logger.info(`[FEED_SEARCH] LLM generated valid SQL: ${rawSql.slice(0, 200)}`);
    return rawSql;
  } catch (error) {
    logger.error(`[FEED_SEARCH] LLM SQL generation failed: ${error}`);
    return null;
  }
}

/**
 * Execute the 7-step feed data search pipeline.
 *
 * 1. Get projectNames for user
 * 2. Resolve projectName via LLM (if query provided)
 * 3. Get topicId + useSlaveTopic
 * 4. Get visible fields for topicId
 * 5. With q: LLM generates SQL → validate → execute
 * 6. Without q: paginated query by topicId
 * 7. Filter result JSON by visible fields
 */
export async function feedDataSearch(
  pluginConfig: Record<string, unknown>,
  runtime: PluginRuntime,
  logger: PluginLogger,
  request: FeedDataSearchRequest,
): Promise<FeedDataSearchResponse> {
  const config = resolveConfig(pluginConfig);

  try {
    // Step 1: Resolve projectName via LLM when query is present
    let resolvedProjectName: string | null = null;

    if (request.q) {
      const projectNames = await getProjectNamesByUser(config, request.userId);
      if (projectNames.length > 1) {
        resolvedProjectName = await resolveProjectNameByLlm(runtime, request.q, projectNames);
        logger.info(
          `[FEED_SEARCH] LLM resolved projectName for user_id=${request.userId}: ` +
            `query=${request.q} -> projectName=${resolvedProjectName}`,
        );
      } else if (projectNames.length === 1) {
        resolvedProjectName = projectNames[0];
      }
    }

    // Step 2: Get topicId
    const { topicId, useSlaveTopic } = await getTopicIdsByUser(
      config,
      request.userId,
      resolvedProjectName,
    );

    if (topicId === null) {
      logger.info(`[FEED_SEARCH] user_id=${request.userId} has no topicId, returning empty data`);
      return { success: true, data: [], total: 0 };
    }

    // Step 3: Get visible fields
    const visibleFields = await getVisibleFields(config, topicId);
    logger.info(
      `[FEED_SEARCH] user_id=${request.userId}, topicId=${topicId}, ` +
        `use_slave_topic=${useSlaveTopic}, visible_fields=${visibleFields}`,
    );

    // Step 4: Execute query (LLM or paginated)
    if (request.q) {
      return await executeLlmSearch(
        config,
        runtime,
        logger,
        request,
        topicId,
        useSlaveTopic,
        visibleFields,
      );
    }

    return await executePaginatedSearch(config, request, topicId, useSlaveTopic, visibleFields);
  } catch (error) {
    logger.error(`[FEED_SEARCH] Error: ${error}`);
    return {
      success: false,
      error: "An internal error occurred while searching feed data",
    };
  }
}

/** Execute LLM-generated SQL search (when q is present) */
async function executeLlmSearch(
  config: MySqlConfig,
  runtime: PluginRuntime,
  logger: PluginLogger,
  request: FeedDataSearchRequest,
  topicId: number,
  useSlaveTopic: boolean,
  visibleFields: string[],
): Promise<FeedDataSearchResponse> {
  const llmSql = await generateSqlByLlm(
    runtime,
    request.q!,
    topicId,
    useSlaveTopic,
    request.limit,
    request.offset,
    logger,
  );

  if (!llmSql) {
    logger.warn(`[FEED_SEARCH] LLM failed to generate valid SQL for query: ${request.q}`);
    return {
      success: false,
      error: "Unable to generate a valid query for the given search terms",
    };
  }

  try {
    const rows = await executeQuery<FeedRow[]>(config, llmSql);

    // Count query (strip LIMIT and OFFSET)
    const countSql = llmSql.replace(/\bLIMIT\s+\d+(\s+OFFSET\s+\d+)?/i, "");
    const countRows = await executeQuery<
      Array<{ cnt: number }>
    >(config, `SELECT COUNT(*) AS cnt FROM (${countSql}) AS _count_wrapper`);
    const total = countRows[0]?.cnt ?? 0;

    const filteredData = rows.map((row) => mapRowToRecord(row, visibleFields));

    logger.info(
      `[FEED_SEARCH] LLM query succeeded: user_id=${request.userId}, ` +
        `total=${total}, returned=${filteredData.length}`,
    );

    return {
      success: true,
      data: filteredData,
      total,
      visibleFields: visibleFields.length > 0 ? visibleFields : undefined,
    };
  } catch (error) {
    logger.error(`[FEED_SEARCH] LLM SQL execution failed: ${error}`);
    return {
      success: false,
      error: "An internal error occurred while searching feed data",
    };
  }
}

/** Execute paginated search (when q is absent) */
async function executePaginatedSearch(
  config: MySqlConfig,
  request: FeedDataSearchRequest,
  topicId: number,
  useSlaveTopic: boolean,
  visibleFields: string[],
): Promise<FeedDataSearchResponse> {
  const topicField = useSlaveTopic ? "slaveTopicId" : "topicId";

  const conditions: string[] = [`f.${topicField} = ?`, "f.skip = 0"];
  const params: unknown[] = [topicId];

  if (request.itemId != null) {
    conditions.push("d.id = ?");
    params.push(request.itemId);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  // Count
  const countSql =
    `SELECT COUNT(*) AS cnt ` +
    `FROM feed_monitor_item f ` +
    `JOIN feed_monitor_item_data d ON f.id = d.id ` +
    whereClause;
  const countRows = await executeQuery<Array<{ cnt: number }>>(config, countSql, params);
  const total = countRows[0]?.cnt ?? 0;

  // Data
  const dataSql =
    `SELECT d.id, d.author, d.reporter, d.title, d.titleClean, d.content, ` +
    `d.label, d.keywords, d.keySentences, d.summary, d.result, d.eventDate ` +
    `FROM feed_monitor_item f ` +
    `JOIN feed_monitor_item_data d ON f.id = d.id ` +
    `${whereClause} ` +
    `ORDER BY d.id DESC ` +
    `LIMIT ? OFFSET ?`;
  const dataParams = [...params, request.limit, request.offset];

  const rows = await executeQuery<FeedRow[]>(config, dataSql, dataParams);
  const filteredData = rows.map((row) => mapRowToRecord(row, visibleFields));

  return {
    success: true,
    data: filteredData,
    total,
    visibleFields: visibleFields.length > 0 ? visibleFields : undefined,
  };
}
