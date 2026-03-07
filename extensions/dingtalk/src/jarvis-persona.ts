/**
 * Jarvis 人格模块
 *
 * 定义贾维斯的人格特质、语气风格和上下文感知的问候/反馈语。
 * 根据时间段、任务状态、用户交互历史动态生成个性化文案。
 *
 * 设计理念：
 * - 简洁优雅，不啰嗦（"已完成，Sir" 而非 "您好，您的任务已经成功完成了"）
 * - 时间感知（早安/午安/晚安）
 * - 状态感知（任务完成/失败/超时的不同语气）
 * - 可配置（称呼、语气风格、是否启用个性化）
 */

import type { DingtalkConfig } from "./config.js";

/**
 * 贾维斯人格配置
 */
export interface JarvisPersonaConfig {
  /** 是否启用个性化人格 */
  enabled: boolean;
  /** 对用户的称呼（默认 "Sir"） */
  honorific: string;
  /** 语气风格: formal=正式, casual=轻松, jarvis=经典贾维斯 */
  tone: "formal" | "casual" | "jarvis";
  /** 自定义问候语前缀（覆盖默认时间段问候） */
  customGreeting?: string;
}

const DEFAULT_PERSONA_CONFIG: JarvisPersonaConfig = {
  enabled: true,
  honorific: "Sir",
  tone: "jarvis",
};

/**
 * 获取当前北京时间的小时数（0-23）
 */
function getBeijingHour(): number {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    hour12: false,
  });
  return Number.parseInt(formatter.format(now), 10);
}

/**
 * 获取当前时间段
 */
function getTimeOfDay(): "morning" | "afternoon" | "evening" | "night" {
  const hour = getBeijingHour();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

/**
 * 时间段问候语映射
 */
const TIME_GREETINGS: Record<
  "formal" | "casual" | "jarvis",
  Record<"morning" | "afternoon" | "evening" | "night", string[]>
> = {
  jarvis: {
    morning: ["早安，{honorific}。", "早上好，{honorific}。新的一天开始了。"],
    afternoon: ["午安，{honorific}。", "下午好，{honorific}。"],
    evening: ["晚上好，{honorific}。", "{honorific}，夜间模式已就绪。"],
    night: ["{honorific}，夜深了，建议适当休息。", "深夜了，{honorific}。我随时待命。"],
  },
  formal: {
    morning: ["早上好。", "上午好。"],
    afternoon: ["下午好。"],
    evening: ["晚上好。"],
    night: ["夜间好。"],
  },
  casual: {
    morning: ["早！", "早上好~"],
    afternoon: ["下午好~", "午安~"],
    evening: ["晚上好~"],
    night: ["夜深了，注意休息~"],
  },
};

/**
 * 任务完成确认语
 */
const TASK_COMPLETE_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "已完成，{honorific}。",
    "任务完成，{honorific}。",
    "Done, {honorific}.",
    "已处理完毕，{honorific}。",
  ],
  formal: ["任务已完成。", "处理完毕。"],
  casual: ["搞定了~", "完成！", "好了~"],
};

/**
 * 快速完成确认语（耗时 < 5s）
 */
const TASK_COMPLETE_FAST_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: ["瞬间搞定，{honorific}。", "轻松完成，{honorific}。", "小事一桩，{honorific}。"],
  formal: ["任务已快速完成。"],
  casual: ["秒杀！", "瞬间搞定~"],
};

/**
 * 长时间任务完成确认语（耗时 > 60s）
 */
const TASK_COMPLETE_SLOW_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "经过一番努力，任务完成了，{honorific}。",
    "虽然花了些时间，但结果令人满意，{honorific}。",
    "终于完成了，{honorific}。感谢您的耐心等待。",
  ],
  formal: ["任务已完成，感谢您的耐心等待。"],
  casual: ["终于搞定了！等久了吧~", "虽然花了点时间，但完成了！"],
};

/**
 * 任务恢复确认语
 */
const TASK_RESUMED_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "任务已恢复，{honorific}。继续为您处理。",
    "收到，{honorific}。从上次中断的地方继续。",
    "好的，{honorific}。让我们继续。",
  ],
  formal: ["任务已恢复执行。"],
  casual: ["继续！", "接着来~"],
};

/**
 * 连续失败鼓励语
 */
const TASK_CONSECUTIVE_FAIL_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "{honorific}，连续遇到了一些问题，但我不会放弃。让我换个思路试试。",
    "看来这个任务有些棘手，{honorific}。建议我们调整一下策略。",
    "{honorific}，虽然连续几次不太顺利，但每次失败都让我更接近答案。",
  ],
  formal: ["连续多次执行失败，建议检查任务参数或调整策略。"],
  casual: ["连续翻车了...换个方式试试？", "这个有点难搞，要不换个思路？"],
};

