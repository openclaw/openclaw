import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { startNostrBus } from "../extensions/nostr/src/nostr-bus.ts";
import { setNostrRuntime } from "../extensions/nostr/src/runtime.ts";

function runNak(args: readonly string[]): string {
  return execFileSync("nak", [...args], { encoding: "utf8" }).trim();
}

async function main() {
  setNostrRuntime({
    config: {
      loadConfig: () => ({ channels: { nostr: {} } }),
    },
    state: {
      resolveStateDir: () => "/tmp/nostr-runtime-state",
    },
  } satisfies PluginRuntime);

  const BOT_SECRET = process.env.NOSTR_BOT_SECRET?.trim();
  if (!BOT_SECRET) {
    throw new Error("Missing NOSTR_BOT_SECRET environment variable");
  }

  const BOT_PUBLIC = runNak(["key", "public", BOT_SECRET]);
  const providedSenderSecret = process.env.NOSTR_SENDER_SECRET?.trim();
  const SENDER_SECRET = providedSenderSecret || runNak(["key", "generate"]);

  const plaintext = JSON.stringify({ ver: 1, message: "direct-check-1" });
  const encrypted = runNak([
    "encrypt",
    plaintext,
    "--recipient-pubkey",
    BOT_PUBLIC,
    "--sec",
    SENDER_SECRET,
  ]);

  const bus = await startNostrBus({
    privateKey: BOT_SECRET,
    relays: ["wss://relay.damus.io"],
    onMessage: async (payload, reply) => {
      console.log(
        "received",
        payload.eventId,
        payload.senderPubkey,
        payload.sessionId,
        payload.inReplyTo,
      );
      await reply("ack from runtime test");
    },
    onError: (error, context) => {
      console.error("bus error", context, String(error));
    },
  });

  const event = JSON.parse(
    runNak([
      "event",
      "-q",
      "-k",
      "25802",
      "-p",
      BOT_PUBLIC,
      "-t",
      "s=live-check",
      "-t",
      "encryption=nip44",
      "-c",
      encrypted,
      "--sec",
      SENDER_SECRET,
      "wss://relay.damus.io",
    ]),
  );
  console.log("published", event.id);

  await sleep(20000);
  bus.close();
  console.log("done");
}

void main();
