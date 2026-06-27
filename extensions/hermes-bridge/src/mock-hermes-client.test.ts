import { describe, expect, it } from "vitest";
import { resolveHermesBridgeConfig } from "./config.js";
import { createMockHermesClient, createMockOpenClawBridge } from "./mock-hermes-client.js";

describe("mock Hermes client integration", () => {
  it("delegates a dry-run task to the mock OpenClaw bridge", async () => {
    const bridge = createMockOpenClawBridge(
      resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["message.preview"],
      }),
    );
    const hermes = createMockHermesClient({ bridge });

    await expect(
      hermes.delegateTask({
        taskId: "message.preview",
        idempotencyKey: "preview-1",
        input: { channel: "telegram", body: "hello" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      idempotencyKey: "preview-1",
      status: "succeeded",
      output: {
        preview: {
          channel: "telegram",
          body: "hello",
          wouldSend: false,
        },
      },
    });
  });
});
