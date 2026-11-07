import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import { assertCdpTargetResponsive } from "./cdp.js";
import { cdpResult, createCdpFixture, pageReplies } from "./cdp.test-support.js";
import { BrowserTargetCrashedError } from "./target-crash.js";

const { start: startCdp, close: closeCdp } = createCdpFixture({ ...pageReplies });

beforeEach(() => {
  for (const key of ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY"]) {
    vi.stubEnv(key, "");
    vi.stubEnv(key.toLowerCase(), "");
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeCdp();
});

describe("assertCdpTargetResponsive", () => {
  it("accepts a target that answers a page-level command", async () => {
    const { wsUrl } = await startCdp({
      "Page.getFrameTree": cdpResult({ frameTree: { frame: { id: "root" } } }),
    });

    await expect(assertCdpTargetResponsive({ wsUrl, timeoutMs: 1_000 })).resolves.toBeUndefined();
  });

  it("leaves a non-timeout connection failure to the action itself", async () => {
    await expect(
      assertCdpTargetResponsive({
        wsUrl: "ws://127.0.0.1:1/devtools/page/missing",
        timeoutMs: 250,
      }),
    ).resolves.toBeUndefined();
  });

  it("reports a crashed target without waiting for the action budget", async () => {
    // A crashed renderer keeps the target listed but never answers page commands.
    const { wsUrl } = await startCdp(() => undefined);
    const startedAt = Date.now();

    await expect(assertCdpTargetResponsive({ wsUrl, timeoutMs: 150 })).rejects.toMatchObject({
      name: "BrowserTargetCrashedError",
      message: new BrowserTargetCrashedError().message,
    });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});
