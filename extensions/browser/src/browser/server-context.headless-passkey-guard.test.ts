import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdp from "./cdp.js";
import {
  createTestBrowserRouteContext,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";
import { mockLaunchedChrome } from "./server-context.test-harness.js";

const { createPageViaPlaywright } = vi.hoisted(() => ({
  createPageViaPlaywright: vi.fn(async () => ({
    targetId: "NEW",
    title: "Sign in",
    url: "https://example.com",
    type: "page",
    close: vi.fn(),
  })),
}));

vi.mock("./pw-ai-module.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-ai-module.js")>()),
  getPwAiModule: vi.fn(async () => ({ createPageViaPlaywright })),
}));

afterEach(() => {
  globalThis.fetch = originalFetch;
  createPageViaPlaywright.mockClear();
  vi.restoreAllMocks();
});

function openclawProfile(headless: boolean) {
  globalThis.fetch = withBrowserFetchPreconnect(
    vi.fn(async () => {
      throw new Error("browser identity unavailable");
    }),
  );
  const state = makeState("openclaw");
  const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
  state.profiles.get("openclaw")!.running = { ...mockLaunchedChrome(vi.fn(), 1234), headless };
  return openclaw;
}

describe("managed headless tab creation", () => {
  it("uses guarded Playwright page creation for the first navigation", async () => {
    const create = vi.spyOn(cdp, "createTargetViaCdp");
    const controller = new AbortController();

    await expect(
      openclawProfile(true).openTab("https://example.com", {
        signal: controller.signal,
        timeoutMs: 9000,
      }),
    ).resolves.toMatchObject({ targetId: "NEW", url: "https://example.com" });

    expect(createPageViaPlaywright).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:18800",
        url: "https://example.com",
        headless: true,
        signal: controller.signal,
        timeoutMs: 9000,
      }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps headed managed tabs on their existing CDP path", async () => {
    const create = vi.spyOn(cdp, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });

    await openclawProfile(false).openTab("https://example.com");

    expect(createPageViaPlaywright).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });
});
