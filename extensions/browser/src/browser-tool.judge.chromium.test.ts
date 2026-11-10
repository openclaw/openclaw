import { randomBytes } from "node:crypto";
import type { DecisionRuntimeV2 } from "openclaw/plugin-sdk/decisions";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserTool } from "./browser-tool.js";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "./browser/bridge-server.js";
import { resolveBrowserConfig } from "./browser/config.js";
import { withChromiumPage } from "./browser/routes/chromium.test-support.js";
import { registerBrowserRoutes } from "./browser/routes/index.js";

// This opt-in test crosses the real Chromium, authenticated Browser HTTP and tool boundaries.
// The fixture Decision capability checks the observed DOM; unit tests cover inference failure.
afterEach(clearRuntimeConfigSnapshot);
describe.runIf(process.env.OPENCLAW_BROWSER_CONTENT_E2E === "1")("Chromium page judgment", () => {
  it("classifies the actual tab including a consent wall outside its article", async () => {
    setRuntimeConfigSnapshot({});
    await withChromiumPage(
      {
        "http://127.0.0.1:11111/judge":
          "<article>ARTICLE-CONTENT</article><div role=dialog>CONSENT-WALL-OUTSIDE-ARTICLE</div>",
      },
      async ({ cdpUrl, targetId }) => {
        const bridge = await startBrowserBridgeServer({
          resolved: resolveBrowserConfig({
            enabled: true,
            defaultProfile: "fixture",
            evaluateEnabled: false,
            ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
            profiles: { fixture: { cdpUrl, attachOnly: true } },
          }),
          port: 0,
          authToken: randomBytes(32).toString("hex"),
        });
        try {
          const evaluateV2 = vi.fn<DecisionRuntimeV2["evaluateV2"]>(async (batch) => {
            expect(batch.state).toMatchObject({
              type: "text",
              text: expect.stringContaining("CONSENT-WALL-OUTSIDE-ARTICLE"),
            });
            expect(batch.state).toMatchObject({ text: expect.stringContaining("ARTICLE-CONTENT") });
            return {
              status: "ok",
              result: {
                model: "fixture",
                answers: { consent_wall: { type: "boolean", probabilityTrue: 0.98 } },
              },
              provenance: {
                providerId: "fixture",
                rubricVersion: "fixture",
                runtimeGeneration: "one",
              },
            };
          });
          const tool = createBrowserTool({
            sandboxBridgeUrl: bridge.baseUrl,
            allowHostControl: false,
            agentId: "fixture",
            decisions: { evaluate: vi.fn(), evaluateV2 },
          });
          const result = await tool.execute("judge", {
            action: "judge",
            targetId,
            profile: "fixture",
          });
          expect(evaluateV2).toHaveBeenCalledTimes(1);
          expect(result.details).toMatchObject({
            targetId,
            judgment: {
              status: "ok",
              result: { answers: { consent_wall: { probabilityTrue: 0.98 } } },
            },
          });
          expect(JSON.stringify(result)).not.toContain("ARTICLE-CONTENT");
          expect(JSON.stringify(result)).not.toContain("CONSENT-WALL-OUTSIDE-ARTICLE");
        } finally {
          await stopBrowserBridgeServer(bridge.server);
        }
      },
      registerBrowserRoutes,
    );
  }, 40_000);
});
