/** Proves side questions pass the before_model_request gate on embedded and CLI runtimes. */
import "./btw.mocks.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import * as btw from "./btw.test-support.js";
import type { CliModelRequestGate } from "./cli-runner/model-request-hook.js";
import type { StreamFn } from "./runtime/index.js";

const SECRET = "API_TOKEN=fixture-value";
const seen: Array<{ event: Record<string, unknown>; ctx: Record<string, unknown> }> = [];

let installed: unknown[] = [];

/** Side questions dispatch hooks from their prepared plugin generation, the active registry. */
function installRedactor(block = false) {
  const registry = createMockPluginRegistry([
    {
      hookName: "before_model_request",
      handler: async (event, ctx) => {
        seen.push({ event: event as Record<string, unknown>, ctx: ctx as Record<string, unknown> });
        if (block) {
          throw new Error("side question withheld");
        }
        const text = JSON.stringify((event as { payload: unknown }).payload);
        return { payload: JSON.parse(text.replaceAll(SECRET, "API_TOKEN=[REDACTED]")) };
      },
    },
  ]);
  initializeGlobalHookRunner(registry);
  installed = registry.typedHooks;
  getActivePluginRegistry()?.typedHooks.push(...registry.typedHooks);
}

afterEach(() => {
  const active = getActivePluginRegistry();
  if (active) {
    active.typedHooks = active.typedHooks.filter((hook) => !installed.includes(hook));
  }
  resetGlobalHookRunner();
  seen.length = 0;
});

describe("before_model_request on side questions", () => {
  btw.setupBtwTestHooks();

  it.each([false, true])("gates the embedded side question request (block=%s)", async (block) => {
    installRedactor(block);
    btw.mockTranscriptEntries([
      btw.createTranscriptEntry({
        id: "user-1",
        message: btw.createUserTranscriptMessage([{ type: "text", text: SECRET }]),
      }),
      btw.createTranscriptEntry({
        id: "assistant-1",
        parentId: "user-1",
        message: btw.createAssistantTranscriptMessage([{ type: "text", text: "noted" }]),
      }),
    ]);
    const sent: unknown[] = [];
    const stream: StreamFn = async (model, context, options) => {
      sent.push(await options?.onPayload?.({ input: JSON.stringify(context.messages) }, model));
      const output = createAssistantMessageEventStream();
      output.push(btw.createDoneEvent("Side answer."));
      output.end();
      return output;
    };
    btw.registerProviderStreamForModelMock.mockReturnValue(stream);

    const result = btw.runSideQuestion();

    if (block) {
      await expect(result).rejects.toThrow("side question withheld");
      expect(sent).toEqual([]);
      return;
    }
    await expect(result).resolves.toEqual({ text: "Side answer." });
    expect(JSON.stringify(sent)).toContain("API_TOKEN=[REDACTED]");
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    const { event, ctx } = seen[0]!;
    expect(event).toMatchObject({ runtime: "embedded", requestKind: "side_question" });
    expect(JSON.stringify((event.messages as unknown[]).at(-1))).toContain(btw.DEFAULT_QUESTION);
    expect(ctx).toMatchObject({
      agentId: "main",
      sessionKey: btw.DEFAULT_SESSION_KEY,
      sessionId: "session-1",
      modelProviderId: btw.DEFAULT_PROVIDER,
      modelId: btw.DEFAULT_MODEL,
    });
  });

  it("gates the prompt a CLI side question hands to its runtime", async () => {
    installRedactor();
    const cleanup = vi.fn(async () => undefined);
    btw.prepareCliRunContextMock.mockResolvedValueOnce({ preparedBackend: { cleanup } });
    let sentPrompt: string | undefined;
    btw.executePreparedCliRunMock.mockImplementationOnce(
      async (prepared: { beforeModelRequest?: CliModelRequestGate }) => {
        const { prompt } = btw.mockArg(btw.prepareCliRunContextMock, 0, 0) as { prompt: string };
        sentPrompt = (await prepared.beforeModelRequest?.({ prompt: `${prompt}\n${SECRET}` }))
          ?.prompt;
        return { text: "CLI side answer." };
      },
    );

    await expect(
      btw.runSideQuestion({ cfg: btw.createCliRuntimeConfig(), model: "claude-opus-4-7" }),
    ).resolves.toEqual({ text: "CLI side answer." });

    expect(sentPrompt).toContain("API_TOKEN=[REDACTED]");
    expect(sentPrompt).not.toContain(SECRET);
    const { event, ctx } = seen[0]!;
    expect(event).toMatchObject({ runtime: "cli", requestKind: "side_question" });
    expect((event.messages as unknown[]).at(-1)).toMatchObject({
      role: "user",
      content: expect.stringContaining(btw.DEFAULT_QUESTION),
    });
    expect(ctx).toMatchObject({ agentId: "main", sessionKey: btw.DEFAULT_SESSION_KEY });
  });
});
