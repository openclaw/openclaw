import { describe, expect, it, vi } from "vitest";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";

describe("createNextcloudTalkWebhookServer backend allowlist", () => {
  it("rejects requests from unexpected backend origins", async () => {
    const onMessage = vi.fn(async () => {});
    const harness = await startWebhookServer({
      path: "/nextcloud-backend-check",
      isBackendAllowed: (backend) => backend === "https://nextcloud.expected",
      onMessage,
    });

    const { body, headers } = createSignedCreateMessageRequest({
      backend: "https://nextcloud.unexpected",
    });
    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid backend" });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
