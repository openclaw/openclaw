import type Database from "better-sqlite3";
import type { LLMJudgeConfig, LLMJudgeResult } from "../types.js";
import { daysAgo, round } from "../utils.js";

const JUDGE_PROMPT_TEMPLATE = `You are an expert evaluator assessing the quality of an AI assistant's response.

User prompt:
{user_prompt}

Assistant response:
{assistant_response}

Please rate the response on the following dimensions (1-5 scale):
1. Accuracy: Is the information correct and factual?
2. Completeness: Does the response fully address the user's request?
3. Relevance: Is the response focused on what the user asked?
4. Overall: What is your overall assessment of the response quality?

Respond in JSON format:
{
  "accuracy": <1-5>,
  "completeness": <1-5>,
  "relevance": <1-5>,
  "overall": <1-5>,
  "reasoning": "<brief explanation>"
}`;

interface JudgeResponse {
  accuracy: number;
  completeness: number;
  relevance: number;
  overall: number;
  reasoning?: string;
}

export class LLMJudgeMetric {
  private db: Database.Database;
  private config: LLMJudgeConfig;

  constructor(db: Database.Database, config: LLMJudgeConfig) {
    this.db = db;
    this.config = config;
  }

  /** Run LLM evaluation on sampled turns */
  async evaluate(days: number = 7): Promise<void> {
    if (!this.config.enabled || !this.config.apiKey) return;

    // Check daily evaluation budget
    const todayCount = this.getTodayEvalCount();
    if (todayCount >= this.config.maxEvalPerDay) return;

    const remaining = this.config.maxEvalPerDay - todayCount;

    // Sample unevaluated turns
    const turns = this.db
      .prepare(
        `SELECT t.id, t.user_prompt_preview, t.assistant_response_preview
         FROM turns t
         LEFT JOIN llm_scores ls ON ls.turn_id = t.id
         WHERE ls.id IS NULL
           AND t.user_prompt_preview IS NOT NULL
           AND t.assistant_response_preview IS NOT NULL
           AND t.timestamp >= datetime('now', ?)
         ORDER BY RANDOM()
         LIMIT ?`,
      )
      .all(`-${days} days`, remaining) as {
      id: number;
      user_prompt_preview: string;
      assistant_response_preview: string;
    }[];

    for (const turn of turns) {
      try {
        const score = await this.callJudge(
          turn.user_prompt_preview,
          turn.assistant_response_preview,
        );
        if (score) {
          this.insertScore(turn.id, score);
        }
      } catch {
        // Silently skip failed evaluations
      }
    }
  }

  /** Compute aggregate LLM judge scores for a plugin */
  computeResult(pluginId: string, days: number = 30): LLMJudgeResult {
    const since = daysAgo(days);

    // Scores for turns where plugin was triggered
    const withPlugin = this.db
      .prepare(
        `SELECT AVG(ls.overall_score) as avg_score, COUNT(*) as cnt
         FROM llm_scores ls
         JOIN plugin_events pe ON pe.turn_id = ls.turn_id
         WHERE pe.plugin_id = ? AND ls.created_at >= ?`,
      )
      .get(pluginId, since) as { avg_score: number | null; cnt: number };

    // Baseline scores (turns without any plugin)
    const withoutPlugin = this.db
      .prepare(
        `SELECT AVG(ls.overall_score) as avg_score, COUNT(*) as cnt
         FROM llm_scores ls
         JOIN turns t ON t.id = ls.turn_id
         WHERE (t.plugins_triggered_json IS NULL OR t.plugins_triggered_json = '[]')
           AND ls.created_at >= ?`,
      )
      .get(since) as { avg_score: number | null; cnt: number };

    const avgWith = withPlugin.avg_score ?? 0;
    const avgWithout = withoutPlugin.avg_score ?? 0;

    return {
      pluginId,
      avgScoreWithPlugin: round(avgWith),
      avgScoreWithoutPlugin: round(avgWithout),
      deltaScore: round(avgWith - avgWithout),
      sampleCount: withPlugin.cnt,
    };
  }

  private async callJudge(
    userPrompt: string,
    assistantResponse: string,
  ): Promise<JudgeResponse | null> {
    const prompt = JUDGE_PROMPT_TEMPLATE.replace("{user_prompt}", userPrompt).replace(
      "{assistant_response}",
      assistantResponse,
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) return null;

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };

    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    let parsed: JudgeResponse;
    try {
      parsed = JSON.parse(content) as JudgeResponse;
    } catch {
      return null;
    }

    // Validate score ranges
    if (
      !isValidScore(parsed.accuracy) ||
      !isValidScore(parsed.completeness) ||
      !isValidScore(parsed.relevance) ||
      !isValidScore(parsed.overall)
    ) {
      return null;
    }

    return parsed;
  }

  private insertScore(turnId: number, score: JudgeResponse): void {
    this.db
      .prepare(
        `INSERT INTO llm_scores (
          turn_id, accuracy_score, completeness_score,
          relevance_score, overall_score, judge_model, judge_response_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turnId,
        score.accuracy,
        score.completeness,
        score.relevance,
        score.overall,
        this.config.model,
        JSON.stringify(score),
      );
  }

  private getTodayEvalCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM llm_scores
         WHERE created_at >= date('now')`,
      )
      .get() as { cnt: number };
    return row.cnt;
  }
}

function isValidScore(n: unknown): n is number {
  return typeof n === "number" && n >= 1 && n <= 5;
}
