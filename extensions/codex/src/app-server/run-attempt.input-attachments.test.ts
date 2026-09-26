import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { CODEX_TURN_START_TEXT_INPUT_MAX_CHARS } from "./context-engine-projection.js";
import {
  assistantMessage,
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  setCodexTestModelSupportsTools,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createContextEngine } from "./run-attempt.context-engine.test-support.js";
import { createCodexTestModel } from "./test-support.js";

setupRunAttemptTestHooks();

describe("native current input attachments", () => {
  it("delivers prepared document paths alongside native images without changing the canonical prompt", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    const prompt = params.prompt;
    const note = "Attachment file: /fixture/managed/inventory.csv";
    const prepare = vi.fn(async () => note);
    params.hostCapabilities = { ...params.hostCapabilities, prepareInputAttachments: prepare };
    params.model = createCodexTestModel("codex", ["text", "image"]);
    setCodexTestModelSupportsTools(params, false);
    params.images = [
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      },
    ];
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    const user = result.messagesSnapshot.find((message) => message.role === "user");
    expect(user).toBeDefined();
    expect(JSON.stringify(user?.content)).toContain(prompt);
    expect(JSON.stringify(user?.content)).not.toContain(note);
    const start = harness.requests.find((entry) => entry.method === "turn/start");
    const input = (start?.params as { input?: Array<{ type: string; text?: string }> })?.input;
    expect(input?.[0]?.text).toContain(note);
    expect(input?.[1]?.type).toBe("image");
    expect(params.prompt).toBe(prompt);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each([
    ...["inbound", "hook-prefix", "hook-tail"].flatMap((context) =>
      [false, true].flatMap((projected) =>
        [false, true].map((withPaths) => ({ context, projected, withPaths })),
      ),
    ),
    ...["combined", "combined-overflow"].flatMap((context) =>
      [false, true].map((withPaths) => ({ context, projected: true, withPaths })),
    ),
  ])(
    "preserves $context with projected history $projected and optional paths $withPaths",
    async ({ context, projected, withPaths }) => {
      const harness = createStartedThreadHarness();
      const params = createParams(
        path.join(tempDir, "session.jsonl"),
        path.join(tempDir, "workspace"),
      );
      const combined = context.startsWith("combined");
      const expandedContext =
        "current context " +
        "i".repeat(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS - (combined ? 7000 : 2048));
      const hookPrefix = "current prefix " + "p".repeat(1000);
      if (context === "inbound") {
        params.currentInboundContext = { text: expandedContext };
      } else {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_prompt_build",
              handler: async () =>
                combined
                  ? { prependContext: hookPrefix, appendContext: expandedContext }
                  : context === "hook-prefix"
                    ? { prependContext: expandedContext }
                    : { appendContext: expandedContext },
            },
          ]),
        );
      }
      if (projected) {
        params.contextEngine = createContextEngine({
          assemble: async () => ({
            messages: [
              assistantMessage(
                `${"h".repeat(context === "combined-overflow" ? 10000 : 4000)} historical tail`,
                1,
              ),
            ],
            estimatedTokens: 1000,
          }),
        });
      }
      const note = `Attachment paths: ${JSON.stringify(
        Array.from({ length: 80 }, (_, index) => ({
          path: `/fixture/managed/attachment-${index}.csv`,
        })),
      )}`;
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareInputAttachments: async () => (withPaths ? note : undefined),
      };
      setCodexTestModelSupportsTools(params, false);

      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      const start = harness.requests.find((entry) => entry.method === "turn/start");
      const input = (start?.params as { input?: Array<{ type: string; text?: string }> })?.input;
      const inputText = input?.[0]?.text;
      expect(inputText?.includes(expandedContext)).toBe(true);
      expect(inputText).toContain(params.prompt);
      if (combined) {
        expect(inputText?.includes(hookPrefix)).toBe(true);
      }
      if (projected) {
        expect(inputText).toContain("historical tail");
      }
      if (combined && withPaths) {
        expect(inputText).toContain(note);
      } else {
        expect(inputText).not.toContain(note);
      }
      expect(inputText?.length).toBeLessThanOrEqual(CODEX_TURN_START_TEXT_INPUT_MAX_CHARS);
    },
  );
});
