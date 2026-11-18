import { expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { attachModelProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { registerSingleProviderPlugin } from "../../test-utils/plugin-registration.js";
import type { StreamFn } from "../runtime/index.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

it.each(["deepseek-v4-pro", "mimo-v2.5-pro"])(
  "keeps reasoning replay and attribution on Requesty %s",
  async (modelId) => {
    const { default: requestyPlugin } = await loadBundledPluginFacade<{
      default: Parameters<typeof registerSingleProviderPlugin>[0];
    }>({ pluginId: "requesty", artifactBasename: "index.js" });
    const plugin = await registerSingleProviderPlugin(requestyPlugin);
    const model = attachModelProviderRuntimePluginHandle(
      makeProviderModelFixture({
        provider: "requesty",
        id: modelId,
        api: "openai-completions",
        baseUrl: "https://router.requesty.ai/v1/",
        reasoning: true,
      }),
      { provider: "requesty", modelId, config: {}, plugin },
    );
    const payload = {
      messages: [{ role: "assistant", content: "Earlier answer", tool_calls: [] }],
    };
    let headers: NonNullable<Parameters<StreamFn>[2]>["headers"];
    const base: StreamFn = async (requestModel, _context, options) => {
      headers = options?.headers;
      await options?.onPayload?.(payload, requestModel);
      return createAssistantMessageEventStream();
    };
    const agent = { streamFn: base };
    applyExtraParamsToAgent(
      agent,
      {},
      "requesty",
      modelId,
      undefined,
      "high",
      undefined,
      undefined,
      model,
    );
    await agent.streamFn(model, { messages: [] });
    expect(headers).toMatchObject({ "X-Title": "OpenClaw", "HTTP-Referer": "https://openclaw.ai" });
    expect(payload).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      messages: [{ role: "assistant", reasoning_content: "" }],
    });
  },
);
