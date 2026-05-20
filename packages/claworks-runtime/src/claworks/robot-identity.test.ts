import { describe, expect, it } from "vitest";
import {
  buildRobotIdentity,
  createRbacGuard,
  DEFAULT_RBAC_POLICIES,
  extractOwnerFromMd,
  extractRulesFromMd,
  type RbacPolicy,
} from "./robot-identity.js";

describe("extractRulesFromMd", () => {
  it("extracts numbered rules from robot.md", () => {
    const md = `# Robot\n## 核心规则\n1. First rule.\n2. Second rule.\n## 其他\nignored`;
    const rules = extractRulesFromMd(md);
    expect(rules).toEqual(["First rule.", "Second rule."]);
  });

  it("returns empty array when no rules section", () => {
    expect(extractRulesFromMd("# No rules here")).toEqual([]);
  });
});

describe("extractOwnerFromMd", () => {
  it("parses owner section from robot.md", () => {
    const md = `# Robot\n## Owner\nowner_id: user-001\nchannel_id: feishu\nshift_schedule: day\n`;
    expect(extractOwnerFromMd(md)).toEqual({
      ownerId: "user-001",
      channelId: "feishu",
      shiftSchedule: "day",
    });
  });
});

describe("buildRobotIdentity", () => {
  it("builds identity from defaults when no robot.md file exists", () => {
    const identity = buildRobotIdentity({
      robotName: "pump-robot",
      robotRole: "monolith",
      domain: "oilgas",
      stateDir: "/tmp/nonexistent-claworks-test-dir",
    });
    expect(identity.name).toBe("pump-robot");
    expect(identity.domain).toBe("oilgas");
    expect(identity.rules.length).toBeGreaterThan(0);
    expect(identity.agentMd).toContain("pump-robot");
  });
});

describe("createRbacGuard", () => {
  const policies: RbacPolicy[] = [...DEFAULT_RBAC_POLICIES];
  const guard = createRbacGuard(policies);

  it("allows system to publish events", () => {
    const result = guard.check({
      action: "event.publish",
      resource: "alarm.created",
      subjectType: "system",
      subjectId: "connector:opc",
    });
    expect(result.allowed).toBe(true);
  });

  it("allows apikey write", () => {
    const result = guard.check({
      action: "rest.write",
      resource: "workorder:*",
      subjectType: "apikey",
      subjectId: "apikey:abc123",
    });
    expect(result.allowed).toBe(true);
  });

  it("allows peer a2a delegation", () => {
    const result = guard.check({
      action: "a2a.delegate",
      resource: "diagnose",
      subjectType: "peer",
      subjectId: "pipeline-robot",
    });
    expect(result.allowed).toBe(true);
  });

  it("denies peer direct REST write", () => {
    const result = guard.check({
      action: "rest.write",
      resource: "workorder:*",
      subjectType: "peer",
      subjectId: "pipeline-robot",
    });
    expect(result.allowed).toBe(false);
  });

  it("allows channel_user to resolve HITL", () => {
    const result = guard.check({
      action: "hitl.resolve",
      resource: "run:123",
      subjectType: "channel_user",
      subjectId: "feishu:user001",
    });
    expect(result.allowed).toBe(true);
  });

  it("denies channel_user REST write", () => {
    const result = guard.check({
      action: "rest.write",
      resource: "workorder:*",
      subjectType: "channel_user",
      subjectId: "feishu:user001",
    });
    expect(result.allowed).toBe(false);
  });

  it("explicit deny overrides allow", () => {
    const customPolicies: RbacPolicy[] = [
      ...DEFAULT_RBAC_POLICIES,
      {
        id: "block-peer-x",
        action: "event.publish",
        resource: "alarm.*",
        subjectType: "peer",
        subjectId: "untrusted-peer",
        effect: "deny",
        priority: 200,
      },
    ];
    const g = createRbacGuard(customPolicies);
    const result = g.check({
      action: "event.publish",
      resource: "alarm.created",
      subjectType: "peer",
      subjectId: "untrusted-peer",
    });
    expect(result.allowed).toBe(false);
  });

  it("allows after reload with new policy", () => {
    const localPolicies: RbacPolicy[] = [];
    const g = createRbacGuard(localPolicies);
    // 空策略 + 非 system → deny
    expect(
      g.check({ action: "rest.write", resource: "*", subjectType: "apikey", subjectId: "k" })
        .allowed,
    ).toBe(false);

    g.reload([
      {
        id: "allow-all-api",
        action: "*",
        resource: "*",
        subjectType: "apikey",
        subjectId: "*",
        effect: "allow",
      },
    ]);
    expect(
      g.check({ action: "rest.write", resource: "*", subjectType: "apikey", subjectId: "k" })
        .allowed,
    ).toBe(true);
  });
});
