import { describe, expect, it } from "vitest";
import { resolveOpenClawMetadata, resolveSkillInvocationPolicy } from "./frontmatter.js";

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

describe("resolveOpenClawMetadata references parsing", () => {
  function resolveRefs(frontmatter: Record<string, string>) {
    return resolveOpenClawMetadata(frontmatter)?.references;
  }

  it("parses autoLoad and onDemand lists", () => {
    const refs = resolveRefs({
      metadata: '{"openclaw":{"references":{"autoLoad":["a.md","b.md"],"onDemand":["c.md"]}}}',
    });
    expect(refs).toEqual({
      autoLoad: ["a.md", "b.md"],
      onDemand: ["c.md"],
    });
  });

  it("parses autoLoad only", () => {
    const refs = resolveRefs({
      metadata: '{"openclaw":{"references":{"autoLoad":["guide.md"]}}}',
    });
    expect(refs).toEqual({ autoLoad: ["guide.md"] });
  });

  it("returns undefined references when not specified", () => {
    const refs = resolveRefs({
      metadata: '{"openclaw":{"always":true}}',
    });
    expect(refs).toBeUndefined();
  });

  it("returns undefined references when references block is empty", () => {
    const refs = resolveRefs({
      metadata: '{"openclaw":{"references":{}}}',
    });
    expect(refs).toBeUndefined();
  });

  it("handles comma-separated string for autoLoad", () => {
    const refs = resolveRefs({
      metadata: '{"openclaw":{"references":{"autoLoad":"a.md, b.md"}}}',
    });
    expect(refs).toEqual({ autoLoad: ["a.md", "b.md"] });
  });
});
