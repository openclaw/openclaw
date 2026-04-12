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

describe("resolveOpenClawMetadata cert_tier extraction (RI-030 Block 1.5)", () => {
  it("parses certTier camelCase key", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"certTier":"certified"}}',
    });
    expect(meta?.certTier).toBe("certified");
  });

  it("parses cert_tier snake_case key", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"cert_tier":"verified"}}',
    });
    expect(meta?.certTier).toBe("verified");
  });

  it("accepts unverified tier", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"certTier":"unverified"}}',
    });
    expect(meta?.certTier).toBe("unverified");
  });

  it("normalizes case (CERTIFIED → certified)", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"certTier":"CERTIFIED"}}',
    });
    expect(meta?.certTier).toBe("certified");
  });

  it("returns undefined for unknown tier strings", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"certTier":"experimental"}}',
    });
    expect(meta?.certTier).toBeUndefined();
  });

  it("returns undefined when certTier is missing (backwards compatibility)", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"primaryEnv":"ANTHROPIC_API_KEY"}}',
    });
    expect(meta?.certTier).toBeUndefined();
  });
});

describe("resolveOpenClawMetadata version/variant/experiment extraction (RI-014)", () => {
  it("parses semver version field", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"version":"1.2.3"}}',
    });
    expect(meta?.version).toBe("1.2.3");
  });

  it("accepts semver with pre-release suffix", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"version":"1.1.0-experimental"}}',
    });
    expect(meta?.version).toBe("1.1.0-experimental");
  });

  it("drops non-semver version strings", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"version":"v2"}}',
    });
    expect(meta?.version).toBeUndefined();
  });

  it("parses variantId and experimentId in camelCase", () => {
    const meta = resolveOpenClawMetadata({
      metadata:
        '{"openclaw":{"variantId":"v2","experimentId":"exp-42"}}',
    });
    expect(meta?.variantId).toBe("v2");
    expect(meta?.experimentId).toBe("exp-42");
  });

  it("parses variant_id and experiment_id in snake_case", () => {
    const meta = resolveOpenClawMetadata({
      metadata:
        '{"openclaw":{"variant_id":"control","experiment_id":"exp-99"}}',
    });
    expect(meta?.variantId).toBe("control");
    expect(meta?.experimentId).toBe("exp-99");
  });

  it("returns undefined when version/variant/experiment are absent", () => {
    const meta = resolveOpenClawMetadata({
      metadata: '{"openclaw":{"primaryEnv":"X"}}',
    });
    expect(meta?.version).toBeUndefined();
    expect(meta?.variantId).toBeUndefined();
    expect(meta?.experimentId).toBeUndefined();
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
