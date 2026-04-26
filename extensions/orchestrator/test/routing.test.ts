import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_ROUTING_CONFIG } from "../src/routing.config-default.js";
import { RoutingLoadError, decide, findShadowingMatches, loadConfig } from "../src/routing.js";
import type { CompiledRoutingConfig } from "../src/routing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "fixtures");

let tmpRoot: string;
let agentsDir: string;
let configPath: string;

function makeAgent(name: string): void {
  mkdirSync(join(agentsDir, name), { recursive: true });
}

function writeConfig(json: unknown): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(json, null, 2));
}

function compile(config: typeof DEFAULT_ROUTING_CONFIG): CompiledRoutingConfig {
  return {
    schemaVersion: 1,
    rules: config.rules.map((rule) => ({
      ...rule,
      regex: new RegExp(rule.pattern, "i"),
    })),
    default: config.default,
    approvalRequired: config.approvalRequired,
    approvalRequiredCapabilities: config.approvalRequiredCapabilities,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orchestrator-routing-"));
  agentsDir = join(tmpRoot, "agents");
  configPath = join(tmpRoot, "routing.json");
  mkdirSync(agentsDir, { recursive: true });
  for (const id of [
    "main",
    "coder",
    "helpdesk",
    "researcher",
    "overwatch",
    "design-ui-designer",
    "gemini-flash-lite",
  ]) {
    makeAgent(id);
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("creates default config when file is missing", () => {
    const { config, warnings } = loadConfig({
      path: configPath,
      agentsDir,
    });
    expect(config.rules.length).toBe(DEFAULT_ROUTING_CONFIG.rules.length);
    expect(warnings).toEqual([]);
  });

  test("rejects schemaVersion drift", () => {
    writeConfig({ ...DEFAULT_ROUTING_CONFIG, schemaVersion: 2 });
    expect(() => loadConfig({ path: configPath, agentsDir })).toThrow(RoutingLoadError);
  });

  test("rejects non-JSON content", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{ not json");
    expect(() => loadConfig({ path: configPath, agentsDir })).toThrow(/not valid JSON/);
  });

  test("skips invalid regex with a warning, keeps the good rule", () => {
    const { config, warnings } = loadConfig({
      path: resolve(FIXTURES, "routing.malformed.json"),
      agentsDir,
    });
    expect(config.rules.map((r) => r.id)).toEqual(["good-rule"]);
    expect(warnings.find((w) => w.ruleId === "bad-regex")).toBeDefined();
  });

  test("throws when default.agent is missing on disk", () => {
    writeConfig({
      ...DEFAULT_ROUTING_CONFIG,
      default: { agent: "ghost", requireApproval: false },
    });
    expect(() => loadConfig({ path: configPath, agentsDir })).toThrow(/default agent "ghost"/);
  });

  test("warns (not throws) when a rule.agent is missing on disk", () => {
    writeConfig({
      ...DEFAULT_ROUTING_CONFIG,
      rules: [
        {
          id: "ghost-rule",
          pattern: "anything",
          capabilities: [],
          agent: "ghost",
          priority: 1,
        },
      ],
    });
    const { warnings } = loadConfig({ path: configPath, agentsDir });
    expect(warnings.find((w) => w.ruleId === "ghost-rule")).toBeDefined();
  });

  test("throws when no rules can be compiled", () => {
    writeConfig({
      ...DEFAULT_ROUTING_CONFIG,
      rules: [
        {
          id: "all-broken",
          pattern: "[unterminated",
          capabilities: [],
          agent: "main",
          priority: 1,
        },
      ],
    });
    expect(() => loadConfig({ path: configPath, agentsDir })).toThrow(/no routable rules/);
  });

  test("skipAgentValidation bypasses fs checks", () => {
    writeConfig({
      ...DEFAULT_ROUTING_CONFIG,
      default: { agent: "ghost", requireApproval: false },
    });
    const { config } = loadConfig({
      path: configPath,
      skipAgentValidation: true,
    });
    expect(config.default.agent).toBe("ghost");
  });
});

describe("decide", () => {
  const compiled = compile(DEFAULT_ROUTING_CONFIG);

  test("each default rule matches its representative goal", () => {
    const cases: Array<[string, string]> = [
      ["please debug this function", "coder"],
      ["deploy the new version", "helpdesk"],
      ["research the literature on X", "researcher"],
      ["draft an email reply", "main"],
      ["design the new ui", "design-ui-designer"],
      ["plan the breakdown", "main"],
      ["audit the recent change", "overwatch"],
      ["give me a quick tldr", "gemini-flash-lite"],
    ];
    for (const [goal, expected] of cases) {
      const decision = decide(goal, [], compiled);
      expect(decision.assignedAgentId, `goal: "${goal}"`).toBe(expected);
      expect(decision.fallbackUsed).toBe(false);
    }
  });

  test("falls back to default when no rule matches", () => {
    const decision = decide("xyzzy nothing here", [], compiled);
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.assignedAgentId).toBe(DEFAULT_ROUTING_CONFIG.default.agent);
    expect(decision.matchedRuleId).toBeNull();
  });

  test("higher priority wins over lower", () => {
    const decision = decide("debug the deploy", [], compiled);
    expect(["coder", "helpdesk"]).toContain(decision.assignedAgentId);
  });

  test("capability filter requires the rule's caps to be a subset of task's", () => {
    const ruleNeedsCode: CompiledRoutingConfig = compile({
      ...DEFAULT_ROUTING_CONFIG,
      rules: [
        {
          id: "needs-code",
          pattern: "task",
          capabilities: ["code"],
          agent: "coder",
          priority: 5,
        },
      ],
    });
    expect(decide("task", ["code", "ops"], ruleNeedsCode).matchedRuleId).toBe("needs-code");
    expect(decide("task", ["ops"], ruleNeedsCode).matchedRuleId).toBeNull();
  });

  test("empty rule capabilities matches regardless of task capabilities", () => {
    const config = compile({
      ...DEFAULT_ROUTING_CONFIG,
      rules: [
        {
          id: "open",
          pattern: "task",
          capabilities: [],
          agent: "main",
          priority: 5,
        },
      ],
    });
    expect(decide("task", [], config).matchedRuleId).toBe("open");
    expect(decide("task", ["unrelated"], config).matchedRuleId).toBe("open");
  });

  test("regex matching is case-insensitive", () => {
    const decision = decide("PLEASE DEBUG", [], compiled);
    expect(decision.assignedAgentId).toBe("coder");
  });

  test("empty goal falls to default", () => {
    expect(decide("", [], compiled).fallbackUsed).toBe(true);
  });

  test("8 KB goal still routes deterministically", () => {
    const goal = `debug ${"x".repeat(8 * 1024)}`;
    const decision = decide(goal, [], compiled);
    expect(decision.matchedRuleId).toBe("code-tasks");
  });

  test("first-rule-in-array wins among same-priority shadow matches", () => {
    const { config } = loadConfig({
      path: resolve(FIXTURES, "routing.shadowing.json"),
      agentsDir,
    });
    const decision = decide("ping", [], config);
    expect(decision.matchedRuleId).toBe("first-shadow");
    const others = findShadowingMatches("ping", [], config, "first-shadow");
    expect(others.map((r) => r.id)).toEqual(["second-shadow"]);
  });
});
