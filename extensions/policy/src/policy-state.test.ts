import { describe, expect, it } from "vitest";
import { scanPolicySandboxPosture } from "./policy-state-sandbox.js";
import { scanPolicyToolPosture } from "./policy-state-tool-posture.js";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
} from "./policy-state.js";

const scanPolicyChannels = (cfg: Record<string, unknown>) => collectPolicyEvidence(cfg).channels;

const scanPolicyTools = (...lines: string[]) =>
  collectPolicyEvidence({}, { toolsRaw: ["## Tools", ...lines].join("\n") }).tools ?? [];

const scanPolicyExecApprovals = (config: Record<string, unknown>) =>
  collectPolicyEvidence({}, { execApprovalsRaw: JSON.stringify(config) }).execApprovals ?? [];

const partial = (value: Record<string, unknown>) => expect.objectContaining(value);
function expectIncludes(actual: unknown, ...entries: Record<string, unknown>[]) {
  expect(actual).toEqual(expect.arrayContaining(entries.map((entry) => partial(entry))));
}
const agentSource = "oc://openclaw.config/agents/entries/guest";
const execSource = "oc://openclaw.config/agents/entries/reviewer/tools/exec";
function execEntry(kind: "Security" | "Ask", value: string, source: string, explicit?: true) {
  return {
    id: `reviewer-exec-${kind.toLowerCase()}`,
    kind: `exec${kind}`,
    value,
    source,
    ...(explicit === undefined ? {} : { explicit }),
  };
}
const guestEntry = (source: string, fields: Record<string, unknown>) => ({
  scope: "agent",
  agentId: "guest",
  source: `${agentSource}/${source}`,
  ...fields,
});
const approvalEntry = (index: number, pattern: string, sourceIndex: number) =>
  partial({
    id: `agent:main:allowlist:${index}`,
    kind: "allowlist",
    agentId: "main",
    pattern,
    source: `oc://exec-approvals.json/agents/main/allowlist/#${sourceIndex}`,
  });

describe("configured agent scanning", () => {
  it.each([
    {
      agents: { entries: { malformed: null, guest: { sandbox: { mode: "all" } } } },
      source: "oc://openclaw.config/agents/entries/guest/sandbox/mode",
    },
    {
      agents: { list: [null, { id: "guest", sandbox: { mode: "all" } }] },
      source: "oc://openclaw.config/agents/list/#1/sandbox/mode",
    },
  ])(
    "ignores malformed agents without renumbering their sources ($source)",
    ({ agents, source }) => {
      const evidence = collectPolicyEvidence({ agents });
      expectIncludes(
        evidence.sandboxPosture?.filter((entry) => entry.scope === "agent"),
        { agentId: "guest", kind: "mode", value: "all", source },
      );
      const workspaces = evidence.agentWorkspace?.filter((entry) => entry.scope === "agent");
      expect(new Set(workspaces?.map((entry) => entry.agentId))).toEqual(new Set(["guest"]));
    },
  );

  const keyedConfig = {
    tools: { elevated: { enabled: true } },
    agents: {
      defaults: { sandbox: { mode: "off" } },
      entries: {
        guest: {
          models: { "openai/gpt-5.6-luna": {} },
          sandbox: { mode: "all", workspaceAccess: "none" },
          tools: { deny: ["exec"], elevated: { enabled: false } },
        },
      },
    },
  };

  it("uses agents.entries across policy evidence", () => {
    const evidence = collectPolicyEvidence(keyedConfig);
    expectIncludes(
      evidence.sandboxPosture,
      guestEntry("sandbox/mode", { kind: "mode", value: "all" }),
    );
    expectIncludes(evidence.toolPosture, guestEntry("tools/elevated/enabled", { value: false }));
    expectIncludes(
      evidence.agentWorkspace,
      guestEntry("sandbox/workspaceAccess", { value: "none" }),
    );
    expect(evidence.modelRefs).toContainEqual({
      ref: "openai/gpt-5.6-luna",
      provider: "openai",
      model: "gpt-5.6-luna",
      source: `${agentSource}/models/"openai/gpt-5.6-luna"`,
    });
  });

  it("still uses legacy agents.list across policy evidence", () => {
    const evidence = collectPolicyEvidence({
      agents: {
        defaults: { sandbox: { mode: "off" } },
        list: [{ id: "legacy", models: { "openai/gpt-5.6-luna": {} }, sandbox: { mode: "all" } }],
      },
    });
    expectIncludes(evidence.sandboxPosture, {
      kind: "mode",
      scope: "agent",
      agentId: "legacy",
      value: "all",
      source: "oc://openclaw.config/agents/list/#0/sandbox/mode",
    });
    expect(evidence.modelRefs).toContainEqual(
      partial({
        ref: "openai/gpt-5.6-luna",
        source: 'oc://openclaw.config/agents/list/#0/models/"openai/gpt-5.6-luna"',
      }),
    );
  });

  it("keeps attestations stable across keyed entry order", () => {
    const first = {
      alpha: { models: { "openai/gpt-5.6-luna": {} } },
      omega: { models: { "openai/gpt-5.6-luna": {} } },
    };
    const attestationHash = (entries: Record<string, unknown>) =>
      createPolicyAttestation({
        ok: true,
        checkedAt: new Date(0).toISOString(),
        policyPath: "policy.jsonc",
        policyHash: policyDocumentHash({}),
        evidence: collectPolicyEvidence({ agents: { entries } }),
        findings: [],
      }).attestationHash;

    expect(attestationHash(first)).toBe(
      attestationHash({ omega: first.omega, alpha: first.alpha }),
    );
  });
});

