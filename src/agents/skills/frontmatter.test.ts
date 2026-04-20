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

describe("resolveOpenClawMetadata planTemplate (Codex P1 r3096435164)", () => {
  it("parses kebab-case `plan-template` key (legacy)", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"plan-template":[{"step":"Tag release"},{"step":"Publish"}]}}',
    });
    expect(meta?.planTemplate).toEqual([{ step: "Tag release" }, { step: "Publish" }]);
  });

  it("parses camelCase `planTemplate` key (natural — was silently ignored)", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"planTemplate":[{"step":"Tag release"},{"step":"Publish"}]}}',
    });
    expect(meta?.planTemplate).toEqual([{ step: "Tag release" }, { step: "Publish" }]);
  });

  it("kebab-case wins on conflict (backward compat)", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"plan-template":[{"step":"Old"}],"planTemplate":[{"step":"New"}]}}',
    });
    expect(meta?.planTemplate).toEqual([{ step: "Old" }]);
  });

  // PR-E review fix (Copilot #3105043876): when kebab-case key is
  // PRESENT but parses to an empty array (invalid shape), fall back to
  // the camelCase key. The prior `??` only triggered on null/undefined,
  // so a malformed kebab-case value silently dropped a valid camelCase
  // template.
  it("falls back to camelCase when kebab-case is invalid (string instead of array)", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"plan-template":"not-an-array","planTemplate":[{"step":"Valid"}]}}',
    });
    expect(meta?.planTemplate).toEqual([{ step: "Valid" }]);
  });

  it("falls back to camelCase when kebab-case has only invalid step entries", () => {
    const meta = resolveOpenClawMetadata({
      metadata:
        '{"openclaw":{"plan-template":[{"step":42},{"step":null}],"planTemplate":[{"step":"Valid"}]}}',
    });
    expect(meta?.planTemplate).toEqual([{ step: "Valid" }]);
  });

  // PR-E review fix (Copilot #3096524315 / #3105043896): accept `content`
  // as an alias for `step` so users following the PR description's
  // example don't get silently-empty templates.
  it("accepts `content` as alias for `step` in plan template entries", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"planTemplate":[{"content":"Build"},{"content":"Deploy"}]}}',
    });
    expect(meta?.planTemplate).toEqual([{ step: "Build" }, { step: "Deploy" }]);
  });

  it("`step` wins over `content` on conflict in the same entry", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"planTemplate":[{"step":"Real","content":"Ignored"}]}}',
    });
    expect(meta?.planTemplate).toEqual([{ step: "Real" }]);
  });

  it("returns undefined planTemplate when neither key is present", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"primaryEnv":"node"}}',
    });
    expect(meta?.planTemplate).toBeUndefined();
  });
});
