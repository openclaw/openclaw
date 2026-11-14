import { describe, expect, it } from "vitest";
import { parseModelCatalogJson } from "./model-catalog-json.js";

describe("model catalog JSON", () => {
  it("preserves quoted content in strict and authored catalogs", () => {
    const catalog = {
      providers: {
        fixture: {
          baseUrl: "https://example.test/v1",
          models: [{ id: 'quoted"//,}', name: "line\nnext" }],
        },
      },
    };
    const strict = JSON.stringify(catalog);
    const authored = `// catalog comment\n${strict.slice(0, -1)},}`;
    expect(parseModelCatalogJson(strict, true)).toEqual(catalog);
    expect(parseModelCatalogJson(authored, true)).toEqual(catalog);
    expect(parseModelCatalogJson(authored)).toEqual(catalog);
  });

  it("rejects malformed generated catalogs after the authored syntax fallback", () => {
    const malformed = '{"providers": // missing value\n}';
    expect(() => parseModelCatalogJson(malformed, true)).toThrow(SyntaxError);
    expect(() => parseModelCatalogJson(malformed)).toThrow(SyntaxError);
  });
});
