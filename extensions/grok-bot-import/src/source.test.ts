import { describe, expect, it } from "vitest";
import { parseGrokBotUrl, shareIdFromMarketplaceHtml } from "./source.js";

describe("Grok import sources", () => {
  it("recognizes the marketplace, share, and native app links for the same bot", () => {
    expect(parseGrokBotUrl("https://x.ai/bot/marketplace/bots/stalk-bot")).toEqual({
      kind: "marketplace",
      url: "https://x.ai/bot/marketplace/bots/stalk-bot",
    });
    expect(parseGrokBotUrl("https://x.ai/bot/Y7iWVNiPdorgu6oFY-PRG")).toEqual({
      kind: "share",
      shareId: "Y7iWVNiPdorgu6oFY-PRG",
    });
    expect(parseGrokBotUrl("grokbot://app/v1/bot-template?id=Y7iWVNiPdorgu6oFY-PRG")).toEqual({
      kind: "share",
      shareId: "Y7iWVNiPdorgu6oFY-PRG",
    });
  });
  it("resolves the actual import link rather than a creator image or marketplace summaries", () => {
    expect(
      shareIdFromMarketplaceHtml(
        '<a href="/bot/marketplace">Back</a><a href="/bot/guides">Guides</a><a href="/bot/use-cases">Use cases</a><script>{"addHref":"/bot/Y7iWVNiPdorgu6oFY-PRG"}</script>',
      ),
    ).toBe("Y7iWVNiPdorgu6oFY-PRG");
    expect(() => shareIdFromMarketplaceHtml('<script>"skills":[]</script>')).toThrow(
      /import link/i,
    );
    expect(() =>
      shareIdFromMarketplaceHtml('[{"addHref":"/bot/aaa"},{"addHref":"/bot/bbb"}]'),
    ).toThrow(/ambiguous/i);
  });
  it.each([
    "http://x.ai/bot/abc",
    "https://x.ai.evil.test/bot/abc",
    "https://user:pass@x.ai/bot/abc",
    "https://x.ai:8443/bot/abc",
    "https://x.ai/bot/../secret",
    "grokbot://evil/v1/bot-template?id=abc",
    "https://x.ai/bot/marketplace",
  ])("rejects a non-bot source %s", (value) => {
    expect(() => parseGrokBotUrl(value)).toThrow(/Grok/i);
  });
});
