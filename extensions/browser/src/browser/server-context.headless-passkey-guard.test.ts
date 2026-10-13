import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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

const { prepareHeadlessPasskeyGuard } = vi.hoisted(() => ({
  prepareHeadlessPasskeyGuard: vi.fn(async (_opts: { cdpUrl: string; signal?: AbortSignal }) => ({
    firstDocumentScript: "GUARD",
  })),
}));

vi.mock("./pw-ai-module.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-ai-module.js")>()),
  getPwAiModule: vi.fn(async () => ({ prepareHeadlessPasskeyGuard })),
}));

afterEach(() => {
  globalThis.fetch = originalFetch;
  prepareHeadlessPasskeyGuard.mockClear();
  vi.restoreAllMocks();
});

function openclawProfile(headless: boolean) {
  globalThis.fetch = withBrowserFetchPreconnect(
    vi.fn(async () => {
      throw new Error("unexpected discovery or cleanup");
    }),
  );
  const state = makeState("openclaw");
  const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile("openclaw");
  state.profiles.get("openclaw")!.running = { ...mockLaunchedChrome(vi.fn(), 1234), headless };
  return openclaw;
}

describe("headless passkey guard for tabs opened over raw CDP", () => {
  it("creates the tab only after the guard step settles, with the script for its first page", async () => {
    const guardStarted = createDeferred<void>();
    const guardDone = createDeferred<void>();
    prepareHeadlessPasskeyGuard.mockImplementationOnce(async () => {
      guardStarted.resolve();
      await guardDone.promise;
      return { firstDocumentScript: "GUARD" };
    });
    const create = vi.spyOn(cdp, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });
    const controller = new AbortController();

    const opening = openclawProfile(true).openTab("https://example.com", {
      signal: controller.signal,
    });
    await guardStarted.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(create).not.toHaveBeenCalled();
    expect(prepareHeadlessPasskeyGuard).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cdpUrl: "http://127.0.0.1:18800", signal: controller.signal }),
    );

    guardDone.resolve();
    await expect(opening).resolves.toMatchObject({ targetId: "NEW" });
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ url: "https://example.com", firstDocumentScript: "GUARD" }),
    );
  });

  it("leaves a headed browser's tab creation unchanged", async () => {
    const create = vi.spyOn(cdp, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });

    await openclawProfile(false).openTab("https://example.com");

    expect(prepareHeadlessPasskeyGuard).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("firstDocumentScript");
  });
});
