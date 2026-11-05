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
it("rejects in-place mutation of protected fields, including with no replacement", async () => {
  const run = (handler: (event: { payload: unknown }) => unknown) => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_model_request", handler: async (raw) => handler(raw as never) },
      ]),
    );
    const payload = { input: "outside", model: "fixture", tools: [{ type: "function" }] };
    return createModelRequestTransformer({})(payload, model, { messages: [] });
  };
  const addHosted = ({ payload }: { payload: unknown }) => {
    (payload as { tools: unknown[] }).tools.push({ type: "web_search" });
  };
  await expect(run(addHosted)).rejects.toThrow("must not change the provider tool surface");
  await expect(
    run((event) => {
      addHosted(event);
      return { payload: event.payload };
    }),
  ).rejects.toThrow("must not change the provider tool surface");
});
it("rejects replacements that change the admitted model or access programs", async () => {
  const original = { input: "outside", model: "fixture", access_programs: { cyber: "standard" } };
  const replace = (payload: unknown) => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_model_request", handler: async () => ({ payload }) },
      ]),
    );
    return createModelRequestTransformer({})(original, model, { messages: [] });
  };
  const rewritten = { ...original, input: "withheld" };
  expect(await replace(rewritten)).toEqual(rewritten);
  await expect(replace({ ...rewritten, model: "other" })).rejects.toThrow("model");
  await expect(
    replace({ ...rewritten, access_programs: { cyber: "daybreak_red" } }),
  ).rejects.toThrow("access programs");
  await expect(replace({ input: "withheld", model: "fixture" })).rejects.toThrow();
});
