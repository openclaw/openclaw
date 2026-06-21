// Covers #93680 review [high]: the bridge /whoami must report nodeIntegrated:true
// when the node-host passes its identity, so the side panel treats a node-hosted
// bridge as node-anchored and fails closed on a dropped node route (instead of an
// unconfined direct gateway fallback). Gateway-only (no identity) reports false.
import { afterEach, describe, expect, it } from "vitest";
import {
  startExtensionBridgeServer,
  type ExtensionBridgeHandle,
} from "./extension-bridge-server.js";

const PORT = 39522;

describe("extension bridge /whoami node identity", () => {
  let handle: ExtensionBridgeHandle | null = null;
  afterEach(async () => {
    await handle?.stop();
    handle = null;
  });

  it("reports nodeIntegrated:true + nodeId when node-hosted", async () => {
    handle = await startExtensionBridgeServer({
      port: PORT,
      identity: { nodeId: "node-abc123", nodeIntegrated: true },
    });
    const res = await fetch(`http://127.0.0.1:${PORT}/whoami`).then((r) => r.json());
    expect(res.nodeIntegrated).toBe(true);
    expect(res.nodeId).toBe("node-abc123");
  });

  it("reports nodeIntegrated:false when gateway-only (no identity)", async () => {
    handle = await startExtensionBridgeServer({ port: PORT });
    const res = await fetch(`http://127.0.0.1:${PORT}/whoami`).then((r) => r.json());
    expect(res.nodeIntegrated).toBe(false);
  });
});
