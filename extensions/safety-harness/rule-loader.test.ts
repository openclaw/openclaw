import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadRulesFromYaml, parseRulesYaml } from "./rule-loader.js";

describe("parseRulesYaml", () => {
  it("parses valid YAML rules", () => {
    const yaml = `
rules:
  - tool: "email.send"
    tier: confirm
    reason: "Confirm email sends"
  - tool: "calendar.*"
    when:
      count: ">5"
    tier: block
    reason: "Too many calendar ops"
`;
    const rules = parseRulesYaml(yaml);
    expect(rules).toHaveLength(2);
    expect(rules[0].tool).toBe("email.send");
    expect(rules[0].tier).toBe("confirm");
    expect(rules[1].when?.count).toBe(">5");
  });

  it("returns empty array for invalid YAML", () => {
    const rules = parseRulesYaml("not: valid: yaml: [");
    expect(rules).toEqual([]);
  });

  it("returns empty array for missing rules key", () => {
    const rules = parseRulesYaml("other_key: value");
    expect(rules).toEqual([]);
  });
});

describe("loadRulesFromYaml", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-rules-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads rules from a YAML file", () => {
    const filePath = path.join(tmpDir, "rules.yaml");
    fs.writeFileSync(
      filePath,
      `
rules:
  - tool: "email.delete"
    tier: confirm
    reason: "Confirm deletes"
`,
    );
    const rules = loadRulesFromYaml(filePath);
    expect(rules).toHaveLength(1);
    expect(rules[0].tool).toBe("email.delete");
  });

  it("returns empty array if file does not exist", () => {
    const rules = loadRulesFromYaml("/nonexistent/path.yaml");
    expect(rules).toEqual([]);
  });
});