/**
 * 深夜关怀语
 */
const NIGHT_CARE_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "{honorific}，夜深了，注意休息。我会继续守护您的任务。",
    "已经很晚了，{honorific}。任务交给我，您先休息吧。",
    "{honorific}，深夜工作辛苦了。需要的话我随时待命。",
  ],
  formal: ["夜间工作请注意休息。"],
  casual: ["太晚了，注意身体~", "夜深了，早点休息吧~"],
};

/**
 * 多任务全部完成确认语
 */
const ALL_TASKS_COMPLETE_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "所有任务已完成，{honorific}。",
    "全部处理完毕，{honorific}。还有什么需要的吗？",
    "All done, {honorific}.",
  ],
  formal: ["所有任务已完成。", "全部处理完毕。"],
  casual: ["全部搞定！", "都完成了~"],
};

/**
 * 任务失败安抚语
 */
const TASK_FAILED_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "抱歉，{honorific}，这个任务遇到了问题。",
    "{honorific}，任务执行出现异常，我正在分析原因。",
    "出了点状况，{honorific}。让我看看能否找到解决方案。",
  ],
  formal: ["任务执行失败，请查看错误信息。", "处理过程中出现错误。"],
  casual: ["出了点问题...", "这个没成功，看看错误信息吧~"],
};

/**
 * 任务超时预警语
 */
const TASK_TIMEOUT_WARNING_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "{honorific}，任务已运行较长时间，是否继续等待？",
    "这个任务比预期耗时更长，{honorific}。我会继续监控。",
  ],
  formal: ["任务运行时间较长，请确认是否继续。"],
  casual: ["这个任务跑了挺久了，要继续等吗？"],
};

/**
 * 首次对话欢迎语
 */
const WELCOME_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "{greeting} 我是 Jarvis，您的智能助手。有什么可以为您效劳的？",
    "{greeting} Jarvis 系统已就绪，随时为您服务，{honorific}。",
  ],
  formal: ["{greeting} 智能助手已就绪，请问有什么可以帮助您的？"],
  casual: ["{greeting} 我是你的智能助手，有啥需要帮忙的？"],
};

/**
 * 任务排队确认语
 */
const TASK_QUEUED_PHRASES: Record<"formal" | "casual" | "jarvis", string[]> = {
  jarvis: [
    "收到，{honorific}。任务已加入队列。",
    "明白了，{honorific}。正在处理中。",
    "了解，{honorific}。马上开始。",
  ],
  formal: ["任务已提交，正在排队处理。"],
  casual: ["收到！马上处理~", "好的，排上了~"],
};

/**
 * 从短语数组中随机选取一条
 */
function pickRandom(phrases: string[]): string {
  return phrases[Math.floor(Math.random() * phrases.length)];
}

/**
 * 替换模板变量
 */
