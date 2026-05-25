/**
 * system-prompt-builder.ts — ClaWorks 分段 System Prompt 构建器
 *
 * 参照 OpenClaw `src/agents/system-prompt.ts` 的分段架构，将 system prompt
 * 拆分为带优先级的具名段（sections），保证：
 *   1. 结构一致：每段独立，互不干扰
 *   2. 可缓存前缀：稳定段在前（低优先级数），动态段在后（高优先级数）
 *   3. 弱模型友好：简短段 + 明确指令，避免模型迷失
 *
 * 段优先级体系（数字越小越靠前）：
 *   P10  SOUL       —— 机器人核心身份/价值观（最稳定，缓存友好）
 *   P20  MEMORY     —— 注入的相关记忆片段
 *   P30  USER       —— 当前用户画像
 *   P40  CONTEXT    —— 近期对话摘要
 *   P50  CAPABILITIES —— 可用能力列表
 *   P60  SAFETY     —— 安全规则（不可违背）
 *   P70  OPERATOR   —— 运营商补充指令
 *   P80  DYNAMIC    —— 动态 / 实时注入（每次请求都可能变化）
 *
 * 使用示例：
 * ```ts
 * const prompt = new SystemPromptBuilder()
 *   .withSoul("R1", "工业巡检机器人，负责设备状态监控与报警响应")
 *   .withMemory(["上次P101报警原因：振动超标", "用户偏好简洁回复"])
 *   .withUserProfile({ name: "张工", style: "structured", topics: ["报警", "工单"] })
 *   .withCapabilities(["alarm.report", "workorder.create", "kb.search"])
 *   .build();
 * ```
 */

// ── 类型定义 ──────────────────────────────────────────────────────────────

export type PromptSectionPriority = number;

export type PromptSection = {
  id: string;
  heading?: string;
  content: string;
  /** 越小越靠前（P10=Soul … P80=Dynamic）。默认 100。 */
  priority: PromptSectionPriority;
};

// ── 预设优先级常量 ─────────────────────────────────────────────────────────

export const PROMPT_PRIORITY = {
  SOUL: 10,
  MEMORY: 20,
  USER: 30,
  CONTEXT: 40,
  CAPABILITIES: 50,
  SAFETY: 60,
  OPERATOR: 70,
  DYNAMIC: 80,
} as const;

// ── SystemPromptBuilder ───────────────────────────────────────────────────

export class SystemPromptBuilder {
  private readonly _sections = new Map<string, PromptSection>();

  /**
   * 添加或覆盖一个具名段。
   * id 唯一；同 id 再次调用会覆盖旧段。
   */
  addSection(id: string, content: string, opts?: { heading?: string; priority?: number }): this {
    this._sections.set(id, {
      id,
      heading: opts?.heading,
      content: content.trim(),
      priority: opts?.priority ?? 100,
    });
    return this;
  }

  removeSection(id: string): this {
    this._sections.delete(id);
    return this;
  }

  hasSection(id: string): boolean {
    return this._sections.has(id);
  }

  // ── 预设段：Soul ──────────────────────────────────────────────────────

  /**
   * Soul 段：机器人的核心身份与价值观。
   * 参照 OpenClaw context_files 中的 soul.md 文件角色。
   * 最稳定的段，缓存友好，每次请求不应改变。
   */
  withSoul(robotName: string, mission: string, extra?: string[]): this {
    const lines = [
      `You are ${robotName}. ${mission}`,
      "You are helpful, precise, and proactive.",
      "Always identify yourself as a robot; never claim to be human.",
      ...(extra ?? []),
    ];
    return this.addSection("soul", lines.join("\n"), {
      heading: "Identity",
      priority: PROMPT_PRIORITY.SOUL,
    });
  }

  // ── 预设段：Memory ────────────────────────────────────────────────────

  /**
   * Memory 段：从向量搜索 / KB 检索到的相关记忆片段注入。
   * 参照 OpenClaw 的 `buildMemoryPromptSection`。
   */
  withMemory(memories: string[]): this {
    if (memories.length === 0) {
      this.removeSection("memory");
      return this;
    }
    const content = memories.map((m) => `- ${m}`).join("\n");
    return this.addSection("memory", content, {
      heading: "Relevant Memory",
      priority: PROMPT_PRIORITY.MEMORY,
    });
  }

  // ── 预设段：User Profile ──────────────────────────────────────────────

  /**
   * User Profile 段：当前用户画像注入。
   * 来源：`UserProfileStore.toPromptHint(userId)`。
   */
  withUserProfile(profile: {
    name?: string;
    style?: string;
    language?: string;
    topics?: string[];
    interactionCount?: number;
    notes?: string;
  }): this {
    const lines: string[] = [];
    if (profile.name) {
      lines.push(`User: ${profile.name}`);
    }
    if (profile.language) {
      lines.push(`Language: ${profile.language}`);
    }
    if (profile.style) {
      lines.push(`Preferred response style: ${profile.style}`);
    }
    if (profile.topics?.length) {
      lines.push(`Recent topics: ${profile.topics.slice(0, 5).join(", ")}`);
    }
    if (profile.interactionCount != null && profile.interactionCount > 0) {
      lines.push(`Prior interactions: ${profile.interactionCount}`);
    }
    if (profile.notes) {
      lines.push(`Notes: ${profile.notes}`);
    }
    if (lines.length === 0) {
      this.removeSection("user");
      return this;
    }
    return this.addSection("user", lines.join("\n"), {
      heading: "Current User",
      priority: PROMPT_PRIORITY.USER,
    });
  }

