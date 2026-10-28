import type { HealthFinding, OpenClawConfig } from "openclaw/plugin-sdk/health";
import { afterEach, beforeEach, expect, it } from "vitest";
import { evaluatePolicy } from "./evaluation.js";
import {
  cfgWithPolicy,
  ctx,
  setupPolicyDoctorTest,
  teardownPolicyDoctorTest,
  writePolicyFixture,
} from "./register.test-harness.js";

const atConfigPath = (path: string) => ({
  severity: "error" as const,
  source: "policy",
  path: "openclaw config",
  ocPath: `oc://openclaw.config/${path}`,
  target: `oc://openclaw.config/${path}`,
});

const mcp = {
  checkId: "policy/mcp-denied-server",
  message: "MCP server 'DocsServer' is denied by policy.",
  ...atConfigPath("mcp/servers/DocsServer"),
  requirement: "oc://policy.jsonc/mcp/servers/deny",
  fixHint: "Remove this configured MCP server or update the policy after review.",
};

function modelFinding(blocked: boolean, modelPath?: string) {
  const provider = blocked ? "blocked" : "other";
  const ref = blocked ? " BLOCKED/ModelX " : "other/modelY";
  const disposition = blocked ? "denied" : "unapproved";
  return {
    ...atConfigPath(modelPath ?? `models/providers/ ${provider.toUpperCase()} `),
    checkId: `policy/models-${disposition}-provider`,
    requirement: `oc://policy.jsonc/models/providers/${blocked ? "deny" : "allow"}`,
    message: modelPath
      ? `Model ref '${ref}' uses ${disposition} provider '${provider}'.`
      : `Model provider '${provider}' is ${blocked ? "denied by policy" : "not in the policy allowlist"}.`,
    fixHint: modelPath
      ? "Select an approved model provider or update the policy after review."
      : blocked
        ? "Remove this configured provider or update the policy after review."
        : "Use an approved model provider or update the policy after review.",
  };
}
const denied = modelFinding(true);
const other = modelFinding(false);
const primary = modelFinding(true, "agents/defaults/model/primary");
const fallback = modelFinding(true, "agents/defaults/model/fallbacks/#1");
const otherModel = modelFinding(false, "agents/defaults/model/fallbacks/#0");

const network = {
  checkId: "policy/network-private-access-enabled",
  message: "Network setting 'browser-private-network' allows private-network access.",
  ...atConfigPath("browser/ssrfPolicy/dangerouslyAllowPrivateNetwork"),
  requirement: "oc://policy.jsonc/network/privateNetwork/allow",
  fixHint: "Disable this private-network access setting or update policy after review.",
};

beforeEach(setupPolicyDoctorTest);
afterEach(teardownPolicyDoctorTest);

const emptyAllowlist = { models: { providers: { deny: [" blocked "], allow: [] } } };
it.each<[string, unknown, HealthFinding[]]>([
  [
    "deny precedence, provider/ref order and unchanged MCP/network findings",
    {
      mcp: { servers: { deny: ["DocsServer"] } },
      models: { providers: { deny: [" blocked "], allow: [" APPROVED ", " BLOCKED "] } },
      network: { privateNetwork: { allow: false } },
    },
    [mcp, denied, other, primary, fallback, otherModel, network],
  ],
  ["denials with an empty allowlist", emptyAllowlist, [denied, primary, fallback]],
])("preserves %s", async (_name, policy, expected) => {
  const model = {
    primary: " BLOCKED/ModelX ",
    fallbacks: ["other/modelY", " BLOCKED/ModelX ", "approved/modelZ"],
  };
  const cfg = {
    ...cfgWithPolicy(),
    mcp: { servers: { DocsServer: { command: "fixture-command" } } },
    models: { providers: { " OTHER ": {}, approved: {}, " BLOCKED ": {} } },
    agents: { defaults: { model } },
    browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
  } as unknown as OpenClawConfig;
  const original = structuredClone(cfg);
  const evaluation = await evaluatePolicy(ctx(await writePolicyFixture(policy), cfg));

  expect([evaluation.attestedFindings, evaluation.findings]).toEqual([expected, expected]);
  expect(cfg).toEqual(original);
});
