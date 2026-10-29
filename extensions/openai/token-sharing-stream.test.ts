import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { wrapOpenAIResponsesStream } from "./responses-stream.runtime.js";
import { buildOpenAIResponsesProviderHooks } from "./shared.js";
import { createOpenAIResponsesTestModel } from "./test-support/responses-model.test-support.js";
import { TOKEN_SHARING_AUTH_FLOW } from "./token-sharing.js";

const model = createOpenAIResponsesTestModel();

const apiControls = {
  metadata: { caller: "must-not-send" },
  max_output_tokens: 128000,
  temperature: 0.4,
  top_p: 0.8,
  prompt_cache_retention: "24h",
};

const sharingAuth = { mode: "oauth", authFlow: TOKEN_SHARING_AUTH_FLOW } as const;
const preserved = () => ({
  input: [{ role: "user", content: "Hello" }],
  prompt_cache_options: { ttl: "30m" },
  service_tier: "priority",
  text: { verbosity: "low", format: { type: "json_object" } },
});
const userTool = () => ({ type: "function", name: "read_file", parameters: {} });
const baseContext = { provider: "openai", modelId: model.id, model, auth: sharingAuth };
type RequestParams = Partial<ProviderWrapStreamFnContext> & { completion?: boolean };

async function request(
  payload: Record<string, unknown>,
  params: RequestParams = {},
  requestOptions: Parameters<StreamFn>[2] = {},
) {
  const { completion, ...overrides } = params;
  let observed: Parameters<StreamFn>[2];
  let result: Promise<unknown> | undefined;
  const streamFn: StreamFn = (selected, _context, options) => {
    observed = options;
    result = Promise.resolve(options?.onPayload?.(payload, selected)).then(
      (transformed) => transformed ?? payload,
    );
    return createAssistantMessageEventStream();
  };
  const context = { ...baseContext, streamFn, ...overrides };
  const wrapped = completion
    ? buildOpenAIResponsesProviderHooks().wrapSimpleCompletionStreamFn?.(context)
    : wrapOpenAIResponsesStream(context);
  const stream = wrapped ?? streamFn;
  await stream(model, completion ? { messages: [], tools: [] } : { messages: [] }, requestOptions);
  return { options: observed, payload: await result };
}

it.each([false, true])(
  "enforces sharing policy after payload transforms (completion=%s)",
  async (completion) => {
    const tools = completion ? [] : [userTool()];
    const { payload, options } = await request(
      { input: preserved().input, tools },
      {
        completion,
        extraParams: { transport: "websocket", store: true, responsesServerCompaction: true },
      },
      {
        transport: "websocket",
        headers: { "X-OpenAI-ChatPass-Test": "stale", "X-Custom": "preserved" },
        onPayload: async (rawRequest) => ({
          ...(rawRequest as Record<string, unknown>),
          store: true,
          ...apiControls,
          ...preserved(),
          context_management: [{ type: "compaction", compact_threshold: 1000 }],
        }),
      },
    );
    expect(options).toMatchObject({ transport: "sse", replayResponsesItemIds: false });
    expect(Object.fromEntries(new Headers(omitNullRequestHeaders(options?.headers)))).toMatchObject(
      {
        "x-openai-chatpass-test": "codex-direct",
        "x-custom": "preserved",
      },
    );
    for (const field of ["context_management", ...Object.keys(apiControls)]) {
      expect(payload).not.toHaveProperty(field);
    }
    expect(payload).toMatchObject({
      store: false,
      ...preserved(),
      tools: completion ? [] : expect.arrayContaining([userTool(), { type: "web_search" }]),
    });
  },
);

it.each([
  { auth: { mode: "oauth" }, completion: true },
  { auth: { mode: "api_key" }, completion: false },
  { auth: { mode: "oauth" }, completion: false },
] as const)(
  "leaves non-sharing credentials unchanged: $auth.mode / completion=$completion",
  async ({ auth, completion }) => {
    const controls = { ...apiControls, service_tier: "flex" };
    const { options, payload } = await request(
      { ...controls, tools: [], store: true },
      { auth, completion },
      { headers: { "x-custom": "preserved" } },
    );
    const headers = new Headers(omitNullRequestHeaders(options?.headers));
    expect(headers.get("x-openai-chatpass-test")).toBeNull();
    expect(headers.get("x-custom")).toBe("preserved");
    if (completion) {
      expect(payload).toMatchObject({ tools: [], store: true });
    }
    expect(payload).toMatchObject(controls);
  },
);

it("rejects an unsupported SIWC service tier", async () => {
  await expect(request({}, { extraParams: { serviceTier: "auto" } })).rejects.toThrow(
    "Sign in with ChatGPT does not support this service tier",
  );
});
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
