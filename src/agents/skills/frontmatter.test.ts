import { describe, expect, it } from "vitest";
import {
  parseTriggersFromFrontmatter,
  resolveOpenClawMetadata,
  resolveSkillInvocationPolicy,
} from "./frontmatter.js";

describe("parseTriggersFromFrontmatter", () => {
  it("returns [] when triggers key is absent", () => {
    expect(parseTriggersFromFrontmatter({})).toEqual([]);
  });

  it("parses comma-separated string", () => {
    expect(parseTriggersFromFrontmatter({ triggers: "buy, order, checkout" })).toEqual([
      "buy",
      "order",
      "checkout",
    ]);
  });

  it("trims whitespace from comma-separated values", () => {
    expect(parseTriggersFromFrontmatter({ triggers: " buy , order " })).toEqual(["buy", "order"]);
  });

  it("parses JSON array string (YAML inline array round-trip)", () => {
    // parseFrontmatterBlock JSON-stringifies YAML arrays via coerceYamlFrontmatterValue
    expect(parseTriggersFromFrontmatter({ triggers: '["buy","order","checkout"]' })).toEqual([
      "buy",
      "order",
      "checkout",
    ]);
  });

  it("falls back to comma-split when JSON parse fails", () => {
    expect(parseTriggersFromFrontmatter({ triggers: "[broken" })).toEqual(["[broken"]);
  });

  it("filters out empty strings", () => {
    expect(parseTriggersFromFrontmatter({ triggers: "buy,,order" })).toEqual(["buy", "order"]);
  });
});

describe("resolveSkillInvocationPolicy", () => {
  it("defaults to enabled behaviors", () => {
    const policy = resolveSkillInvocationPolicy({});
    expect(policy.userInvocable).toBe(true);
    expect(policy.disableModelInvocation).toBe(false);
  });

  it("parses frontmatter boolean strings", () => {
    const policy = resolveSkillInvocationPolicy({
      "user-invocable": "no",
      "disable-model-invocation": "yes",
    });
    expect(policy.userInvocable).toBe(false);
    expect(policy.disableModelInvocation).toBe(true);
  });
});

describe("resolveOpenClawMetadata install validation", () => {
  function resolveInstall(frontmatter: Record<string, string>) {
    return resolveOpenClawMetadata(frontmatter)?.install;
  }

  it("accepts safe install specs", () => {
    const install = resolveInstall({
      metadata:
        '{"openclaw":{"install":[{"kind":"brew","formula":"python@3.12"},{"kind":"node","package":"@scope/pkg@1.2.3"},{"kind":"go","module":"example.com/tool/cmd@v1.2.3"},{"kind":"uv","package":"uvicorn[standard]==0.31.0"},{"kind":"download","url":"https://example.com/tool.tar.gz"}]}}',
    });
    expect(install).toEqual([
      { kind: "brew", formula: "python@3.12" },
      { kind: "node", package: "@scope/pkg@1.2.3" },
      { kind: "go", module: "example.com/tool/cmd@v1.2.3" },
      { kind: "uv", package: "uvicorn[standard]==0.31.0" },
      { kind: "download", url: "https://example.com/tool.tar.gz" },
    ]);
  });

  it("drops unsafe brew formula values", () => {
    const install = resolveInstall({
      metadata: '{"openclaw":{"install":[{"kind":"brew","formula":"wget --HEAD"}]}}',
    });
    expect(install).toBeUndefined();
  });

  it("drops unsafe npm package specs for node installers", () => {
    const install = resolveInstall({
      metadata: '{"openclaw":{"install":[{"kind":"node","package":"file:../malicious"}]}}',
    });
    expect(install).toBeUndefined();
  });

  it("drops unsafe go module specs", () => {
    const install = resolveInstall({
      metadata: '{"openclaw":{"install":[{"kind":"go","module":"https://evil.example/mod"}]}}',
    });
    expect(install).toBeUndefined();
  });

  it("drops unsafe download urls", () => {
    const install = resolveInstall({
      metadata: '{"openclaw":{"install":[{"kind":"download","url":"file:///tmp/payload.tgz"}]}}',
    });
    expect(install).toBeUndefined();
  });
});
