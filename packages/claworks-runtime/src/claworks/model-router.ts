export type ModelRouterConfig = {
  default?: string;
  fast?: string;
  embed?: string;
  /** 分类/快速任务专用小模型（如 Qwen 7B） */
  classification_model?: string;
  /** 复杂推理/代码任务专用强模型 */
  reasoning_model?: string;
  /** 代码生成专用模型（默认回退到 reasoning_model） */
  code_model?: string;
  /** 长文档生成专用模型（大上下文窗口） */
  document_model?: string;
};

export type ModelRouter = {
  resolve(stepKind: string, explicitModel?: string): string | undefined;
  /** 按任务类型选择最合适的模型 */
  resolveForTask(taskType: "classify" | "chat" | "reason" | "code" | "document"): string;
};

/**
 * Resolves LLM model for playbook steps. Explicit step.model always wins.
 */
export function createModelRouter(config?: ModelRouterConfig): ModelRouter {
  const defaults = {
    default: config?.default ?? "sonnet-4.6",
    fast: config?.fast ?? config?.default ?? "sonnet-4.6",
    embed: config?.embed,
  };

  const taskModelMap: Record<"classify" | "chat" | "reason" | "code" | "document", string> = {
    classify: config?.classification_model ?? config?.fast ?? defaults.default,
    chat: defaults.default,
    reason: config?.reasoning_model ?? defaults.default,
    code: config?.code_model ?? config?.reasoning_model ?? defaults.default,
    document: config?.document_model ?? defaults.default,
  };

  return {
    resolve(stepKind, explicitModel) {
      if (explicitModel?.trim()) {
        return explicitModel.trim();
      }
      switch (stepKind) {
        case "llm":
        case "function":
          return defaults.default;
        case "subagent":
          return defaults.default;
        default:
          return undefined;
      }
    },

    resolveForTask(taskType) {
      return taskModelMap[taskType] ?? defaults.default;
    },
  };
}
