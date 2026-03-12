/**
 * Agent — 消息处理逻辑（stub）
 *
 * 当前实现：固定回复"我知道了"
 * 后续：替换 processAgentInput 为真实的 AI 调用（LLM API、langchain 等）
 */

import type { AgentInput, InboundMessage } from "./types.js";

/**
 * 处理标准化的 AgentInput（核心实现）
 *
 * @param input  统一的 AgentInput（已包含 message, extraSystemPrompt, images 等）
 * @returns      回复文本
 *
 * 扩展点：
 *   - 替换为 OpenAI/Anthropic/本地 LLM 调用
 *   - 添加 session 管理（input.sessionKey）
 *   - 添加工具调用能力（function calling）
 *   - 处理多模态输入（input.images）
 */
export async function processAgentInput(input: AgentInput): Promise<string> {
  console.log(
    `[agent] processing message from channel "${input.messageChannel}" (session: ${input.sessionKey})`,
  );
  console.log(`[agent] message: ${input.message}`);
  if (input.extraSystemPrompt) {
    console.log(
      `[agent] extraSystemPrompt (${input.extraSystemPrompt.length} chars): ${input.extraSystemPrompt.slice(0, 100)}...`,
    );
  }
  if (input.images && input.images.length > 0) {
    console.log(`[agent] images: ${input.images.length} attachment(s)`);
  }
  if (input.groupId) {
    console.log(
      `[agent] groupId: ${input.groupId}, groupChannel: ${input.groupChannel}, groupSpace: ${input.groupSpace}`,
    );
  }
  if (input.agentId) {
    console.log(`[agent] agentId: ${input.agentId}`);
  }

  console.log(`[agent] input: ${JSON.stringify(input, null, 2)}`);

  // TODO: 替换为真实 AI 调用
  // 示例（OpenAI with system prompt）：
  // const messages = [];
  // if (input.extraSystemPrompt) {
  //   messages.push({ role: "system", content: input.extraSystemPrompt });
  // }
  // messages.push({ role: "user", content: input.message });
  // const response = await openai.chat.completions.create({
  //   model: "gpt-4o",
  //   messages,
  // });
  // return response.choices[0].message.content ?? "（无回复）";

  return "我知道了";
}

/**
 * 处理入站消息（向后兼容接口）
 *
 * @param msg  标准化的入站消息（来自任意 channel 插件）
 * @returns    回复文本
 *
 * 注意：此函数仅用于 demo-channel 等简单场景。
 * 真实插件（qqbot/dingtalk/feishu）应使用转化函数生成 AgentInput 并调用 processAgentInput。
 */
export async function processMessage(msg: InboundMessage): Promise<string> {
  // 简单转换：InboundMessage → AgentInput
  const agentInput: AgentInput = {
    message: msg.text,
    sessionKey: msg.from,
    messageChannel: msg.channel,
    channel: msg.channel,
    accountId: msg.accountId,
    senderIsOwner: false,
    inputProvenance: {
      kind: "external_user",
      sourceChannel: msg.channel,
    },
  };

  return processAgentInput(agentInput);
}
