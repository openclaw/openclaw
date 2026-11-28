import { describe, expect, it } from "vitest";
import { isSameMemoryEmbeddingEndpoint } from "./manager-embedding-refusal.js";

const endpoint = (headers: unknown) => ({
  provider: "openai",
  baseUrl: "https://proxy.example/v1",
  model: "text-embedding-3-small",
  headers,
});

describe("isSameMemoryEmbeddingEndpoint", () => {
  // The native OpenAI adapter publishes [name, value] pairs; the generic adapter a record.
  it.each([
    ["pairs", [["x-tenant", "a"]], [["x-tenant", "b"]]],
    ["records", { "x-tenant": "a" }, { "x-tenant": "b" }],
  ])("tells routing headers apart in %s", (_shape, tenantA, tenantB) => {
    expect(isSameMemoryEmbeddingEndpoint(endpoint(tenantA), endpoint(tenantA))).toBe(true);
    expect(isSameMemoryEmbeddingEndpoint(endpoint(tenantA), endpoint(tenantB))).toBe(false);
  });

  it("ignores header order", () => {
    expect(
      isSameMemoryEmbeddingEndpoint(
        endpoint([
          ["x-a", "1"],
          ["x-b", "2"],
        ]),
        endpoint([
          ["x-b", "2"],
          ["x-a", "1"],
        ]),
      ),
    ).toBe(true);
  });
});
