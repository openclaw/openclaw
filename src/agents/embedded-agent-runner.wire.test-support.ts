import type { OpenClawConfig } from "../config/types.openclaw.js";

export const omitWireFields = (value: Record<string, unknown>, fields: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));

export type WireApi = "openai-responses" | "openai-completions" | "anthropic-messages";
type ToolCall = { id: string; name: string; itemId?: string };
type WireRecord = Record<string, unknown>;
type ModelSettings = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"]
>[string];

export function cacheRunnerConfig(params: {
  api: WireApi;
  provider: string;
  model: string;
  workspaceDir: string;
  pluginId: string;
  pluginDir: string;
  apiKey: string;
  input: Array<"text" | "image">;
  tools: string[];
  modelSettings: ModelSettings;
}): OpenClawConfig {
  const { api, provider, model, workspaceDir, pluginId, pluginDir, apiKey } = params;
  return {
    agents: {
      entries: { main: { workspace: workspaceDir } },
      defaults: {
        skipBootstrap: true,
        models: { [`${provider}/${model}`]: params.modelSettings },
      },
    },
    models: {
      mode: "replace",
      providers: {
        [provider]: {
          api,
          apiKey,
          baseUrl:
            provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1",
          models: [
            {
              id: model,
              name: model,
              api,
              reasoning: false,
              input: params.input,
              contextWindow: 32_768,
              maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    plugins: {
      allow: [provider, pluginId],
      load: { paths: [pluginDir] },
      slots: { memory: "none" },
      entries: { [pluginId]: { enabled: true, hooks: { allowConversationAccess: true } } },
    },
    skills: { load: { watch: false } },
    tools: { allow: params.tools, toolSearch: false },
  };
}

/** Real provider event envelopes shared by cache and fork tests; no runtime is mocked here. */
export function providerResponse(params: {
  api: WireApi;
  model: string;
  id: string;
  messageId: string;
  text: string;
  calls: ToolCall[];
  cacheRead?: number;
  completedToolStatus?: boolean;
  completionModel?: boolean;
  done?: boolean;
  failure?: { text: string; code: string; message: string };
}): { response: Response; output: WireRecord[] } {
  const { api, model, id, text, calls, cacheRead, failure } = params;
  const tool = calls.length > 0;
  const cached = (key: string) =>
    cacheRead === undefined ? {} : { [key]: { cached_tokens: cacheRead } };
  const message = (value: string) => ({
    type: "message",
    id: params.messageId,
    role: "assistant",
    content: [{ type: "output_text", text: value, annotations: [] }],
    status: "completed",
  });
  let output: WireRecord[] = [];
  let events: WireRecord[];
  if (api === "anthropic-messages") {
    const blocks = tool
      ? calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: {} }))
      : [{ type: "text", text: "" }];
    events = [
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          usage: {
            input_tokens: 1000,
            output_tokens: 0,
            ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead }),
          },
        },
      },
      ...blocks.flatMap((block, index) => [
        { type: "content_block_start", index, content_block: block },
        {
          type: "content_block_delta",
          index,
          delta: tool
            ? { type: "input_json_delta", partial_json: "{}" }
            : { type: "text_delta", text },
        },
        { type: "content_block_stop", index },
      ]),
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
  } else if (api === "openai-completions") {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      ...(params.completionModel ? { model } : {}),
    };
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: "{}" },
          })),
        }
      : { role: "assistant", content: text };
    events = [
      { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
      {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 2,
          total_tokens: 1002,
          ...cached("prompt_tokens_details"),
        },
      },
    ];
  } else {
    output = tool
      ? calls.map((call) =>
          Object.assign(
            {
              type: "function_call",
              id: call.itemId ?? `fc_${call.id}`,
              call_id: call.id,
              name: call.name,
              arguments: "{}",
            },
            params.completedToolStatus ? { status: "completed" } : {},
            failure ? { async: true } : {},
          ),
        )
      : [message(text)];
    if (failure) {
      output.push(message(failure.text));
    }
    events = [
      ...output.flatMap((item, output_index) => [
        {
          type: "response.output_item.added",
          output_index,
          item:
            item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] },
        },
        ...(item.type === "function_call"
          ? [{ type: "response.function_call_arguments.delta", output_index, delta: "{}" }]
          : []),
        { type: "response.output_item.done", output_index, item },
      ]),
      {
        type: failure ? "response.failed" : "response.completed",
        response: {
          id,
          status: failure ? "failed" : "completed",
          output,
          ...(failure ? { error: { code: failure.code, message: failure.message } } : {}),
          usage: {
            input_tokens: 1000,
            output_tokens: 2,
            total_tokens: 1002,
            ...cached("input_tokens_details"),
          },
        },
      },
    ];
  }
  const body =
    events
      .map(
        (event) =>
          `${api === "anthropic-messages" ? `event: ${String(event.type)}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join("") + ((params.done ?? api !== "anthropic-messages") ? "data: [DONE]\n\n" : "");
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    output,
  };
}
