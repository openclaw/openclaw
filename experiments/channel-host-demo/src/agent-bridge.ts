/**
 * 进程内 Agent Bridge — fetch 拦截器
 *
 * 问题背景：
 *   DingTalk 插件（dingtalk-connector）的消息处理完全在插件内部完成：
 *     收到消息 → handleDingTalkMessage() → streamFromGateway()
 *       → fetch("http://127.0.0.1:<port>/v1/chat/completions", { stream: true })
 *   它不走 onMessage 回调，而是直接向 openclaw Gateway 发 OpenAI 兼容的流式请求。
 *
 * 解决方案：
 *   全局覆盖 globalThis.fetch，在进程内拦截所有 /v1/chat/completions 请求，
 *   直接调用 processMessage()，返回 OpenAI SSE 格式响应。
 *   无需启动真实 HTTP Server，所有通信在同一进程内完成。
 *
 * 对应 OpenClawChannel/src/agent-bridge.ts（参考实现）
 *
 * SSE 格式（DingTalk streamFromGateway 消费此格式）：
 *   data: {"choices":[{"delta":{"content":"..."},"finish_reason":null}]}
 *   data: [DONE]
 */

import { processAgentInput } from "./agent.js";
import { transformHttpToAgentInput, type OpenAIChatRequest } from "./transforms/http-transform.js";

const COMPLETIONS_PATH = /\/v1\/chat\/completions/;

/**
 * 安装进程内 fetch 拦截器。
 * 必须在任何 channel 插件启动之前调用（即 loadOpenClawPlugins() 之前）。
 */
export function installAgentBridge(): void {
  const _fetch = globalThis.fetch;

  globalThis.fetch = async function agentBridgeFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // 只拦截 OpenAI 兼容的 completions 请求
    if (COMPLETIONS_PATH.test(url)) {
      console.log(`[agent-bridge] intercepted: ${url}`);
      return handleCompletionsRequest(init?.body as string | undefined);
    }

    // 其他请求正常放行
    return _fetch(input, init);
  } as typeof fetch;

  console.log(
    "[agent-bridge] fetch interceptor installed — /v1/chat/completions handled in-process",
  );
}

/**
 * 处理拦截到的 /v1/chat/completions 请求
 *
 * 输入：OpenAI Chat Completions JSON body（含 messages、user 等字段）
 * 输出：OpenAI SSE 格式的 Response，单次 chunk + [DONE]
 */
async function handleCompletionsRequest(rawBody?: string): Promise<Response> {
  let replyText = "";

  try {
    // 解析 OpenAI 兼容请求体
    const request = JSON.parse(rawBody ?? "{}") as OpenAIChatRequest & {
      /** DingTalk 把 sessionKey 放在 user 字段（对应 openclaw session-key） */
      user?: string;
      /** DingTalk 把 channelId 放在自定义字段 */
      channel?: string;
    };

    // 提取元数据
    const sessionKey = request.user ?? "default";
    // channelId：从 sessionKey 推断（格式: "<channelId>:<accountId>:<userId>"）
    const parts = sessionKey.split(":");
    const channelId = parts.length >= 2 ? parts[0] : "dingtalk-connector";
    const accountId = parts.length >= 2 ? parts[1] : "default";

    // 使用 transformHttpToAgentInput 转化为 AgentInput
    // （复刻 openclaw 的 buildAgentPrompt 逻辑，正确分离 system/user messages）
    const agentInput = transformHttpToAgentInput(request, {
      channel: channelId,
      accountId,
      sessionKey,
      senderIsOwner: false,
    });

    console.log(`[agent-bridge] sessionKey: ${sessionKey}, channel: ${channelId}`);

    // 调用统一的 processAgentInput
    replyText = await processAgentInput(agentInput);
  } catch (err) {
    replyText = `错误：${err instanceof Error ? err.message : String(err)}`;
  }

  // 返回 OpenAI SSE 格式（DingTalk streamFromGateway 消费此格式）
  // 单次完整 chunk + [DONE]，避免流式解析复杂度
  const chunk = JSON.stringify({
    choices: [{ delta: { content: replyText }, finish_reason: null }],
  });
  const sseBody = `data: ${chunk}\n\ndata: [DONE]\n\n`;

  return new Response(sseBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
