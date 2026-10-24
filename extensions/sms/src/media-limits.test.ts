import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { saveResponseMedia } from "openclaw/plugin-sdk/media-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createPluginRuntimeMediaMock,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSmsAccount } from "./accounts.js";
import { materializeSmsInboundMedia, tryHandleHostedSmsMediaRequest } from "./media.js";
import { setSmsRuntime } from "./runtime.js";
import { prepareSmsMediaAttempt } from "./send.js";
import type { ResolvedSmsAccount, SmsChannelConfig } from "./types.js";

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
  let server: Server | undefined;
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
    if (server) {
      await promisify(server.close.bind(server))();
      server = undefined;
    }
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

  it("serves exact below-cap bytes through the hosted HTTP route", async () => {
    const account = accountFor({ mediaMaxMb: PDF.length / MB }, 1 / MB);
    const attempt = await prepare(account);
    const hostedServer = createServer((req, res) => {
      void tryHandleHostedSmsMediaRequest(req, res, account.accountId).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    server = hostedServer;
    await new Promise<void>((resolve) => {
      hostedServer.listen(0, "127.0.0.1", resolve);
    });
    const address = hostedServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected local HTTP listener");
    }
    const hosted = new URL(attempt.hostedMediaUrl);
    const response = await fetch(
      `http://127.0.0.1:${address.port}${hosted.pathname}${hosted.search}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF);
    await attempt.cleanupHostedMedia();
  });

  it.each([
    { file: "attachment.pdf", magic: "%PDF-1.4", size: 500_001, error: /500,000 byte limit/ },
    { file: "attachment.gif", magic: "GIF89a", size: 5_000_000, error: /GIF exceeds/ },
  ])(
    "retains Twilio's ceiling for $file when the configured cap is larger",
    async ({ file, magic, size, error }) => {
      const bytes = Buffer.alloc(size);
      bytes.write(magic);
      await expect(prepare(accountFor({ mediaMaxMb: 10 }), bytes, file)).rejects.toThrow(error);
    },
  );

  it("applies the per-attachment cap without making it a shared inbound budget", async () => {
    const bodies = [PDF, Buffer.alloc(33), PDF];
    const media = createPluginRuntimeMediaMock({
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
    });
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
      mediaRuntime: { media },
    });
    expect(result.media).toHaveLength(2);
    expect(result.body).toBe("three attachments\n\n[1 Twilio MMS attachment unavailable]");
    expect(bodies).toEqual([]);
    await result.cleanup();
  });
});
