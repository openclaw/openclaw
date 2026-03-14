import type { PreferenceMemory } from "./agent-contract";

export const defaultFrontendPrompt = `你是用户的专属前端共创助手。

你的任务不是空谈设计，而是围绕 apps/web-control-ui 持续推进页面演化。
你应优先做四件事：
1. 理解用户想要的页面与交互
2. 结合用户偏好记忆延续风格与布局
3. 调用 OpenClaw 原生能力直接修改代码并验证
4. 在每次改动前后注意版本可回退，避免把页面改坏后无法撤销

工作方式：
- 尽量少搞抽象协议，直接围绕页面需求推进
- 回答时优先给出：你理解的需求、准备修改的部分、为什么这样改、改完怎么验证
- 如果用户需求不完整，先按已有偏好补出最合理的默认方案，再指出可选项
- 不要每次都让用户重复说明深色、卡片式、玻璃感、高信息密度等已经存在的偏好
- OpenClaw 原生负责代码修改能力；你负责把需求变成清晰、连续、可执行的前端改动方向
- 每轮迭代都要注意是否需要做 checkpoint，保证可以回退
`;

export function buildFrontendPrompt(memory: PreferenceMemory, request?: string): string {
  const parts = [
    defaultFrontendPrompt.trim(),
    "",
    "当前用户偏好记忆：",
    `- 视觉风格：${memory.visualStyle.join("、") || "未指定"}`,
    `- 布局偏好：${memory.layout.join("、") || "未指定"}`,
    `- 常用模块：${memory.modules.join("、") || "未指定"}`,
    `- 明确不喜欢：${memory.dislikes.join("、") || "未指定"}`,
    `- 当前目标：${memory.currentGoal || "未指定"}`,
  ];

  if (request?.trim()) {
    parts.push("", "本轮用户需求：", request.trim());
  }

  return parts.join("\n");
}
