// Gateway client for OpenAI chat tools E2E scenarios.
import { readBoundedResponseBytes } from "../../../lib/bounded-response.mjs";
import { readPositiveIntEnv, readTcpPortEnv } from "../env-limits.mjs";

const portText = process.env.PORT;
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const backendModel = process.env.MODEL_REF || "openai/gpt-5.4-mini";

const timeoutSeconds = readPositiveIntEnv("OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS", 180);
const maxBodyBytes = readPositiveIntEnv("OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES", 1048576);

if (!portText || !token) {
  throw new Error("missing PORT/OPENCLAW_GATEWAY_TOKEN");
}
const port = readTcpPortEnv("PORT", portText);

const controller = new AbortController();
const timeoutError = new Error(`chat completions request timed out after ${timeoutSeconds}s`);
let timeout;
const timeoutPromise = new Promise((_, reject) => {
  timeout = setTimeout(() => {
    controller.abort(timeoutError);
    reject(timeoutError);
  }, timeoutSeconds * 1000);
  timeout.unref?.();
});
const started = Date.now();
let response;
let text;
try {
  response = await Promise.race([
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-openclaw-model": backendModel,
      },
      body: JSON.stringify({
        model: "openclaw",
        stream: false,
        messages: [
          {
            role: "user",
            content:
              "Use the get_weather tool exactly once for Paris, France. Return the tool call only.",
          },
        ],
        tool_choice: "auto",
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Return weather for a city.",
              strict: true,
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  city: { type: "string", description: "City and country." },
                },
                required: ["city"],
              },
            },
          },
        ],
      }),
      signal: controller.signal,
    }),
    timeoutPromise,
  ]);
  text = (
    await readBoundedResponseBytes(response, "chat completions", maxBodyBytes, { timeoutPromise })
  ).toString("utf8");
} finally {
  clearTimeout(timeout);
}

let body;
try {
  body = text ? JSON.parse(text) : {};
} catch {
  throw new Error(`non-JSON response ${response.status}: ${text}`);
}

if (!response.ok) {
  throw new Error(`chat completions request failed ${response.status}: ${JSON.stringify(body)}`);
}

const choice = body.choices?.[0];
const toolCalls = choice?.message?.tool_calls;
if (choice?.finish_reason !== "tool_calls") {
  throw new Error(`expected finish_reason tool_calls: ${JSON.stringify(body)}`);
}
const messageContent = choice?.message?.content;
const hasVisibleContent =
  (typeof messageContent === "string" && messageContent.trim().length > 0) ||
  (Array.isArray(messageContent) && messageContent.length > 0) ||
  (messageContent !== undefined &&
    messageContent !== null &&
    typeof messageContent !== "string" &&
    !Array.isArray(messageContent));
if (hasVisibleContent) {
  throw new Error(`expected tool call only response: ${JSON.stringify(choice.message)}`);
}
if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
  throw new Error(`expected exactly one tool call: ${JSON.stringify(body)}`);
}
const [toolCall] = toolCalls;
if (toolCall?.type !== "function" || toolCall?.function?.name !== "get_weather") {
  throw new Error(`unexpected tool call: ${JSON.stringify(toolCall)}`);
}

let args;
try {
  args = JSON.parse(toolCall.function.arguments || "{}");
} catch {
  throw new Error(`tool arguments were not valid JSON: ${toolCall.function.arguments}`);
}
if (typeof args.city !== "string" || !/paris/i.test(args.city)) {
  throw new Error(`expected Paris city argument: ${JSON.stringify(args)}`);
}

console.log(
  JSON.stringify({
    ok: true,
    elapsedMs: Date.now() - started,
    finishReason: choice.finish_reason,
    toolName: toolCall.function.name,
    args,
  }),
);
