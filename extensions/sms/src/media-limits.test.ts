import fs from "node:fs/promises";
import path from "node:path";
import { saveResponseMedia } from "openclaw/plugin-sdk/media-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSmsAccount } from "./accounts.js";
import { materializeSmsInboundMedia, tryHandleHostedSmsMediaRequest } from "./media.js";
import { setSmsRuntime } from "./runtime.js";
import { prepareSmsMediaAttempt } from "./send.js";
import type { ResolvedSmsAccount, SmsChannelConfig } from "./types.js";
import { createSmsTestRequest, createSmsTestResponse } from "./webhook.test-support.js";

const MB = 1024 * 1024;
const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const MESSAGE_SID = `MM${"b".repeat(32)}`;
const PDF = Buffer.from("%PDF-1.4\nmedia-limit-proof\n%%EOF");
const capped = { mediaMaxMb: 1 / MB };
const baseAccount = {
  accountSid: ACCOUNT_SID,
  authToken: "test-token",
  fromNumber: "+15555550100",
  publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
};
function accountFor(sms: SmsChannelConfig, agentLimit?: number, accountId?: string) {
  const cfg = {
    agents: agentLimit === undefined ? undefined : { defaults: { mediaMaxMb: agentLimit } },
    channels: { sms: { ...baseAccount, ...sms } },
  };
  return resolveSmsAccount(cfg, accountId);
}

describe("SMS configured media limits", () => {
  let state: OpenClawTestState;
  async function prepare(account: ResolvedSmsAccount, bytes = PDF, file = "attachment.pdf") {
    const mediaUrl = path.join(state.stateDir, file);
    await fs.writeFile(mediaUrl, bytes);
    return prepareSmsMediaAttempt({
      account,
      text: "caption",
      mediaUrl,
      mediaLocalRoots: [state.stateDir],
    });
  }

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "sms-media-limit" });
    const runtime = createPluginRuntimeMock();
    runtime.state.openKeyedStore = (options) =>
      createPluginStateKeyedStoreForTests("sms", { ...options, env: state.env });
    setSmsRuntime(runtime);
  });

  afterEach(async () => {
    await state.cleanup();
  });

  it.each<[string, SmsChannelConfig, number?, string?]>([
    ["channel root", capped],
    ["normalized account", { mediaMaxMb: 1, accounts: { Support: capped } }, 1, " SUPPORT "],
    ["default account", { defaultAccount: "support", accounts: { support: capped } }],
    ["inherited root", { ...capped, accounts: { support: { enabled: true } } }, 1, "support"],
    ["agent default", {}, 1 / MB],
  ])(
    "rejects a local attachment above the %s cap before staging",
    async (_name, sms, agentLimit, accountId) => {
      await expect(prepare(accountFor(sms, agentLimit ?? 1, accountId))).rejects.toThrow(
        /SMS media preparation failed before Twilio dispatch: Media exceeds/,
      );
    },
  );

  it("serves exact below-cap bytes through the hosted media handler", async () => {
    const account = accountFor({ mediaMaxMb: PDF.length / MB }, 1 / MB);
    const attempt = await prepare(account);
    const hosted = new URL(attempt.hostedMediaUrl);
    const request = Object.assign(createSmsTestRequest({ body: "", signature: "" }), {
      method: "GET",
      url: `${hosted.pathname}${hosted.search}`,
    });
    const response = createSmsTestResponse();
    await tryHandleHostedSmsMediaRequest(request, response, account.accountId);
    expect(response.statusCode).toBe(200);
    expect(response.setHeaderMock).toHaveBeenCalledWith("Content-Type", "application/pdf");
    expect(response.endMock).toHaveBeenCalledWith(PDF);
    await attempt.cleanupHostedMedia();
  });

  it("retains Twilio's GIF ceiling when the configured cap is larger", async () => {
    const bytes = Buffer.alloc(5_000_000);
    bytes.write("GIF89a");
    await expect(prepare(accountFor({ mediaMaxMb: 10 }), bytes, "attachment.gif")).rejects.toThrow(
      /GIF exceeds/,
    );
  });

  it("applies the per-attachment cap without making it a shared inbound budget", async () => {
    const bodies = [PDF, Buffer.alloc(33), PDF];
    const result = await materializeSmsInboundMedia({
      account: accountFor({ mediaMaxMb: 32 / MB }),
      msg: {
        accountSid: ACCOUNT_SID,
        messageSid: MESSAGE_SID,
        from: "+15555550101",
        to: baseAccount.fromNumber,
        body: "three attachments",
        media: ["c", "d", "e"].map((id) => ({
          url: `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${MESSAGE_SID}/Media/ME${id.repeat(32)}`,
          contentType: "application/pdf",
        })),
      },
      mediaRuntime: {
        media: {
          saveRemoteMedia: async (options) => {
            const body = bodies.shift();
            if (!body) {
              throw new Error("unexpected attachment fetch");
            }
            return await saveResponseMedia(
              new Response(body, { headers: { "content-type": "application/pdf" } }),
              { ...options, sourceUrl: options.url },
            );
          },
        },
      },
    });
    expect(result.media).toHaveLength(2);
    expect(result.body).toBe("three attachments\n\n[1 Twilio MMS attachment unavailable]");
    expect(bodies).toEqual([]);
    await result.cleanup();
  });
});
