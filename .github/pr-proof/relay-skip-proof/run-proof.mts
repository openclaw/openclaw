/**
 * Standalone CLI proof for PR openclaw/openclaw#191578.
 *
 * Exercises the real ExtensionRelayBridge (from the changed source) against an
 * in-process mock extension + CDP client. The mock extension refuses to attach
 * one tab with Chrome's exact permanent refusal "Cannot attach to this target.",
 * and attaches a healthy tab normally. The bridge must skip the refused tab (with
 * a warning) and still return the healthy tab in Target.getTargets.
 *
 * All traffic is synthetic (no real browser, no real network, no real data).
 */
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { ExtensionRelayBridge } from "../../../extensions/browser/src/browser/extension-relay/relay-bridge.js";
import type {
  ExtensionToRelayMessage,
  RelayToExtensionMessage,
} from "../../../extensions/browser/src/browser/extension-relay/relay-protocol.js";

const log = createSubsystemLogger("pr-proof").child("relay-skip");

// --- Minimal in-process socket + scripted extension (mirrors the unit test) ---
class FakeSocket {
  readonly sent: unknown[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
}

type Handlers = { onMessage(raw: string): void };

function wireExtension(
  bridge: ExtensionRelayBridge,
  reply: (msg: RelayToExtensionMessage) => ExtensionToRelayMessage | null,
) {
  const socket = new FakeSocket();
  const handlers = bridge.attachExtensionSocket(socket);
  const originalSend = socket.send.bind(socket);
  socket.send = (data: string) => {
    originalSend(data);
    const msg = JSON.parse(data) as RelayToExtensionMessage;
    if (msg.type === "ping") return;
    queueMicrotask(() => {
      const response = reply(msg);
      if (response) handlers.onMessage(JSON.stringify(response));
    });
  };
  return { socket, handlers };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function main() {
  log.info("building proof against changed ExtensionRelayBridge source");
  const bridge = new ExtensionRelayBridge();

  // Scripted extension: attach tab 2 fails with Chrome's exact permanent refusal.
  const { handlers } = wireExtension(bridge, (msg) => {
    if (msg.type === "attach" && msg.tabId === 2) {
      return { type: "error", seq: msg.seq, message: "Cannot attach to this target." };
    }
    switch (msg.type) {
      case "attach":
        return { type: "result", seq: msg.seq, result: { targetId: `target-${msg.tabId}` } };
      case "detach":
      case "activateTab":
      case "closeTab":
        return { type: "result", seq: msg.seq, result: {} };
      case "cdp":
        return { type: "result", seq: msg.seq, result: { ok: true, echoed: msg.method } };
      default:
        return null;
    }
  });

  // Two tabs: 1 = healthy, 2 = Chrome refuses to attach.
  handlers.onMessage(
    JSON.stringify({
      type: "hello",
      userAgent: "Mozilla/5.0 Chrome/144.0.0.0 (synthetic)",
      browserVersion: "Chrome/144.0.0.0 (synthetic)",
      extensionVersion: "2.0.0 (synthetic)",
      tabs: [
        { tabId: 1, url: "https://example.com/healthy", title: "Healthy", active: true },
        { tabId: 2, url: "https://example.com/refused", title: "Refused", active: false },
      ],
    }),
  );
  await flush();

  // In-process CDP client issues the exact command `openclaw browser tabs` relies on.
  const client = new FakeSocket();
  const cdp = bridge.attachCdpClientSocket(client);
  cdp.onMessage(JSON.stringify({ id: 1, method: "Target.getTargets" }));
  await flush();

  const frames = client.sent as Array<Record<string, unknown>>;
  const response = frames.find((f) => f.id === 1);
  const result = (response as { result?: { targetInfos?: Array<{ targetId?: string }> } })?.result;
  const targetInfos = result?.targetInfos ?? [];
  const returnedIds = targetInfos.map((t) => t.targetId).sort();

  log.info(
    `Target.getTargets returned ${targetInfos.length} target(s): ${JSON.stringify(returnedIds)}`,
  );

  const hasHealthy = returnedIds.includes("target-1");
  const hasRefused = returnedIds.includes("target-2");
  const isError = typeof (response as { error?: unknown })?.error !== "undefined";

  bridge.dispose();

  const pass = hasHealthy && !hasRefused && !isError && targetInfos.length === 1;
  log.info(
    pass
      ? "PROOF PASS: refused tab skipped, healthy tab returned"
      : `PROOF FAIL: healthy=${hasHealthy} refused=${hasRefused} error=${isError} count=${targetInfos.length}`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("proof crashed:", err);
  process.exit(2);
});
