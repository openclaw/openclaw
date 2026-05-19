/**
 * a2a-server.ts — nuwa A2A Protocol Server
 *
 * 暴露 Hermes 四個認知服務為 A2A-compatible HTTP endpoint：
 *   POST /a2a/judge/synthesize    → hermesJudge（MAR Judge 整合）
 *   POST /a2a/got/reason          → runGoT（GoT 圖思維）
 *   POST /a2a/constitution/review → getConstitution（憲法原則查詢）
 *   POST /a2a/persona/list        → persona 列表（EvoAgentX 選角）
 *   GET  /a2a/agent-card          → A2A Agent Card（capability 宣告）
 *
 * 啟動：node mcp/a2a-server.js
 * Port：34822（nuwa MCP: 34821）
 */

import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getConstitution } from "../src/constitutional.js";
import { openDb } from "../src/db.js";
import { runGoT } from "../src/got-reasoning.js";

// ── 型別定義 ─────────────────────────────────────────────────────────────────

interface JudgeCritique {
  personaSlug: string;
  critique: string;
  principleUsed: string;
}

interface JudgeSynthesizeBody {
  task: string;
  critiques: JudgeCritique[];
}

interface GoTReasonBody {
  task: string;
  taskType: string;
}

interface ConstitutionReviewBody {
  taskType: string;
}

interface PersonaRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  style: string | null;
  focus: string | null;
  agent_type: string;
  fitness_score: number;
}

// ── 常數 ─────────────────────────────────────────────────────────────────────

const A2A_PORT = Number.parseInt(process.env["A2A_PORT"] ?? "34822", 10);
const STATE_DIR =
  process.env["NUWA_WORKSPACE"] != null
    ? process.env["NUWA_WORKSPACE"]
    : path.join(process.cwd(), ".claude", "evolution-state");

const AGENT_CARD = {
  name: "nuwa-cognitive-agent",
  version: "2026.5.5",
  description: "nuwa Hermes 認知服務：GoT 圖思維、MAR Judge、憲法辯論、角色演化",
  capabilities: ["got-reasoning", "mar-judge", "constitutional-review", "persona-evolution"],
  endpoints: {
    got: "/a2a/got/reason",
    judge: "/a2a/judge/synthesize",
    constitution: "/a2a/constitution/review",
    personas: "/a2a/persona/list",
  },
  port: 34822,
};

// ── 應用程式初始化 ────────────────────────────────────────────────────────────

const app = new Hono();

// ── 健康檢查 ──────────────────────────────────────────────────────────────────

app.get("/a2a/health", (c) => {
  return c.json({ status: "ok", port: A2A_PORT });
});

// ── Agent Card ────────────────────────────────────────────────────────────────

app.get("/a2a/agent-card", (c) => {
  return c.json(AGENT_CARD);
});

// ── GoT 圖思維推理 ────────────────────────────────────────────────────────────

app.post("/a2a/got/reason", async (c) => {
  try {
    const body = await c.req.json<GoTReasonBody>();
    const { task, taskType } = body;

    if (typeof task !== "string" || typeof taskType !== "string") {
      return c.json({ error: "task 與 taskType 必須為字串" }, 400);
    }

    const { local } = openDb(STATE_DIR);
    const result = await runGoT(task, taskType, local);
    local.close();

    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ── 憲法原則查詢 ──────────────────────────────────────────────────────────────

app.post("/a2a/constitution/review", async (c) => {
  try {
    const body = await c.req.json<ConstitutionReviewBody>();
    const { taskType } = body;

    if (typeof taskType !== "string") {
      return c.json({ error: "taskType 必須為字串" }, 400);
    }

    const { local } = openDb(STATE_DIR);
    const principles = getConstitution(taskType, local);
    local.close();

    return c.json({ taskType, principles });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ── Persona 列表 ──────────────────────────────────────────────────────────────

app.post("/a2a/persona/list", async (c) => {
  try {
    const { local } = openDb(STATE_DIR);
    const rows = local
      .prepare(
        `SELECT id, slug, name, description, style, focus, agent_type, fitness_score
         FROM personas
         ORDER BY fitness_score DESC`,
      )
      .all() as PersonaRow[];
    local.close();

    return c.json({ personas: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ── Judge 整合（組裝 prompt，不呼叫 LLM）────────────────────────────────────

app.post("/a2a/judge/synthesize", async (c) => {
  try {
    const body = await c.req.json<JudgeSynthesizeBody>();
    const { task, critiques } = body;

    if (typeof task !== "string" || !Array.isArray(critiques)) {
      return c.json({ error: "task 必須為字串，critiques 必須為陣列" }, 400);
    }

    const critiqueBlock = critiques
      .map(
        (cr, i) =>
          `[${i + 1}] 角色：${cr.personaSlug}\n` +
          `    原則：${cr.principleUsed}\n` +
          `    批評：${cr.critique}`,
      )
      .join("\n\n");

    const judgePrompt =
      `你是一位公正的 Judge AI。請根據以下多位角色的批評，` +
      `對任務「${task}」做出最終綜合裁決。\n\n` +
      `## 批評意見\n${critiqueBlock}\n\n` +
      `## 裁決要求\n` +
      `1. 指出最有說服力的批評及其原因\n` +
      `2. 提出改善行動計畫（具體、可執行）\n` +
      `3. 評估整體一致性分數（0-1）`;

    return c.json({
      task,
      critiqueCount: critiques.length,
      judgePrompt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ── 啟動伺服器 ────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: A2A_PORT }, (info) => {
  console.log(`nuwa A2A server running on http://localhost:${info.port}`);
});
