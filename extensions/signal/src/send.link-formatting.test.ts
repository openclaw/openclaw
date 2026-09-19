import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signalPlugin } from "./channel.js";
import { sendMessageSignal } from "./send.js";

type SignalSendRequest = {
  message: string;
  "text-style"?: string[];
  attachments?: string[];
};

describe("Signal link destinations on the wire", { concurrent: false }, () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: http.Server;
  let cfg: OpenClawConfig;
  const requests: SignalSendRequest[] = [];

  beforeAll(async () => {
    state = await createOpenClawTestState({ prefix: "signal-link-formatting-" });
    server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const envelope = JSON.parse(body) as { id: string; params: SignalSendRequest };
        requests.push(envelope.params);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: envelope.id,
            result: { timestamp: 1700000000999 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as { port: number };
    cfg = {
      channels: {
        signal: {
          account: "+15550001111",
          transport: { kind: "external-native", url: `http://127.0.0.1:${port}` },
          textChunkLimit: 80,
        },
      },
    };
  });

  beforeEach(() => {
    requests.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await state.cleanup();
  });

  it.each([
    ["example.com/Report", "https://example.com/report", true],
    ["example.com/?id=AbC", "https://example.com/?id=abc", true],
    ["example.com/guide#Install", "https://example.com/guide#install", true],
    ["example.com /Report", "https://example.com/Report", true],
    ["EXAMPLE.COM/Report", "https://example.com/Report", false],
    ["HTTPS://EXAMPLE.COM/Report", "https://example.com/Report", false],
    ["WWW.EXAMPLE.COM/Report", "https://example.com/Report", false],
    ["example.com", "https://www.example.com///", false],
    ["EXAMPLE@EXAMPLE.COM", "mailto:example@example.com", false],
    ["USER@EXAMPLE.COM?subject=HELLO", "mailto:user@example.com?subject=hello", false],
  ])("delivers [%s](%s) without losing its target", async (label, href, expanded) => {
    await sendMessageSignal("+15555550123", `[${label}]( ${href} )`, { cfg });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.message).toBe(expanded ? `${label} (${href})` : label);
  });

  it("preserves destinations and style offsets across formatted text chunks", async () => {
    const send = signalPlugin.outbound?.sendFormattedText;
    if (!send) {
      throw new Error("Missing Signal formatted text sender");
    }
    await send({
      cfg,
      to: "+15555550123",
      text: "[example.com/Report](https://example.com/report) **one**\n\n[example.com/?id=AbC](https://example.com/?id=abc) **two**",
    });

    const expected = [
      "example.com/Report (https://example.com/report) one",
      "example.com/?id=AbC (https://example.com/?id=abc) two",
    ];
    expect(requests.map((request) => request.message)).toEqual(expected);
    expect(requests.map((request) => request["text-style"])).toEqual(
      expected.map((message) => [`${message.length - 3}:3:BOLD`]),
    );
  });

  it("preserves a formatted media caption destination and the attachment", async () => {
    const send = signalPlugin.outbound?.sendFormattedMedia;
    if (!send) {
      throw new Error("Missing Signal formatted media sender");
    }
    const attachment = state.path("guide.pdf");
    const bytes = Buffer.from("%PDF-1.4\nSignal link formatting fixture");
    await writeFile(attachment, bytes);
    await send({
      cfg,
      to: "+15555550123",
      text: "[example.com/guide#Install](https://example.com/guide#install) **read**",
      mediaUrl: attachment,
      mediaLocalRoots: [state.root],
    });

    const message = "example.com/guide#Install (https://example.com/guide#install) read";
    expect(requests).toHaveLength(1);
    expect(requests[0]?.message).toBe(message);
    expect(requests[0]?.["text-style"]).toEqual([`${message.length - 4}:4:BOLD`]);
    expect(requests[0]?.attachments).toHaveLength(1);
    const deliveredAttachment = requests[0]?.attachments?.[0];
    if (!deliveredAttachment) {
      throw new Error("Missing delivered attachment");
    }
    expect(await readFile(deliveredAttachment)).toEqual(bytes);
  });
});
