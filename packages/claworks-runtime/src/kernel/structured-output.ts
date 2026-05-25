/**
 * structured-output.ts — 结构化输出引擎
 *
 * 弱模型补偿：强制 LLM 输出符合 JSON schema，失败自动重试。
 * 解决弱模型输出格式不稳定的痛点。
 */

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type OutputSchemaProperty = {
  type: "string" | "number" | "boolean" | "array" | "object";
  enum?: string[];
  description?: string;
};

export type OutputSchema = {
  type: "object";
  required?: string[];
  properties: Record<string, OutputSchemaProperty>;
};

export type StructuredOutputOpts = {
  schema: OutputSchema;
  /** 最大重试次数，默认 3 */
  maxRetries?: number;
  /** 重试时附加的提示，默认为 JSON schema 提示 */
  retryPrompt?: string;
  /** 解析失败后的兜底值（不抛错） */
  fallback?: Record<string, unknown>;
};

export type StructuredCompleteResult = {
  data: Record<string, unknown>;
  retries: number;
  fallback: boolean;
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export interface StructuredOutputEngine {
  /**
   * 调用 LLM 并强制返回符合 schema 的 JSON。
   * 失败自动重试（最多 maxRetries 次），追加格式提示。
   * 全部失败后使用 fallback 或抛出错误。
   */
  complete(
    prompt: string,
    schema: OutputSchema,
    opts?: Omit<StructuredOutputOpts, "schema">,
  ): Promise<StructuredCompleteResult>;

  /** 验证已有数据是否符合 schema（检查 required 字段、enum 值） */
  validate(data: unknown, schema: OutputSchema): ValidationResult;

  /**
   * Self-Consistency：多次采样并对关键字段投票，提升弱模型可靠性。
   * 适合高置信度要求场景（如报警是否停机、意图分类等）。
   * @param voteField 用于投票的关键字段名（取出现最多的值对应的完整结果）
   * @param votes 采样次数，默认 3
   */
  completeWithVoting(
    prompt: string,
    schema: OutputSchema,
    opts?: Omit<StructuredOutputOpts, "schema"> & { votes?: number; voteField?: string },
  ): Promise<
    StructuredCompleteResult & { vote_counts: Record<string, number>; votes_cast: number }
  >;
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createStructuredOutputEngine(
  llmComplete: (opts: { prompt: string; system?: string }) => Promise<{ text: string }>,
): StructuredOutputEngine {
  function validate(data: unknown, schema: OutputSchema): ValidationResult {
    const errors: string[] = [];

    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { valid: false, errors: ["输出必须是对象"] };
    }

    const obj = data as Record<string, unknown>;

    // 检查 required 字段
    for (const field of schema.required ?? []) {
      if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
        errors.push(`缺少必填字段: ${field}`);
      }
    }

    // 检查 enum 值
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (key in obj && prop.enum && prop.enum.length > 0) {
        const val = obj[key];
        if (typeof val === "string" && !prop.enum.includes(val)) {
          errors.push(`字段 ${key} 的值 "${val}" 不在允许范围内: ${prop.enum.join(", ")}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  function buildSchemaHint(schema: OutputSchema): string {
    const example: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (prop.enum && prop.enum.length > 0) {
        example[key] = prop.enum[0];
      } else if (prop.type === "number") {
        example[key] = 0;
      } else if (prop.type === "boolean") {
        example[key] = false;
      } else if (prop.type === "array") {
        example[key] = [];
      } else if (prop.type === "object") {
        example[key] = {};
      } else {
        example[key] = "";
      }
    }
    return JSON.stringify(example);
  }

  function tryParseJson(text: string): Record<string, unknown> | null {
    // 先直接解析
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 忽略，继续尝试提取
    }
    // 尝试从文本中提取 JSON 对象
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // 忽略
      }
    }
    return null;
  }

  return {
    validate,

    async complete(prompt, schema, opts = {}) {
      const maxRetries = opts.maxRetries ?? 3;
      const fallback = opts.fallback;

      let currentPrompt = prompt;
      const systemHint =
        `请严格以 JSON 格式输出，不要包含任何其他文字说明。` +
        `输出格式示例：${buildSchemaHint(schema)}`;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await llmComplete({ prompt: currentPrompt, system: systemHint });
          const parsed = tryParseJson(result.text);
          if (parsed !== null) {
            const validation = validate(parsed, schema);
            if (validation.valid) {
              return { data: parsed, retries: attempt, fallback: false };
            }
            // 验证失败但有数据：如果是最后一次尝试，检查是否可以用 fallback
            if (attempt < maxRetries) {
              const errStr = validation.errors.join("; ");
              currentPrompt =
                `${prompt}\n\n` +
                `上次输出格式有误（${errStr}），` +
                `请严格按以下JSON格式重新输出：\n${buildSchemaHint(schema)}\n` +
                (opts.retryPrompt ? `\n${opts.retryPrompt}` : "");
              continue;
            }
          } else if (attempt < maxRetries) {
            currentPrompt =
              `${prompt}\n\n` +
              `上次输出格式有误，请严格按以下JSON格式重新输出：\n${buildSchemaHint(schema)}\n` +
              (opts.retryPrompt ? `\n${opts.retryPrompt}` : "");
            continue;
          }
        } catch {
          if (attempt >= maxRetries) {
            break;
          }
          currentPrompt =
            `${prompt}\n\n` +
            `请严格按以下JSON格式重新输出：\n${buildSchemaHint(schema)}\n` +
            (opts.retryPrompt ? `\n${opts.retryPrompt}` : "");
          continue;
        }

        // 到达最后一次尝试
        if (fallback !== undefined) {
          return { data: fallback, retries: attempt, fallback: true };
        }
        throw new Error(`结构化输出失败：${maxRetries + 1} 次尝试均无法解析为合法 JSON schema`);
      }

      if (fallback !== undefined) {
        return { data: fallback, retries: maxRetries, fallback: true };
      }
      throw new Error(`结构化输出失败：${maxRetries + 1} 次尝试均无法解析为合法 JSON schema`);
    },

    async completeWithVoting(prompt, schema, opts = {}) {
      const votes = typeof opts.votes === "number" && opts.votes > 0 ? opts.votes : 3;
      const voteField = opts.voteField ?? Object.keys(schema.properties ?? {})[0] ?? "";
      const results: Array<StructuredCompleteResult> = [];

      // 并行采样 votes 次（允许失败，只收集成功结果）
      const attempts = await Promise.allSettled(
        Array.from({ length: votes }, () =>
          this.complete(prompt, schema, { maxRetries: 1, fallback: opts.fallback }),
        ),
      );
      for (const a of attempts) {
        if (a.status === "fulfilled") {
          results.push(a.value);
        }
      }

      if (results.length === 0) {
        if (opts.fallback !== undefined) {
          return {
            data: opts.fallback,
            retries: votes,
            fallback: true,
            vote_counts: {},
            votes_cast: 0,
          };
        }
        throw new Error(`Self-consistency 全部 ${votes} 次采样均失败`);
      }

      // 对 voteField 统计投票
      const voteCounts: Record<string, number> = {};
      for (const r of results) {
        const v = String((r.data as Record<string, unknown>)[voteField] ?? "__missing__");
        voteCounts[v] = (voteCounts[v] ?? 0) + 1;
      }

      // 取得票最多的结果（相同时取先出现的）
      const winner = Object.entries(voteCounts).toSorted((a, b) => b[1] - a[1])[0][0];
      const winnerResult =
        results.find((r) => String((r.data as Record<string, unknown>)[voteField]) === winner) ??
        results[0];

      return {
        ...winnerResult,
        vote_counts: voteCounts,
        votes_cast: results.length,
      };
    },
  };
}
