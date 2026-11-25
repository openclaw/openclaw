import assert from "node:assert/strict";
import path from "node:path";
import { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { createQaBusState } from "./bus-state.js";
import { startCrablineDiscordReplies } from "./crabline-discord-replies.js";

const record = createRequireRecord("record", "expected-record");

it("relays Discord message bytes unchanged while rewriting transport endpoints", async () => {
  await withTempDir("qa-discord-relay-payload-", async (outputDir) => {
    const adapter = await startOpenClawCrablineAdapter({
      channel: "discord",
      openclawConfig: {},
      recorderPath: path.join(outputDir, "discord.jsonl"),
    });
    const relay = await startCrablineDiscordReplies({
      adapter,
      state: createQaBusState(),
      targets: new Map(),
    });
    let socket: WebSocket | undefined;
    try {
      assert(relay && adapter.manifest.provider === "discord", "Discord relay did not start");
      const manifest = adapter.manifest;
      const headers = { authorization: `Bot ${manifest.botToken}` };
      const relayOrigin = new URL(relay.apiBaseUrl).origin;
      const gatewayUrl = `${relayOrigin.replace(/^http/u, "ws")}/gateway`;
      for (const route of ["gateway", "gateway/bot"]) {
        const response = await fetch(`${relay.apiBaseUrl}/${route}`, { headers });
        expect(response.ok).toBe(true);
        await expect(response.json()).resolves.toMatchObject({ url: gatewayUrl });
      }
      socket = new WebSocket(gatewayUrl);
      const ready = createDeferred<unknown>();
      let delivered = createDeferred<unknown>();
      socket.on("error", (error) => {
        ready.reject(error);
        delivered.reject(error);
      });
      socket.on("message", (data) => {
        const event: unknown = JSON.parse(rawDataToString(data));
        if (isRecord(event)) {
          if (event.t === "READY") {
            ready.resolve(event.d);
          } else if (event.t === "MESSAGE_CREATE" || event.t === "MESSAGE_UPDATE") {
            delivered.resolve(event.d);
          }
        }
      });
      socket.on("open", () => {
        socket?.send(JSON.stringify({ op: 2, d: { token: manifest.botToken, intents: 0 } }));
      });
      await expect(ready.promise).resolves.toMatchObject({ resume_gateway_url: gatewayUrl });

      const messagesUrl = `${relay.apiBaseUrl}/channels/${manifest.fixture.channelId}/messages`;
      for (const origin of [
        new URL(manifest.endpoints.apiRoot).origin,
        new URL(manifest.endpoints.gatewayUrl).origin,
      ]) {
        const text = `${origin}/user-visible?keep=%2F#fragment\r\n\tUnicode 🦞`;
        const payload = {
          content: text,
          embeds: [{ description: text, title: text, url: `${origin}/semantic-link` }],
          attachments: [{ id: "0", description: text }],
        };
        const form = new FormData();
        form.set("payload_json", JSON.stringify(payload));
        form.set("files[0]", new Blob(["attachment bytes"]), "proof.txt");
        delivered = createDeferred<unknown>();
        const response = await fetch(messagesUrl, { method: "POST", headers, body: form });
        expect(response.ok).toBe(true);
        const message = record(await response.json());
        assert(typeof message.id === "string", "Discord reply omitted its message ID");
        const event = await delivered.promise;
        const retainedResponse = await fetch(`${messagesUrl}/${message.id}`, { headers });
        expect(retainedResponse.ok).toBe(true);
        for (const value of [message, event, await retainedResponse.json()]) {
          const received = record(value);
          expect(received).toMatchObject({ ...payload, attachments: [{ description: text }] });
          assert(Array.isArray(received.attachments), "Discord reply omitted its attachments");
          const attachment = record(received.attachments[0]);
          for (const field of ["url", "proxy_url"]) {
            const url = attachment[field];
            assert(typeof url === "string", `Discord attachment omitted ${field}`);
            expect(new URL(url).origin).toBe(relayOrigin);
            const download = await fetch(url);
            expect(download.ok).toBe(true);
            await expect(download.text()).resolves.toBe("attachment bytes");
          }
        }
      }
    } finally {
      socket?.terminate();
      await relay?.cleanup();
      await adapter.close();
    }
  });
});
