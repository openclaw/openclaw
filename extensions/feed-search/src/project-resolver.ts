import { executeQuery } from "./mysql-client.js";
import type { MySqlConfig } from "./types.js";
import type { PluginRuntime } from "../api.js";

/**
 * Get all distinct projectNames for a user from user_topic_mapping.
 */
export async function getProjectNamesByUser(
  config: MySqlConfig,
  userId: string,
): Promise<string[]> {
  if (!userId) {
    return [];
  }

  try {
    const rows = await executeQuery<Array<{ projectName: string }>>(
      config,
      "SELECT DISTINCT projectName FROM user_topic_mapping WHERE userId = ? AND projectName IS NOT NULL",
      [userId],
    );
    return rows.map((r) => String(r.projectName));
  } catch (error) {
    throw new Error(`Failed to query project names for user ${userId}: ${error}`);
  }
}

/**
 * Use the OpenClaw subagent to determine which projectName best matches the user's query.
 */
export async function resolveProjectNameByLlm(
  runtime: PluginRuntime,
  userQuery: string,
  projectNames: string[],
): Promise<string | null> {
  if (!projectNames.length) {
    return null;
  }
  if (projectNames.length === 1) {
    return projectNames[0];
  }

  const projectList = projectNames.map((n) => `- ${n}`).join("\n");
  const prompt =
    `用户提出了以下查询：\n「${userQuery}」\n\n` +
    `以下是可选的项目名称列表：\n${projectList}\n\n` +
    `请判断用户的查询最可能属于哪个项目，只返回项目名称本身，不要返回任何其他内容。` +
    `如果无法判断，返回 NONE。`;

  try {
    const runResult = await runtime.subagent.run({
      sessionKey: "feed-search:project-resolve",
      message: prompt,
      deliver: false,
    });

    const waitResult = await runtime.subagent.waitForRun({
      runId: runResult.runId,
      timeoutMs: 15_000,
    });

    if (waitResult.status !== "ok") {
      return null;
    }

    const messages = await runtime.subagent.getSessionMessages({
      sessionKey: "feed-search:project-resolve",
      limit: 5,
    });

    let result = "";
    if (messages.messages && Array.isArray(messages.messages)) {
      for (const msg of [...messages.messages].reverse()) {
        const m = msg as { role?: string; content?: string };
        if (m.role === "assistant" && m.content) {
          result = m.content.trim();
          break;
        }
      }
    }

    if (!result || result === "NONE") {
      return null;
    }

    // Exact match
    for (const name of projectNames) {
      if (name === result) {
        return name;
      }
    }

    // Fuzzy match
    for (const name of projectNames) {
      if (result.includes(name) || name.includes(result)) {
        return name;
      }
    }

    return null;
  } catch {
    return null;
  }
}
