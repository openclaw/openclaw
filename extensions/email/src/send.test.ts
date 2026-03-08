import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { sendEmailOutbound } from "./send.js";

describe("sendEmailOutbound", () => {
  const account = {
    outboundUrl: "https://example.com/email/outbound",
    outboundToken: "token-123",
  };

  const payload = {
    to: "juno@zhcinstitute.com",
    subject: "Test subject",
    text: "Hello world",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when outbound config is missing", async () => {
    await expect(
      sendEmailOutbound({
        account: { outboundUrl: "", outboundToken: "" },
        payload,
      }),
    ).rejects.toThrow("Email outbound not configured");
  });

  it("posts to outbound url with auth header and payload", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ messageId: "msg-1" }), { status: 200 }));

    const result = await sendEmailOutbound({ account, payload });

    expect(fetchMock).toHaveBeenCalledWith(account.outboundUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.outboundToken}`,
      },
      body: JSON.stringify(payload),
    });
    expect(result).toEqual({ messageId: "msg-1" });
  });

  it("throws with status info on non-2xx responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad request", { status: 400, statusText: "Bad Request" }),
    );

    await expect(sendEmailOutbound({ account, payload })).rejects.toThrow(
      "Email outbound failed (400): bad request",
    );
  });
});
