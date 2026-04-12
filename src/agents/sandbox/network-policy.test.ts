import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadNetworkPoliciesFile,
  loadNetworkPolicyForAgent,
  resolveNetworkModeForPolicy,
  type NetworkPolicyFile,
} from "./network-policy.js";

let tmpDir: string;
let policyPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "netpolicy-"));
  policyPath = join(tmpDir, "network-policies.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function write(file: NetworkPolicyFile) {
  writeFileSync(policyPath, JSON.stringify(file, null, 2), "utf8");
}

describe("loadNetworkPoliciesFile", () => {
  it("returns an empty file when the path does not exist", () => {
    const result = loadNetworkPoliciesFile(join(tmpDir, "missing.json"));
    expect(result).toEqual({ version: 1, policies: [] });
  });

  it("loads a valid policy file", () => {
    write({
      version: 1,
      policies: [
        { agentId: "quinn", mode: "open" },
        { agentId: "jack", mode: "none" },
      ],
    });
    const result = loadNetworkPoliciesFile(policyPath);
    expect(result.policies).toHaveLength(2);
    expect(result.policies[0].agentId).toBe("quinn");
  });

  it("loads a valid allowlist policy", () => {
    write({
      version: 1,
      policies: [
        {
          agentId: "nora",
          mode: "allowlist",
          allowedHosts: ["api.anthropic.com"],
        },
      ],
    });
    const result = loadNetworkPoliciesFile(policyPath);
    expect(result.policies[0].mode).toBe("allowlist");
    expect(result.policies[0].allowedHosts).toEqual(["api.anthropic.com"]);
  });

  it("throws on malformed JSON", () => {
    writeFileSync(policyPath, "{not valid json", "utf8");
    expect(() => loadNetworkPoliciesFile(policyPath)).toThrow(/not valid JSON/);
  });

  it("throws on missing agentId", () => {
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        policies: [{ mode: "open" }],
      }),
      "utf8",
    );
    expect(() => loadNetworkPoliciesFile(policyPath)).toThrow(/missing an agentId/);
  });

  it("throws on invalid mode", () => {
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        policies: [{ agentId: "q", mode: "bogus" }],
      }),
      "utf8",
    );
    expect(() => loadNetworkPoliciesFile(policyPath)).toThrow(/invalid mode/);
  });

  it("throws on allowlist mode without allowedHosts", () => {
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        policies: [{ agentId: "q", mode: "allowlist" }],
      }),
      "utf8",
    );
    expect(() => loadNetworkPoliciesFile(policyPath)).toThrow(/no allowedHosts/);
  });

  it("throws on allowlist with empty host strings", () => {
    writeFileSync(
      policyPath,
      JSON.stringify({
        version: 1,
        policies: [{ agentId: "q", mode: "allowlist", allowedHosts: [""] }],
      }),
      "utf8",
    );
    expect(() => loadNetworkPoliciesFile(policyPath)).toThrow(/non-string or empty/);
  });
});

describe("loadNetworkPolicyForAgent", () => {
  beforeEach(() => {
    write({
      version: 1,
      policies: [
        { agentId: "quinn", mode: "open" },
        { agentId: "jack", mode: "none" },
      ],
    });
  });

  it("returns null for an unknown agent", () => {
    expect(loadNetworkPolicyForAgent("nobody", policyPath)).toBeNull();
  });

  it("returns the policy for a known agent", () => {
    const policy = loadNetworkPolicyForAgent("quinn", policyPath);
    expect(policy).not.toBeNull();
    expect(policy!.mode).toBe("open");
  });

  it("is case-insensitive on agentId lookup", () => {
    const policy = loadNetworkPolicyForAgent("QUINN", policyPath);
    expect(policy).not.toBeNull();
    expect(policy!.agentId).toBe("quinn");
  });

  it("returns null for a blank agentId", () => {
    expect(loadNetworkPolicyForAgent("", policyPath)).toBeNull();
    expect(loadNetworkPolicyForAgent("   ", policyPath)).toBeNull();
  });
});

describe("resolveNetworkModeForPolicy", () => {
  it("returns default for a null policy", () => {
    const r = resolveNetworkModeForPolicy(null);
    expect(r.dockerNetwork).toBeNull();
    expect(r.needsProxyEnforcement).toBe(false);
  });

  it("returns 'none' for a none-mode policy", () => {
    const r = resolveNetworkModeForPolicy({ agentId: "jack", mode: "none" });
    expect(r.dockerNetwork).toBe("none");
    expect(r.needsProxyEnforcement).toBe(false);
    expect(r.note).toMatch(/outbound network disabled/);
  });

  it("returns null docker network for open mode", () => {
    const r = resolveNetworkModeForPolicy({ agentId: "quinn", mode: "open" });
    expect(r.dockerNetwork).toBeNull();
    expect(r.needsProxyEnforcement).toBe(false);
  });

  it("flags proxy-enforcement pending for allowlist mode", () => {
    const r = resolveNetworkModeForPolicy({
      agentId: "nora",
      mode: "allowlist",
      allowedHosts: ["api.anthropic.com", "api.hubspot.com"],
    });
    expect(r.dockerNetwork).toBeNull();
    expect(r.needsProxyEnforcement).toBe(true);
    expect(r.note).toMatch(/2 hosts/);
    expect(r.note).toMatch(/pending RI-028/);
  });
});