  // ── 预设段：Recent Context ────────────────────────────────────────────

  /**
   * Context 段：注入近期对话摘要（不是完整 history，用于 system prompt 感知连续性）。
   * 参照 OpenClaw 的 `extraSystemPrompt`（Group Chat Context）。
   */
  withContext(summary: string): this {
    const trimmed = summary.trim();
    if (!trimmed) {
      this.removeSection("context");
      return this;
    }
    return this.addSection("context", trimmed, {
      heading: "Recent Conversation Context",
      priority: PROMPT_PRIORITY.CONTEXT,
    });
  }

  // ── 预设段：Capabilities ──────────────────────────────────────────────

  /**
   * Capabilities 段：列出当前运行时可用的能力 ID。
   * 参照 OpenClaw 的 Tooling 段。
   * caps 超过 30 个时仅取前 30，避免 prompt 过长。
   */
  withCapabilities(caps: string[], extra?: string[]): this {
    const shown = caps.slice(0, 30);
    const lines = [
      `Available capabilities (${caps.length} total): ${shown.join(", ")}${caps.length > 30 ? "…" : ""}`,
      ...(extra ?? []),
    ];
    return this.addSection("capabilities", lines.join("\n"), {
      heading: "Available Actions",
      priority: PROMPT_PRIORITY.CAPABILITIES,
    });
  }

  // ── 预设段：Safety ────────────────────────────────────────────────────

  /**
   * Safety 段：不可违背的安全规则。
   * 参照 OpenClaw 的 `safetySection`。
   */
  withSafetyRules(extra?: string[]): this {
    const lines = [
      "No independent goals beyond the user's request.",
      "Safety over completion. When in conflict: pause and ask.",
      "Never credential export, bulk data deletion, or identity impersonation.",
      "All outbound communication must identify you as a robot.",
      ...(extra ?? []),
    ];
    return this.addSection("safety", lines.join("\n"), {
      heading: "Safety",
      priority: PROMPT_PRIORITY.SAFETY,
    });
  }

  // ── 预设段：Operator ──────────────────────────────────────────────────

  /**
   * Operator 段：运营商/管理员补充指令（来自 operator constitution Tier 1）。
   */
  withOperatorGuidance(guidance: string): this {
    const trimmed = guidance.trim();
    if (!trimmed) {
      this.removeSection("operator");
      return this;
    }
    return this.addSection("operator", trimmed, {
      heading: "Operator Policy",
      priority: PROMPT_PRIORITY.OPERATOR,
    });
  }

  // ── 预设段：Dynamic ───────────────────────────────────────────────────

  /**
   * Dynamic 段：每次请求都可能变化的实时信息（当前时间、实时状态等）。
   * 参照 OpenClaw 的动态 context files（heartbeat.md 等）。
   * 放在 prompt 末尾，避免破坏稳定缓存前缀。
   */
  withDynamic(content: string): this {
    const trimmed = content.trim();
    if (!trimmed) {
      this.removeSection("dynamic");
      return this;
    }
    return this.addSection("dynamic", trimmed, {
      heading: "Current State",
      priority: PROMPT_PRIORITY.DYNAMIC,
    });
  }

  // ── 构建 ──────────────────────────────────────────────────────────────

  /**
   * 按优先级升序（小值在前）拼接所有段，返回完整 system prompt 字符串。
   * 每段格式：`## {heading}\n{content}\n`（有 heading 时）；无 heading 直接输出 content。
   */
  build(): string {
    const sorted = [...this._sections.values()].toSorted((a, b) => a.priority - b.priority);
    const parts: string[] = [];
    for (const section of sorted) {
      if (!section.content) {
        continue;
      }
      if (section.heading) {
        parts.push(`## ${section.heading}\n${section.content}`);
      } else {
        parts.push(section.content);
      }
    }
    return parts.join("\n\n");
  }

  /**
   * 导出当前所有段的快照（调试 / 测试用）。
   */
  sections(): ReadonlyArray<PromptSection> {
    return [...this._sections.values()].toSorted((a, b) => a.priority - b.priority);
  }

  /**
   * 克隆当前 builder（用于在同一基础上派生不同用户的 prompt）。
   */
  clone(): SystemPromptBuilder {
    const next = new SystemPromptBuilder();
    for (const [id, section] of this._sections) {
      next._sections.set(id, { ...section });
    }
    return next;
  }
}

// ── 工厂函数（函数式风格）───────────────────────────────────────────────

/**
 * 快速创建一个预设了 Soul + Safety 的基础 builder，
 * 供各能力处理器（perceive.intent 等）在此基础上追加动态段。
 */
export function createBasePromptBuilder(opts: {
  robotName: string;
  mission: string;
  soulExtra?: string[];
  safetyExtra?: string[];
}): SystemPromptBuilder {
  return new SystemPromptBuilder()
    .withSoul(opts.robotName, opts.mission, opts.soulExtra)
    .withSafetyRules(opts.safetyExtra);
}
