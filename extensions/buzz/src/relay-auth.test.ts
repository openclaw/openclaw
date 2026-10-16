import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { connectAuthenticatedBuzzRelay } from "./relay-auth.js";

describe("Buzz relay authentication", () => {
  it("fails the attempt when the relay closes after sending its NIP-42 challenge", async () => {
    const relay = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    relay.on("connection", (socket) => {
      socket.send(JSON.stringify(["AUTH", "challenge"]));
      socket.close();
    });
    await once(relay, "listening");
    // Listening with a numeric port yields a TCP address, not a named-pipe path.
    const { port } = relay.address() as AddressInfo;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      // When Buzz sends AUTH while the relay still counts as connected, the close
      // rejects the pending AUTH instead; both end the attempt without a crash.
      await expect(
        connectAuthenticatedBuzzRelay({
          relayUrl: `ws://127.0.0.1:${port}`,
          secretKey: generateSecretKey(),
        }),
      ).rejects.toThrow(
        /^(Buzz relay closed before NIP-42 authentication completed|relay connection closed)$/,
      );
      // A dropped AUTH send surfaces on the next macrotask; nothing may escape.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      relay.close();
    }
  });
});
