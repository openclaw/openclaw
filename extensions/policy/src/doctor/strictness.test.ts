// Policy doctor strictness helper tests.
import { describe, expect, it } from "vitest";
import { POLICY_RULE_METADATA } from "./metadata.js";
import { isPolicyValueAtLeastAsStrict } from "./strictness.js";

describe("policy doctor strictness", () => {
  it("compares policy values through strictness metadata", () => {
    const allowHosts = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.exec.allowHosts",
    );
    const denyTools = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.denyTools",
    );
    const fsWorkspaceOnly = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.fs.requireWorkspaceOnly",
    );
    const denyHostNetwork = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "sandbox.containers.denyHostNetwork",
    );
    const alsoAllow = POLICY_RULE_METADATA.find(
      (rule) => rule.policyPath.join(".") === "tools.alsoAllow.expected",
    );

    expect(allowHosts).toBeDefined();
    expect(denyTools).toBeDefined();
    expect(fsWorkspaceOnly).toBeDefined();
    expect(denyHostNetwork).toBeDefined();
    expect(alsoAllow).toBeDefined();
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, ["sandbox"], ["sandbox", "node"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, ["sandbox", "node"], ["sandbox"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, [], ["sandbox"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(allowHosts!, ["sandbox"], [])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["exec", "write"], ["exec"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["write"], ["exec"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["group:runtime"], ["exec"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyTools!, ["exec"], ["group:runtime"])).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(denyHostNetwork!, true, true)).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(denyHostNetwork!, false, true)).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(fsWorkspaceOnly!, true, true)).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(fsWorkspaceOnly!, false, true)).toBe(false);
    expect(isPolicyValueAtLeastAsStrict(alsoAllow!, ["read"], ["read"])).toBe(true);
    expect(isPolicyValueAtLeastAsStrict(alsoAllow!, [], ["read"])).toBe(false);
  });
});
