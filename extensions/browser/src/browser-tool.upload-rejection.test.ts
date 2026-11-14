import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { createBrowserTool } from "./browser-tool.js";

// Real-dispatch regression for #197015. The upload action's rejection error must
// name BOTH accepted upload sources: the uploads directory (staged via
// <tmp>/uploads) and the direct inbound media root. This test drives the shipped
// browser tool entry point (createBrowserTool().execute) with a path matching
// neither root, so the real resolveExistingUploadPaths runs unmocked and the
// error is exactly what an agent sees in production.
const probeConfig: OpenClawConfig = {
  browser: { enabled: true },
  gateway: {},
};

describe("browser upload rejection names both accepted sources (#197015)", () => {
  it("rejects a path matching neither source with the uploads directory named alongside inbound media", async () => {
    const tool = createBrowserTool(
      { allowHostControl: true, agentId: "probe", agentSessionKey: "probe:session" },
      () => probeConfig,
    );
    let thrown: unknown;
    try {
      await tool.execute(
        "call-1",
        { action: "upload", paths: ["/tmp/openclaw/downloads/x.pdf"] },
        new AbortController().signal,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("inbound media directory");
    expect(message).toContain("uploads directory");
  });
});