it("keeps explicit Podman identity while exposing shared container settings", () => {
  const sandbox = {
    mode: "all",
    backend: "Podman",
    docker: {
      network: "bridge",
      seccompProfile: "custom-seccomp.json",
      binds: ["/host/data:/data:ro"],
    },
  };
  const evidence = scanPolicySandboxPosture({ agents: { defaults: { sandbox } } });

  expectIncludes(
    evidence,
    { kind: "backend", value: "podman" },
    { kind: "containerNetwork", networkSurface: "docker", value: "bridge" },
    { kind: "containerSecurityProfile", profile: "seccomp", value: "custom-seccomp.json" },
    { kind: "containerMount", bindSurface: "docker", bind: "/host/data:/data:ro" },
  );
});

it("keeps scanning later agents after a disabled sandbox browser", () => {
  const evidence = scanPolicySandboxPosture({
    agents: {
      entries: {
        alpha: { sandbox: { browser: { enabled: false } } },
        beta: {
          sandbox: { browser: { enabled: true, cdpSourceRange: "172.21.0.1/32" } },
        },
      },
    },
  });

  expectIncludes(
    evidence,
    { agentId: "alpha", kind: "browserCdpSourceRange", value: false },
    { agentId: "beta", kind: "browserCdpSourceRange", value: "172.21.0.1/32" },
    {
      agentId: "beta",
      kind: "containerNetwork",
      networkSurface: "browser",
      value: "openclaw-sandbox-browser",
    },
  );
});
describe("scanPolicyToolPosture", () => {
  it("derives exec posture from normalized agent entries", () => {
    const evidence = scanPolicyToolPosture({
      agents: { entries: { reviewer: { tools: { exec: { mode: "ask" } } } } },
    });

    expectIncludes(
      evidence,
      execEntry("Security", "allowlist", `${execSource}/mode`, true),
      execEntry("Ask", "on-miss", `${execSource}/mode`, true),
    );
  });

  it("merges legacy agent fields with an inherited exec mode", () => {
    const evidence = scanPolicyToolPosture({
      tools: { exec: { mode: "auto" } },
      agents: { entries: { reviewer: { tools: { exec: { ask: "always" } } } } },
    });

    expectIncludes(
      evidence,
      execEntry("Security", "allowlist", "oc://openclaw.config/tools/exec/mode"),
      execEntry("Ask", "always", `${execSource}/ask`),
    );
  });
});

