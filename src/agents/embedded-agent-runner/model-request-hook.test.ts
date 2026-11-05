import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterEach, expect, it } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createModelRequestTransformer } from "./model-request-hook.js";

afterEach(resetGlobalHookRunner);
const model = { id: "fixture", provider: "fixture" } as Model;
it("dispatches final payload with detached provenance and the correct session", async () => {
  const source = {
    role: "user" as const,
    content: "outside",
    timestamp: 0,
    __openclaw: { senderIsOwner: false },
  };
  const context: Context = { messages: [source] };
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_model_request",
        handler: async (raw, ctx) => {
          const [copy] = (raw as { messages: [typeof source] }).messages;
          expect(copy["__openclaw"].senderIsOwner).toBe(false);
          expect(ctx).toMatchObject({ sessionKey: "fixture-session" });
          copy.content = "modified copy";
          return { payload: { input: "withheld" } };
        },
      },
    ]),
  );
  const transform = createModelRequestTransformer({ sessionKey: "fixture-session" });
  expect(await transform({ input: "outside" }, model, context)).toEqual({ input: "withheld" });
  expect(source.content).toBe("outside");
});
it("leaves the request intact when the plugin is absent", async () => {
  const payload = { input: "owner" };
  expect(await createModelRequestTransformer({})(payload, model, { messages: [] })).toBe(payload);
});
it("rejects replacements that change the provider tool surface", async () => {
  const tools = [{ type: "function", name: "exec", strict: undefined }];
  const replace = (payload: unknown) => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_model_request", handler: async () => ({ payload }) },
      ]),
    );
    return createModelRequestTransformer({})({ input: "outside", tools }, model, { messages: [] });
  };
  // A JSON-cloned replacement drops undefined members; the wire bytes are unchanged.
  const cloned = { input: "withheld", tools: [{ type: "function", name: "exec" }] };
  expect(await replace(cloned)).toEqual(cloned);
  const hosted = { input: "withheld", tools: [...tools, { type: "web_search" }] };
  await expect(replace(hosted)).rejects.toThrow("must not change the provider tool surface");
  await expect(replace({ input: "withheld", tools, tool_choice: "required" })).rejects.toThrow();
});
