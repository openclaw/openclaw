import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  setCodexTestModelSupportsTools,
  tempDir,
} from "./run-attempt-test-harness.js";
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
});
