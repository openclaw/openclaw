// Receiver subprocess for ws-compression-measure.ts; never contributes sender GC.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";

export type CompressionPeerReport = {
  received: number[];
  hashes: string[];
  wireHashes: string[];
  bytes: number;
};

// The parent owns this private benchmark protocol and validates these options.
const { port, clients, windows } = JSON.parse(process.argv[2]!) as {
  port: number;
  clients: number;
  windows: number[];
};
const received = Array<number>(clients).fill(0);
const hashes = Array.from({ length: clients }, () => createHash("sha256"));
const wireHashes = Array.from({ length: clients }, () => createHash("sha256"));
let connected = 0;
let batchReceived = 0;
let measuring = false;
let bytes = 0;

process.on("message", (message: string) => {
  if (message === "connect") {
    const index = connected++;
    const peer = new WebSocket(`ws://127.0.0.1:${port}`, {
      perMessageDeflate: { serverMaxWindowBits: windows[index % windows.length] },
    });
    peer.on("upgrade", (response) => {
      response.socket.on("data", (chunk: Buffer) => {
        if (measuring) {
          wireHashes[index]!.update(chunk);
        }
      });
    });
    peer.on("error", (error) => process.send?.({ type: "error", error: error.message }));
    peer.on("message", (raw, binary) => {
      assert(!binary && Buffer.isBuffer(raw), "expected a JSON text frame");
      received[index] = received[index]! + 1;
      if (measuring) {
        hashes[index]!.update(raw);
        bytes += raw.byteLength;
      }
      if (++batchReceived === clients) {
        batchReceived = 0;
        process.send?.({ type: "batch" });
      }
    });
  } else if (message === "measure") {
    measuring = true;
    process.send?.({ type: "ready" });
  } else if (message === "finish") {
    process.send?.({
      received,
      hashes: hashes.map((hash) => hash.digest("hex")),
      wireHashes: wireHashes.map((hash) => hash.digest("hex")),
      bytes,
    });
  }
});
