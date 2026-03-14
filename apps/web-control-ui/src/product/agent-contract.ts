export type PreferenceMemory = {
  visualStyle: string[];
  layout: string[];
  modules: string[];
  dislikes: string[];
  currentGoal: string;
};

export type PreferenceMemoryDraft = {
  visualStyle: string;
  layout: string;
  modules: string;
  dislikes: string;
  currentGoal: string;
};

export type FeatureRecommendation = {
  title: string;
  reason: string;
  action: string;
};

export type AgentWorkflowStage = {
  key: string;
  title: string;
  description: string;
  output: string;
};

export type UpstreamWatchItem = {
  area: string;
  signal: string;
  userValue: string;
  nextAction: string;
};

export type FrontendAgentProtocol = {
  role: string;
  mission: string;
  inputs: string[];
  outputs: string[];
  constraints: string[];
};

export function splitTags(value: string): string[] {
  return value
    .split(/[、,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function toDraft(memory: PreferenceMemory): PreferenceMemoryDraft {
  return {
    visualStyle: memory.visualStyle.join("、"),
    layout: memory.layout.join("、"),
    modules: memory.modules.join("、"),
    dislikes: memory.dislikes.join("、"),
    currentGoal: memory.currentGoal,
  };
}

export function fromDraft(draft: PreferenceMemoryDraft): PreferenceMemory {
  return {
    visualStyle: splitTags(draft.visualStyle),
    layout: splitTags(draft.layout),
    modules: splitTags(draft.modules),
    dislikes: splitTags(draft.dislikes),
    currentGoal: draft.currentGoal.trim(),
  };
}

export function buildFrontendAgentBrief(memory: PreferenceMemory): string {
  return [
    "你是用户的专属前端 agent，不是普通问答机器人。",
    `当前目标：${memory.currentGoal}`,
    `视觉风格：${memory.visualStyle.join("、") || "未指定"}`,
    `布局偏好：${memory.layout.join("、") || "未指定"}`,
    `常用模块：${memory.modules.join("、") || "未指定"}`,
    `明确不喜欢：${memory.dislikes.join("、") || "未指定"}`,
    "每次收到新需求时，先输出需求理解，再输出改动计划、目标文件、验证步骤和后续建议。",
    "你的回答应该服务于 apps/web-control-ui 的真实改代码闭环。",
  ].join("\n");
}
