import { describe, expect, it } from "vitest";
import { buildSkillHint, extractBinaryName, type SkillBinHint } from "./bash-tools.exec.js";

describe("extractBinaryName", () => {
  it("extracts simple command", () => {
    expect(extractBinaryName("gog gmail search 'newer_than:7d'")).toBe("gog");
  });

  it("extracts command with leading whitespace", () => {
    expect(extractBinaryName("  gog gmail search")).toBe("gog");
  });

  it("strips path prefix", () => {
    expect(extractBinaryName("/usr/local/bin/gog gmail search")).toBe("gog");
  });

  it("skips sudo prefix", () => {
    expect(extractBinaryName("sudo gog auth list")).toBe("gog");
  });

  it("skips env prefix", () => {
    expect(extractBinaryName("env gog auth list")).toBe("gog");
  });

  it("skips env var assignments", () => {
    expect(extractBinaryName("FOO=bar GOG_ACCOUNT=x gog gmail search")).toBe("gog");
  });

  it("skips nohup prefix", () => {
    expect(extractBinaryName("nohup gog gmail search")).toBe("gog");
  });

  it("skips combined prefixes", () => {
    expect(extractBinaryName("sudo env FOO=bar gog gmail send")).toBe("gog");
  });

  it("returns undefined for empty command", () => {
    expect(extractBinaryName("")).toBeUndefined();
  });

  it("returns undefined for only env vars", () => {
    expect(extractBinaryName("FOO=bar BAZ=qux")).toBeUndefined();
  });

  it("handles single-word command", () => {
    expect(extractBinaryName("ls")).toBe("ls");
  });
});

describe("buildSkillHint", () => {
  const hints: ReadonlyMap<string, SkillBinHint> = new Map([
    ["gog", { skillName: "gog", skillPath: "skills/gog/SKILL.md" }],
    ["himalaya", { skillName: "himalaya", skillPath: "skills/himalaya/SKILL.md" }],
  ]);

  it("returns hint when exit code is 127 and binary matches a skill", () => {
    const result = buildSkillHint("gog gmail search 'newer_than:7d'", 127, hints);
    expect(result).toContain('"gog"');
    expect(result).toContain("skills/gog/SKILL.md");
    expect(result).toContain("Read");
  });

  it("returns undefined when exit code is not 127", () => {
    expect(buildSkillHint("gog gmail search", 1, hints)).toBeUndefined();
    expect(buildSkillHint("gog gmail search", 0, hints)).toBeUndefined();
    expect(buildSkillHint("gog gmail search", null, hints)).toBeUndefined();
  });

  it("returns undefined when binary does not match any skill", () => {
    expect(buildSkillHint("unknown-tool --help", 127, hints)).toBeUndefined();
  });

  it("returns undefined when hints map is undefined", () => {
    expect(buildSkillHint("gog gmail search", 127, undefined)).toBeUndefined();
  });

  it("returns undefined when hints map is empty", () => {
    expect(buildSkillHint("gog gmail search", 127, new Map())).toBeUndefined();
  });

  it("matches binary through sudo prefix", () => {
    const result = buildSkillHint("sudo gog gmail search", 127, hints);
    expect(result).toContain('"gog"');
    expect(result).toContain("skills/gog/SKILL.md");
  });

  it("matches binary through env var assignment", () => {
    const result = buildSkillHint("GOG_ACCOUNT=x gog gmail search", 127, hints);
    expect(result).toContain('"gog"');
  });

  it("matches binary through path prefix", () => {
    const result = buildSkillHint("/usr/local/bin/gog gmail search", 127, hints);
    expect(result).toContain('"gog"');
  });

  it("works with different skill binaries", () => {
    const result = buildSkillHint("himalaya list", 127, hints);
    expect(result).toContain('"himalaya"');
    expect(result).toContain("skills/himalaya/SKILL.md");
  });
});
