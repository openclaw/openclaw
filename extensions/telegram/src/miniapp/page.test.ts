import { describe, expect, it } from "vitest";
import { renderTelegramMiniAppPage } from "./page.js";

describe("renderTelegramMiniAppPage", () => {
  it("builds the dashboard redirect from the authenticated payload", () => {
    const html = renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: "nonce" });

    expect(html).toContain('const accountId = "ops";');
    expect(html).toContain("new URL(payload.controlUiUrl)");
    expect(html).not.toContain("const controlUiUrl =");
  });

  it("escapes the nonce for its quoted HTML attribute", () => {
    const html = renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: `&<>"'` });

    expect(html).toContain('nonce="&amp;&lt;&gt;&quot;&#39;"');
  });

  it("cancels the response body on auth error before throwing", () => {
    const html = renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: "n" });

    expect(html).toContain("response.body?.cancel().catch(() => undefined)");
    expect(html).toContain('throw new Error("auth failed")');
    // body cancel appears before the throw
    const cancelIdx = html.indexOf("response.body?.cancel()");
    const throwIdx = html.indexOf('throw new Error("auth failed")');
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(throwIdx).toBeGreaterThan(cancelIdx);
  });
});