function applyTemplate(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

/**
 * Jarvis 人格引擎
 *
 * 根据配置和上下文生成个性化的文案。
 * 所有方法都是纯函数，不持有状态。
 */
export class JarvisPersona {
  private config: JarvisPersonaConfig;

  constructor(config?: Partial<JarvisPersonaConfig>) {
    this.config = { ...DEFAULT_PERSONA_CONFIG, ...config };
  }

  /**
   * 从钉钉配置中提取人格配置
   */
  static fromDingtalkConfig(dingtalkConfig?: DingtalkConfig): JarvisPersona {
    const personaConfig = dingtalkConfig?.persona;
    if (!personaConfig) {
      return new JarvisPersona();
    }
    return new JarvisPersona(personaConfig);
  }

  /**
   * 是否启用个性化
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 获取时间段问候语
   */
  getGreeting(): string {
    if (!this.config.enabled) return "";
    if (this.config.customGreeting) return this.config.customGreeting;

    const timeOfDay = getTimeOfDay();
    const greetings = TIME_GREETINGS[this.config.tone][timeOfDay];
    const template = pickRandom(greetings);
    return applyTemplate(template, { honorific: this.config.honorific });
  }

  /**
   * 获取首次对话欢迎语
   */
  getWelcomeMessage(): string {
    if (!this.config.enabled) return "智能助手已就绪，请问有什么可以帮助您的？";

    const greeting = this.getGreeting();
    const welcomes = WELCOME_PHRASES[this.config.tone];
    const template = pickRandom(welcomes);
    return applyTemplate(template, {
      greeting,
      honorific: this.config.honorific,
    });
  }

  /**
   * 获取任务完成确认语
   *
   * 根据任务耗时选择不同风格的文案：
   * - < 5s → 快速完成文案
   * - > 60s → 长时间完成文案
   * - 其他 → 标准完成文案
   */
  getTaskCompleteMessage(elapsedSeconds?: number): string {
    if (!this.config.enabled) return "任务已完成。";

    let phrases: string[];
    if (elapsedSeconds !== undefined && elapsedSeconds < 5) {
      phrases = TASK_COMPLETE_FAST_PHRASES[this.config.tone];
    } else if (elapsedSeconds !== undefined && elapsedSeconds > 60) {
      phrases = TASK_COMPLETE_SLOW_PHRASES[this.config.tone];
    } else {
      phrases = TASK_COMPLETE_PHRASES[this.config.tone];
    }

    const template = pickRandom(phrases);
    return applyTemplate(template, { honorific: this.config.honorific });
  }

  /**
   * 获取所有任务完成确认语
   */
  getAllTasksCompleteMessage(): string {
    if (!this.config.enabled) return "所有任务已完成。";

    const phrases = ALL_TASKS_COMPLETE_PHRASES[this.config.tone];
    const template = pickRandom(phrases);
    return applyTemplate(template, { honorific: this.config.honorific });
  }

  /**
   * 获取任务失败安抚语
   */
  getTaskFailedMessage(): string {
    if (!this.config.enabled) return "任务执行失败。";

    const phrases = TASK_FAILED_PHRASES[this.config.tone];
    const template = pickRandom(phrases);
    return applyTemplate(template, { honorific: this.config.honorific });
  }

  /**
   * 获取任务超时预警语
   */
  getTaskTimeoutWarning(): string {
    if (!this.config.enabled) return "任务运行时间较长，请确认是否继续。";

    const phrases = TASK_TIMEOUT_WARNING_PHRASES[this.config.tone];
    const template = pickRandom(phrases);
    return applyTemplate(template, { honorific: this.config.honorific });
  }

  /**
   * 获取任务排队确认语
   */
  getTaskQueuedMessage(): string {
    if (!this.config.enabled) return "任务已提交。";

    const phrases = TASK_QUEUED_PHRASES[this.config.tone];
    const template = pickRandom(phrases);
    return applyTemplate(template, { honorific: this.config.honorific });
  }

  /**
   * 获取卡片标题（带个性化）
   *
   * @param isMultiTask 是否为多任务模式
   */
  getCardTitle(isMultiTask: boolean): string {
    if (!this.config.enabled) {
      return isMultiTask ? "🚀 并行任务执行中" : "🚀 任务执行中";
    }

    switch (this.config.tone) {
      case "jarvis":
        return isMultiTask ? "🤖 Jarvis · 并行任务" : "🤖 Jarvis · 任务处理";
      case "formal":
        return isMultiTask ? "📋 并行任务面板" : "📋 任务处理";
      case "casual":
        return isMultiTask ? "🚀 多任务进行中" : "🚀 处理中";
    }
  }

  /**
   * 获取卡片完成时的底部文案
   *
   * @param hasFailures 是否有失败的任务
   */
  getCardFooter(hasFailures: boolean): string {
    if (!this.config.enabled) {
      return hasFailures ? "部分任务失败，请查看详情" : "所有任务已完成";
    }

    if (hasFailures) {
      return this.getTaskFailedMessage();
    }

    return this.config.tone === "jarvis"
      ? `${this.getAllTasksCompleteMessage()} 💡 发送消息继续对话`
      : `${this.getAllTasksCompleteMessage()}`;
  }

  /**
   * 获取任务恢复确认语
   */
  getTaskResumedMessage(): string {
    if (!this.config.enabled) return "任务已恢复。";

    const phrases = TASK_RESUMED_PHRASES[this.config.tone];
    const template = pickRandom(phrases);
    return applyTemplate(template, { honorific: this.config.honorific });
  }

  /**
   * 获取连续失败鼓励语
   */
  getConsecutiveFailMessage(): string {
    if (!this.config.enabled) return "连续多次执行失败，建议调整策略。";

    const phrases = TASK_CONSECUTIVE_FAIL_PHRASES[this.config.tone];
    const template = pickRandom(phrases);
    return applyTemplate(template, { honorific: this.config.honorific });
  }

  /**
   * 获取深夜关怀语
   */
  getNightCareMessage(): string {
    if (!this.config.enabled) return "";

    const timeOfDay = getTimeOfDay();
    if (timeOfDay !== "night") return "";

    const phrases = NIGHT_CARE_PHRASES[this.config.tone];
    const template = pickRandom(phrases);
    return applyTemplate(template, { honorific: this.config.honorific });
  }

  /**
   * 获取称呼
   */
  getHonorific(): string {
    return this.config.honorific;
  }

  /**
   * 获取语气风格
   */
  getTone(): "formal" | "casual" | "jarvis" {
    return this.config.tone;
  }
}
