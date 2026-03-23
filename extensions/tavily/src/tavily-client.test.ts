import { describe, expect, it } from "vitest";
import { __testing } from "./tavily-client.js";

describe("tavily client helpers", () => {
  it("appends endpoints to reverse-proxy base urls", () => {
    expect(__testing.resolveEndpoint("https://proxy.example/api/tavily", "/search")).toBe(
      "https://proxy.example/api/tavily/search",
    );
    expect(__testing.resolveEndpoint("https://proxy.example/api/tavily/", "/extract")).toBe(
      "https://proxy.example/api/tavily/extract",
    );
  });

  it("falls back to the default host for invalid base urls", () => {
    expect(__testing.resolveEndpoint("not a url", "/search")).toBe(
      "https://api.tavily.com/search",
    );
    expect(__testing.resolveEndpoint("", "/extract")).toBe("https://api.tavily.com/extract");
  });
});
