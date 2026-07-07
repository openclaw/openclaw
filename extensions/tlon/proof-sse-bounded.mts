// Production-style proof for PR 101274.
// Drives the real UrbitSSEClient.processStream / processEvent with Node
// Readable streams to show the 16 MiB SSE cap rejecting oversized input while
// still delivering normal events.
import { Readable } from "node:stream";
import { UrbitSSEClient } from "./src/urbit/sse-client.js";

const CAP = 16 * 1024 * 1024;
const ONE_MIB = 1024 * 1024;

let failed = 0;
let passed = 0;

function ok(message: string): void {
  passed += 1;
  console.log(`  ok: ${message}`);
}

function notOk(message: string): void {
  failed += 1;
  console.log(`  FAIL: ${message}`);
}

async function caseNormalEventDelivered(): Promise<void> {
  console.log("[case 1] normal SSE event delivered through stream path");
  const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
    autoReconnect: false,
  });
  let received: unknown;
  client.eventHandlers.set(1, {
    event: (data: unknown) => {
      received = data;
    },
  });

  const stream = Readable.from(
    ['id: 1\ndata: {"json":{"ok":true,"msg":"hello from urbit"}}\n\n'],
    { objectMode: false },
  );

  await client.processStream(stream);

  if (
    received != null &&
    typeof received === "object" &&
    (received as Record<string, unknown>).ok === true &&
    (received as Record<string, unknown>).msg === "hello from urbit"
  ) {
    ok("normal event delivered");
  } else {
    notOk(`normal event delivered (got ${JSON.stringify(received)})`);
  }
}

async function caseStreamBufferRejected(): Promise<void> {
  console.log("[case 2] oversized stream buffer rejected before unbounded accumulation");
  const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
    autoReconnect: false,
  });
  const megaChunk = "x".repeat(ONE_MIB);
  const stream = Readable.from(
    (async function* () {
      for (let i = 0; i < 17; i += 1) {
        yield megaChunk;
      }
    })(),
    { objectMode: false },
  );

  try {
    await client.processStream(stream);
    notOk("stream buffer overflow rejected");
  } catch (error) {
    if (String(error).includes("Tlon Urbit SSE stream buffer exceeded 16 MiB limit")) {
      ok("stream buffer overflow rejected");
    } else {
      notOk(`stream buffer overflow rejected (got ${String(error)})`);
    }
  }
}

async function casePayloadRejected(): Promise<void> {
  console.log("[case 3] oversized single payload rejected before JSON.parse");
  const errors: string[] = [];
  const client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123", {
    autoReconnect: false,
    logger: { error: (msg: string) => errors.push(msg) },
  });

  const prefix = '{"json":{"ok":true,"x":"';
  const suffix = '"}}';
  const overhead = Buffer.byteLength(prefix + suffix, "utf8");
  const padLen = CAP + 1024 - overhead;
  const hugeJson = prefix + "A".repeat(padLen) + suffix;

  client.processEvent(`id: 1\ndata: ${hugeJson}`);

  if (errors.some((msg) => msg.includes("Tlon Urbit SSE payload exceeds 16 MiB limit"))) {
    ok("oversized payload rejected before JSON.parse");
  } else {
    notOk(`oversized payload rejected (errors: ${JSON.stringify(errors)})`);
  }
}

async function main(): Promise<void> {
  await caseNormalEventDelivered();
  await caseStreamBufferRejected();
  await casePayloadRejected();

  console.log("");
  console.log(`=== Proof Summary ===`);
  console.log(`passed: ${passed}, failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
