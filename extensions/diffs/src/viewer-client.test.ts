import { describe, expect, it } from "vitest";
import { filterSupportedHydrationLanguages } from "./viewer-client.js";

describe("filterSupportedHydrationLanguages", () => {
  it("keeps supported languages", async () => {
    await expect(filterSupportedHydrationLanguages(["typescript", "text"])).resolves.toEqual([
      "typescript",
      "text",
    ]);
  });

  it("drops invalid languages and falls back to text", async () => {
    await expect(
      filterSupportedHydrationLanguages(["not-a-real-language" as unknown as "text"]),
    ).resolves.toEqual(["text"]);
  });

  it("keeps valid languages when invalid hints are mixed in", async () => {
    await expect(
      filterSupportedHydrationLanguages(["typescript", "not-a-real-language" as unknown as "text"]),
    ).resolves.toEqual(["typescript"]);
  });
});
