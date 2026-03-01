import { describe, expect, it } from "vitest";
import {
  isUrlAllowed,
  resolveAllowedHosts,
  resolveAuthAllowedHosts,
  resolveMediaSsrfPolicy,
} from "./shared.js";

describe("msteams attachment allowlists", () => {
  it("normalizes wildcard host lists", () => {
    expect(resolveAllowedHosts(["*", "graph.microsoft.com"])).toEqual(["*"]);
    expect(resolveAuthAllowedHosts(["*", "graph.microsoft.com"])).toEqual(["*"]);
  });

  it("requires https and host suffix match", () => {
    const allowHosts = resolveAllowedHosts(["sharepoint.com"]);
    expect(isUrlAllowed("https://contoso.sharepoint.com/file.png", allowHosts)).toBe(true);
    expect(isUrlAllowed("http://contoso.sharepoint.com/file.png", allowHosts)).toBe(false);
    expect(isUrlAllowed("https://evil.example.com/file.png", allowHosts)).toBe(false);
  });

  it("builds shared SSRF policy from suffix allowlist", () => {
    expect(resolveMediaSsrfPolicy(["sharepoint.com"])).toEqual({
      hostnameAllowlist: ["sharepoint.com", "*.sharepoint.com"],
    });
    expect(resolveMediaSsrfPolicy(["*"])).toBeUndefined();
  });
});
