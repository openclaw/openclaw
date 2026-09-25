import { afterEach, describe, expect, it, vi } from "vitest";

const { listPagesViaPlaywright } = vi.hoisted(() => ({ listPagesViaPlaywright: vi.fn() }));
vi.mock("./pw-ai.js", () => ({ pwAi: { listPagesViaPlaywright } }));

import { getPwAiModule } from "./pw-ai-module.js";

afterEach(() => listPagesViaPlaywright.mockReset());

describe("Playwright module CDP defaults", () => {
  it("preserves attach-only browser defaults on every option-based CDP call", async () => {
    const pw = await getPwAiModule({ noDefaults: true });

    await pw?.listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    expect(listPagesViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      noDefaults: true,
    });
  });

  it("leaves managed-browser options untouched", async () => {
    const pw = await getPwAiModule();

    await pw?.listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    expect(listPagesViaPlaywright).toHaveBeenCalledWith({ cdpUrl: "http://127.0.0.1:9222" });
  });

  it("enables stale download-policy recovery only for an explicit profile opt-in", async () => {
    const pw = await getPwAiModule({
      noDefaults: true,
      resetDefaultDownloadBehaviorOnAttach: true,
    });

    await pw?.listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    expect(listPagesViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      noDefaults: true,
      resetDefaultDownloadBehaviorOnAttach: true,
    });
  });
});
