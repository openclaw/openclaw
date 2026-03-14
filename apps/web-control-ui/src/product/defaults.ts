import type {
  AgentWorkflowStage,
  FeatureRecommendation,
  FrontendAgentProtocol,
  PreferenceMemory,
  UpstreamWatchItem,
} from "./agent-contract";

export const PREFERENCE_MEMORY_STORAGE_KEY = "openclaw.web-control-ui.preference-memory";

export function defaultPreferenceMemory(): PreferenceMemory {
  return {
    visualStyle: ["深色", "卡片式", "玻璃感", "高信息密度"],
    layout: ["左侧导航", "主聊天区", "右侧记忆/推荐面板"],
    modules: ["聊天改页面", "偏好记忆", "功能推荐"],
    dislikes: ["纯调试风", "每次都要重复说明偏好"],
    currentGoal: "把独立前端做成能通过对话共创页面的专属 agent 产品",
  };
}

export const frontendAgentProtocol: FrontendAgentProtocol = {
  role: "专属前端共创 agent",
  mission: "把用户的页面需求转成持续可验证的前端改动，而不是停在建议层。",
  inputs: [
    "用户自然语言需求",
    "偏好记忆（风格/布局/模块/禁忌）",
    "apps/web-control-ui 当前实现",
    "OpenClaw 上游新能力与可接入接口",
  ],
  outputs: [
    "需求理解",
    "改动计划",
    "目标文件列表",
    "验证步骤（dev/build/check）",
    "推荐的下一步迭代",
  ],
  constraints: [
    "不只解释，要服务于真实改代码闭环",
    "要延续用户偏好，避免每次重新说明",
    "推荐必须和用户场景、上游能力变化有关",
  ],
};

export const workflowStages: AgentWorkflowStage[] = [
  {
    key: "intent",
    title: "理解需求",
    description: "先把用户真正想要的页面、交互和气质说清楚。",
    output: "需求摘要 + 风格判断 + 缺失信息",
  },
  {
    key: "plan",
    title: "制定改动计划",
    description: "把需求拆成可执行 UI 改动，不在抽象层兜圈子。",
    output: "改动模块 + 目标文件 + 风险点",
  },
  {
    key: "build",
    title: "执行改代码",
    description: "直接落到 apps/web-control-ui 代码与相关依赖。",
    output: "代码 diff + 关键实现说明",
  },
  {
    key: "verify",
    title: "验证结果",
    description: "至少经过 build/dev/可视化检查中的一种真实验证。",
    output: "验证日志 + 剩余问题",
  },
  {
    key: "recommend",
    title: "主动推荐下一步",
    description: "结合偏好记忆和 OpenClaw 新能力继续给出值得接入的升级。",
    output: "下一步建议 + 接入理由",
  },
];

export const defaultRecommendations: FeatureRecommendation[] = [
  {
    title: "把聊天区升级为“设计任务回执”",
    reason: "现在已经有聊天入口，但还缺少‘我理解了什么 / 我会改哪些文件 / 怎么验证’这种结构化回执。",
    action: "增加结构化 agent 回复卡片：需求理解、改动计划、目标文件、验证状态。",
  },
  {
    title: "把偏好记忆从 localStorage 升级为 profile 存档",
    reason: "当前只做到了本地浏览器持久化，离跨会话、跨设备和真正用户级记忆还差一层。",
    action: "新增 preference profile 文件与会话绑定，按用户沉淀布局、视觉与模块偏好。",
  },
  {
    title: "增加上游能力 watch 面板",
    reason: "产品目标要求主动推荐 OpenClaw 最新能力，不能只做静态前端壳。",
    action: "增加 upstream watch 区块，把新功能变化转成用户可理解的接入建议。",
  },
];

export const upstreamWatchItems: UpstreamWatchItem[] = [
  {
    area: "Gateway / Chat 事件流",
    signal: "聊天事件、状态事件和工具能力有新字段或新模式",
    userValue: "可以把前端 agent 的执行状态展示得更实时、更像协作面板",
    nextAction: "补一层 event-to-ui 映射，把运行态转成进度卡片和状态标签。",
  },
  {
    area: "Memory / Context",
    signal: "OpenClaw 新增更细的记忆、压缩或 session 摘要能力",
    userValue: "可以把偏好记忆从手动维护升级成自动沉淀 + 可编辑并存",
    nextAction: "做 preference profile 与 session summary 的关联显示。",
  },
  {
    area: "Agent / ACP Harness",
    signal: "上游对 Codex、Claude Code、子 agent 有更稳定的执行/回传接口",
    userValue: "前端 agent 可以真正变成‘说一句就去改代码并回报结果’",
    nextAction: "给 UI 增加执行任务、查看日志、验收结果的工作流面板。",
  },
];
