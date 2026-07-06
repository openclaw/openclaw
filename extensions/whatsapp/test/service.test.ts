import { describe, it, expect } from "vitest";
import nock from "nock";
import { WhatsAppService } from "../src/service.js";

describe("WhatsAppService", () => {
  it("sends text message", async () => {
    const phoneNumberId = "123";
    const token = "tok";
    const to = "447700900000";
    const text = "hello";
    const scope = nock("https://graph.facebook.com")
      .post(`/v15.0/${phoneNumberId}/messages`)
      .reply(200, { messages: [{ id: "msg_1" }] });

    const svc = new WhatsAppService({ accessToken: token, phoneNumberId, logger: console });
    const res = await svc.sendText(to, text);
    expect(res).toBeDefined();
    scope.done();
  });
});
