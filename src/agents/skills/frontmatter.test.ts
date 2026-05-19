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

describe("resolveOpenClawMetadata setup parsing", () => {
  function resolveSetup(frontmatter: Record<string, string>) {
    return resolveOpenClawMetadata(frontmatter)?.setup;
  }

  it("parses setup.script from metadata", () => {
    const setup = resolveSetup({
      metadata: '{"openclaw":{"setup":{"script":"scripts/install.sh"}}}',
    });
    expect(setup).toEqual({ script: "scripts/install.sh" });
  });

  it("parses setup.script with timeoutMs", () => {
    const setup = resolveSetup({
      metadata: '{"openclaw":{"setup":{"script":"scripts/install.sh","timeoutMs":90000}}}',
    });
    expect(setup).toEqual({ script: "scripts/install.sh", timeoutMs: 90000 });
  });

  it("returns undefined when setup is absent", () => {
    const setup = resolveSetup({
      metadata: '{"openclaw":{"install":[{"kind":"brew","formula":"python@3.12"}]}}',
    });
    expect(setup).toBeUndefined();
  });

  it("returns undefined when setup.script is missing", () => {
    const setup = resolveSetup({
      metadata: '{"openclaw":{"setup":{"timeoutMs":5000}}}',
    });
    expect(setup).toBeUndefined();
  });

  it("rejects setup.script with .. path traversal", () => {
    const setup = resolveSetup({
      metadata: '{"openclaw":{"setup":{"script":"../outside.sh"}}}',
    });
    expect(setup).toBeUndefined();
  });

  it("rejects setup.script with absolute path", () => {
    const setup = resolveSetup({
      metadata: '{"openclaw":{"setup":{"script":"/etc/passwd"}}}',
    });
    expect(setup).toBeUndefined();
  });

  it("rejects empty setup.script", () => {
    const setup = resolveSetup({
      metadata: '{"openclaw":{"setup":{"script":""}}}',
    });
    expect(setup).toBeUndefined();
  });

  it("ignores non-numeric timeoutMs", () => {
    const setup = resolveSetup({
      metadata: '{"openclaw":{"setup":{"script":"run.sh","timeoutMs":"fast"}}}',
    });
    expect(setup).toEqual({ script: "run.sh" });
  });
});
