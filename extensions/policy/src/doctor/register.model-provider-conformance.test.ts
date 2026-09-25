import type { OpenClawConfig } from "openclaw/plugin-sdk/health";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluatePolicy } from "./register.js";
import {
  cfgWithPolicy,
  ctx,
  setupPolicyDoctorTest,
  teardownPolicyDoctorTest,
  writePolicyFixture,
} from "./register.test-harness.js";

const deniedMcp = {
  checkId: "policy/mcp-denied-server",
  severity: "error",
  message: "MCP server 'DocsServer' is denied by policy.",
  source: "policy",
  path: "openclaw config",
  ocPath: "oc://openclaw.config/mcp/servers/DocsServer",
  target: "oc://openclaw.config/mcp/servers/DocsServer",
  requirement: "oc://policy.jsonc/mcp/servers/deny",
  fixHint: "Remove this configured MCP server or update the policy after review.",
};

const deniedProvider = {
  checkId: "policy/models-denied-provider",
  severity: "error",
  message: "Model provider 'blocked' is denied by policy.",
  source: "policy",
  path: "openclaw config",
  ocPath: "oc://openclaw.config/models/providers/ BLOCKED ",
  target: "oc://openclaw.config/models/providers/ BLOCKED ",
  requirement: "oc://policy.jsonc/models/providers/deny",
  fixHint: "Remove this configured provider or update the policy after review.",
};

const unapprovedProvider = {
  checkId: "policy/models-unapproved-provider",
  severity: "error",
  message: "Model provider 'other' is not in the policy allowlist.",
  source: "policy",
  path: "openclaw config",
  ocPath: "oc://openclaw.config/models/providers/ OTHER ",
  target: "oc://openclaw.config/models/providers/ OTHER ",
  requirement: "oc://policy.jsonc/models/providers/allow",
  fixHint: "Use an approved model provider or update the policy after review.",
};

const deniedPrimary = {
  checkId: "policy/models-denied-provider",
  severity: "error",
  message: "Model ref ' BLOCKED/ModelX ' uses denied provider 'blocked'.",
  source: "policy",
  path: "openclaw config",
  ocPath: "oc://openclaw.config/agents/defaults/model/primary",
  target: "oc://openclaw.config/agents/defaults/model/primary",
  requirement: "oc://policy.jsonc/models/providers/deny",
  fixHint: "Select an approved model provider or update the policy after review.",
};

const deniedFallback = {
  checkId: "policy/models-denied-provider",
  severity: "error",
  message: "Model ref ' BLOCKED/ModelX ' uses denied provider 'blocked'.",
  source: "policy",
  path: "openclaw config",
  ocPath: "oc://openclaw.config/agents/defaults/model/fallbacks/#1",
  target: "oc://openclaw.config/agents/defaults/model/fallbacks/#1",
  requirement: "oc://policy.jsonc/models/providers/deny",
  fixHint: "Select an approved model provider or update the policy after review.",
};

const unapprovedModel = {
  checkId: "policy/models-unapproved-provider",
  severity: "error",
  message: "Model ref 'other/modelY' uses unapproved provider 'other'.",
  source: "policy",
  path: "openclaw config",
  ocPath: "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
  target: "oc://openclaw.config/agents/defaults/model/fallbacks/#0",
  requirement: "oc://policy.jsonc/models/providers/allow",
  fixHint: "Select an approved model provider or update the policy after review.",
};

const privateNetwork = {
  checkId: "policy/network-private-access-enabled",
  severity: "error",
  message: "Network setting 'browser-private-network' allows private-network access.",
  source: "policy",
  path: "openclaw config",
  ocPath: "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
  target: "oc://openclaw.config/browser/ssrfPolicy/dangerouslyAllowPrivateNetwork",
  requirement: "oc://policy.jsonc/network/privateNetwork/allow",
  fixHint: "Disable this private-network access setting or update policy after review.",
};

describe("model provider conformance receipts", () => {
  beforeEach(setupPolicyDoctorTest);
  afterEach(teardownPolicyDoctorTest);

  it.each([
    {
      name: "deny precedence, provider/ref order and unchanged MCP/network findings",
      policy: {
        mcp: { servers: { deny: ["DocsServer"] } },
        models: { providers: { deny: [" blocked "], allow: [" APPROVED ", " BLOCKED "] } },
        network: { privateNetwork: { allow: false } },
      },
      expected: [
        deniedMcp,
        deniedProvider,
        unapprovedProvider,
        deniedPrimary,
        deniedFallback,
        unapprovedModel,
        privateNetwork,
      ],
    },
    {
      name: "denials with a missing allowlist",
      policy: { models: { providers: { deny: [" blocked "] } } },
      expected: [deniedProvider, deniedPrimary, deniedFallback],
    },
    {
      name: "denials with an empty allowlist",
      policy: { models: { providers: { deny: [" blocked "], allow: [] } } },
      expected: [deniedProvider, deniedPrimary, deniedFallback],
    },
    {
      name: "matching allowlist without denials",
      policy: { models: { providers: { allow: [" BLOCKED ", " OTHER ", " APPROVED "] } } },
      expected: [],
    },
  ])("preserves $name", async ({ policy, expected }) => {
    const cfg = {
      ...cfgWithPolicy(),
      mcp: { servers: { DocsServer: { command: "fixture-command" } } },
      models: { providers: { " OTHER ": {}, approved: {}, " BLOCKED ": {} } },
      agents: {
        defaults: {
          model: {
            primary: " BLOCKED/ModelX ",
            fallbacks: ["other/modelY", " BLOCKED/ModelX ", "approved/modelZ"],
          },
        },
      },
      browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
    } as unknown as OpenClawConfig;
    const original = structuredClone(cfg);
    const evaluation = await evaluatePolicy(ctx(await writePolicyFixture(policy), cfg));

    // The attested order is the receipt contract; registered checks regroup by check ID.
    expect(evaluation.attestedFindings).toEqual(expected);
    expect(evaluation.findings).toEqual(expected);
    expect(cfg).toEqual(original);
  });
});
