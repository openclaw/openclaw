// Rcs tests cover send plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRcsAccount } from "./types.js";

type SendModule = typeof import("./send.js");

let sendRcsTextChunks: SendModule["sendRcsTextChunks"];
let toRcsPlainText: SendModule["toRcsPlainText"];

const sendRcsViaTwilio = vi.hoisted(() => vi.fn(async ({ to }) => ({ sid: `SM-${to}`, to })));

beforeEach(async () => {
  vi.resetModules();
  sendRcsViaTwilio.mockClear();
  vi.doMock("./twilio.js", () => ({
    sendRcsViaTwilio,
  }));
  ({ sendRcsTextChunks, toRcsPlainText } = await import("./send.js"));
});

afterEach(() => {
  vi.doUnmock("./twilio.js");
});

function createAccount(textChunkLimit: number): ResolvedRcsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    messagingServiceSid: "MG123",
    senderId: "",
    transport: "rcs-only",
    defaultTo: "",
    webhookPath: "/webhooks/rcs",
    publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
    sharedWebhookPath: "",
    sharedWebhookPublicUrl: "",
    smsForwardWebhookPath: "",
    statusCallbacks: false,
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit,
  };
}

describe("sendRcsTextChunks", () => {
  it("splits long RCS text before sending to Twilio", async () => {
    await sendRcsTextChunks({
      account: createAccount(5),
      to: "+15551234567",
      text: "alpha beta",
    });

    expect(sendRcsViaTwilio).toHaveBeenCalledTimes(2);
    expect(sendRcsViaTwilio.mock.calls.map(([call]) => call.text)).toEqual(["alpha", "beta"]);
  });

  it("flattens markdown before sending RCS chunks", async () => {
    expect(
      toRcsPlainText("**Hi** [docs](https://example.com)\n\n```bash\napprove 123\n```\nthere"),
    ).toBe("Hi docs (https://example.com)\n\napprove 123\nthere");
  });

  it("strips internal tool-trace banners before sending RCS chunks", async () => {
    await sendRcsTextChunks({
      account: createAccount(1500),
      to: "+15551234567",
      text: "**Done.**\n⚠️ 🛠️ `search repos (agent)` failed",
    });

    expect(sendRcsViaTwilio).toHaveBeenCalledOnce();
    expect(sendRcsViaTwilio.mock.calls[0]?.[0].text).toBe("Done.");
  });
});