it("ignores reserved channel config namespaces", () => {
  expect(
    scanPolicyChannels({
      channels: {
        defaults: { provider: "telegram" },
        modelByChannel: { telegram: "openai/gpt-5.5" },
        telegram: { enabled: true },
      },
    }),
  ).toEqual([
    {
      enabled: true,
      id: "telegram",
      provider: "telegram",
      source: "oc://openclaw.config/channels/telegram",
    },
  ]);
});
it("is opt-in so existing evidence and attestations remain stable", () => {
  const cfg = { channels: { imessage: {} }, bindings: [] };
  expect(collectPolicyEvidence(cfg)).not.toHaveProperty("routing");
  expect(collectPolicyEvidence(cfg, { routing: {} })).toHaveProperty("routing");
});
describe("scanPolicyTools", () => {
  it("scans documented bullet tool declarations", () => {
    const evidence = scanPolicyTools(
      "- deploy_tool: risk: critical sensitivity: restricted owner: ops IRREVERSIBLE_EXTERNAL",
      "- inspect: risk: low",
      "  sensitivity: public",
      "  owner: support",
    );
    expect(evidence).toEqual([
      {
        id: "deploy-tool",
        source: "oc://AGENTS.md/tools/deploy-tool",
        line: 2,
        risk: "critical",
        sensitivity: "restricted",
        owner: "ops",
        capabilities: ["IRREVERSIBLE_EXTERNAL"],
      },
      {
        id: "inspect",
        source: "oc://AGENTS.md/tools/inspect",
        line: 3,
        risk: "low",
        sensitivity: "public",
        owner: "support",
      },
    ]);
  });

  it("parses a tool literally named tools after local notes", () => {
    const evidence = scanPolicyTools(
      "### Local notes",
      "- SSH: prod-host",
      "### tools risk: high sensitivity: restricted owner: ops",
    );
    expect(evidence).toEqual([
      partial({ id: "tools", risk: "high", sensitivity: "restricted", owner: "ops" }),
    ]);
  });

  it("does not carry metadata across repeated Tools section boundaries", () => {
    const evidence = scanPolicyTools(
      "### deploy risk: high",
      "## Tools",
      "owner: ops",
      "### inspect risk: low owner: support",
    );
    expect(evidence).toEqual([
      partial({ id: "deploy", risk: "high" }),
      partial({ id: "inspect", owner: "support" }),
    ]);
    expect(evidence[0]).not.toHaveProperty("owner");
  });

  it("keeps longer fences open across shorter delimiter runs", () => {
    expect(scanPolicyTools("````markdown", "```", "- SSH: home-server", "````")).toEqual([]);
  });

  it("scans a migrated legacy Tools section after its document heading", () => {
    expect(
      scanPolicyTools(
        "### Local notes (migrated from TOOLS.md)",
        "# TOOLS.md",
        "## Tools",
        "### deploy risk: high sensitivity: restricted owner: ops",
      ),
    ).toEqual([partial({ id: "deploy", risk: "high", owner: "ops" })]);
  });
});

describe("scanPolicyExecApprovals", () => {
  it("scans redacted exec approvals posture and allowlist metadata", () => {
    const evidence = scanPolicyExecApprovals({
      version: 1,
      socket: { path: "/tmp/openclaw.sock", token: "secret-token" },
      defaults: { security: "full", ask: "off", askFallback: "full", autoAllowSkills: true },
      agents: {
        sebby: {
          security: "allowlist",
          ask: "on-miss",
          allowlist: [
            {
              pattern: "deploy",
              argPattern: "^--prod$",
              source: "allow-always",
              commandText: "deploy --prod",
              lastUsedCommand: "deploy --prod",
            },
            { pattern: "inspect", source: "free-form text that must not leak" },
          ],
        },
      },
    });

    expect(evidence).toEqual([
      partial({ id: "defaults", kind: "defaults", security: "full", autoAllowSkills: true }),
      partial({
        id: "agent:sebby",
        kind: "agent",
        agentId: "sebby",
        security: "allowlist",
        ask: "on-miss",
      }),
      partial({
        id: "agent:sebby:allowlist:0",
        kind: "allowlist",
        agentId: "sebby",
        pattern: "deploy",
        argPattern: "^--prod$",
        entrySource: "allow-always",
      }),
      expect.not.objectContaining({ entrySource: "free-form text that must not leak" }),
    ]);
    expect(JSON.stringify(evidence)).not.toContain("secret-token");
    expect(JSON.stringify(evidence)).not.toContain("deploy --prod");
    expect(JSON.stringify(evidence)).not.toContain("free-form text that must not leak");
  });

  it("omits malformed exec approval mode fields", () => {
    expect(
      scanPolicyExecApprovals({
        version: 1,
        defaults: { security: "bogus", ask: "bad", askFallback: "nope" },
        agents: { sebby: { security: "bogus", ask: "bad", askFallback: "nope" } },
      }),
    ).toEqual([
      expect.not.objectContaining({ security: expect.any(String) }),
      expect.not.objectContaining({ security: expect.any(String) }),
    ]);
  });

  it("projects canonical approval entries while retaining source indices across invalid entries", () => {
    expect(
      scanPolicyExecApprovals({
        version: 1,
        agents: {
          main: {
            security: "allowlist",
            allowlist: [
              null,
              { id: "entry-1", pattern: "legacy" },
              "not-an-approval-entry",
              { pattern: " " },
              { id: "entry-2", pattern: "doctor" },
            ],
          },
        },
      }),
    ).toEqual([
      partial({ id: "defaults", kind: "defaults" }),
      partial({
        id: "agent:main",
        kind: "agent",
        agentId: "main",
        security: "allowlist",
        source: "oc://exec-approvals.json/agents/main",
      }),
      approvalEntry(0, "legacy", 1),
      approvalEntry(1, "doctor", 4),
    ]);
  });
});
