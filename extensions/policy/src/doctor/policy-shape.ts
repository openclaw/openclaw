import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { execApprovalsPolicyShapeFinding, ingressPolicyShapeFinding } from "./access-shapes.js";
import { createOrderedPolicyShape, firstPolicyShapeFinding } from "./ordered-shape.js";
import { SUPPORTED_POLICY_SECTIONS } from "./policy-constants.js";
import { posturePolicyShapeFinding } from "./posture-shapes.js";
import { routingPolicyShapeFinding } from "./routing-shapes.js";
import { scopedPolicyShapeFinding } from "./scoped-policy-shape.js";
import { policyShapeFinding } from "./shape-helpers.js";

export function policyContainerShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [
      policyShapeFinding(
        policyPath,
        "oc://" + policyDocName,
        policyPath + " must contain a policy object.",
        "Fix " + policyPath + " so the top-level policy is an object.",
      ),
    ];
  }
  const document = policy;
  const params = { policyPath, policyDocName };
  const shape = createOrderedPolicyShape(document, params);
  function* allowDeny(path: string, valueName: string) {
    yield shape.object(path);
    yield shape.keys(
      path,
      ["allow", "deny"],
      "",
      "Remove {unsupported} or use {property}.allow or {property}.deny.",
      "{policy} {unsupported} is not supported in policy.",
    );
    for (const key of ["allow", "deny"]) {
      yield shape.list(path + "." + key, {
        valueName,
        entry: {
          message: "{policy} {property}[{index}] must be a non-empty string.",
          hint: "Fix {policy} so each {property} entry is a {valueName}.",
        },
      });
    }
  }
  function* findings() {
    yield shape.keys(
      "",
      SUPPORTED_POLICY_SECTIONS,
      "",
      "Remove {key} or use a supported policy section.",
      "{policy} {key} is not a supported policy section.",
    );
    yield shape.object("tools");
    yield posturePolicyShapeFinding("tools", document.tools, params);
    yield shape.object("channels");
    yield shape.keys(
      "channels",
      ["denyRules"],
      "channel",
      "Remove {unsupported} or use channels.denyRules.",
    );
    yield shape.object("mcp");
    yield shape.keys("mcp", ["servers"], "MCP", "Remove {unsupported} or use mcp.servers.");
    yield shape.object("dataHandling");
    yield* allowDeny("mcp.servers", "MCP server id");
    yield shape.object("models");
    yield shape.keys(
      "models",
      ["providers"],
      "model",
      "Remove {unsupported} or use models.providers.",
    );
    yield* allowDeny("models.providers", "model provider id");
    yield shape.object("network");
    yield shape.keys(
      "network",
      ["privateNetwork"],
      "network",
      "Remove {unsupported} or use network.privateNetwork.",
    );
    yield shape.object("network.privateNetwork");
    yield shape.keys(
      "network.privateNetwork",
      ["allow"],
      "network",
      "Remove {unsupported} or use network.privateNetwork.allow.",
    );
    yield shape.boolean(
      "network.privateNetwork.allow",
      "Fix {policy} so {property} is true or false.",
    );
    yield shape.object("secrets");
    yield shape.keys(
      "secrets",
      ["allowInsecureProviders", "denySources", "requireManagedProviders"],
      "secrets",
      "Remove {unsupported} or use a supported secrets policy rule.",
    );
    yield shape.object("auth");
    yield shape.keys("auth", ["profiles"], "auth", "Remove {unsupported} or use auth.profiles.");
    yield shape.object("auth.profiles");
    yield shape.keys(
      "auth.profiles",
      ["allowModes", "requireMetadata"],
      "auth profile",
      "Remove {unsupported} or use a supported auth profile policy rule.",
    );
    yield execApprovalsPolicyShapeFinding(document.execApprovals, params);
    yield posturePolicyShapeFinding("sandbox", document.sandbox, params);
    yield ingressPolicyShapeFinding(document.ingress, params);
    yield posturePolicyShapeFinding("gateway", document.gateway, params);
    yield routingPolicyShapeFinding(document.routing, params);
    yield posturePolicyShapeFinding("agents", document.agents, params);
    yield scopedPolicyShapeFinding(document.scopes, { ...params, policy: document });
  }
  const finding = firstPolicyShapeFinding(findings());
  return finding === undefined ? [] : [finding];
}
