import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  execApprovalsPolicyShapeFinding,
  ingressPolicyShapeFinding,
  scopedDataHandlingPolicyShapeFinding,
} from "./access-shapes.js";
import { createOrderedPolicyShape, firstPolicyShapeFinding } from "./ordered-shape.js";
import { normalizePolicyChannelId } from "./policy-runtime.js";
import { duplicateScopedPolicyFieldFinding } from "./policy-scope.js";
import { posturePolicyShapeFinding } from "./posture-shapes.js";
import { ocPathSegment } from "./utils.js";

export function scopedPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  const root = createOrderedPolicyShape(value, {
    ...params,
    propertyPrefix: "scopes",
    targetPrefix: "scopes",
  });
  if (!isRecord(value)) {
    return root.object(
      "",
      "Fix {policy} so scopes maps scope names to policy overlays with selectors such as agentIds.",
    );
  }
  const scopes = value;
  function* findings() {
    for (const [scopeName, overlay] of Object.entries(scopes)) {
      const targetPrefix = "scopes/" + ocPathSegment(scopeName);
      const propertyPrefix = "scopes." + scopeName;
      const shape = createOrderedPolicyShape(overlay, { ...params, propertyPrefix, targetPrefix });
      yield shape.object("", "Fix {policy} so the named policy scope is an object.", true);
      const hasAgentIds = shape.value("agentIds") !== undefined;
      const hasChannelIds = shape.value("channelIds") !== undefined;
      if (!hasAgentIds && !hasChannelIds) {
        yield shape.finding("", {
          message: "{policy} {property} must define at least one selector.",
          hint: "List agentIds for agent-scoped policy or channelIds for channel-scoped ingress policy.",
        });
      }
      yield scopedSelectorShapeFinding(shape, "agentIds", "agent");
      yield scopedSelectorShapeFinding(shape, "channelIds", "channel");
      if (shape.value("ingress") !== undefined && !hasChannelIds) {
        yield shape.finding("ingress", {
          message: "{policy} {property} requires the channelIds selector.",
          hint: "Move global ingress rules to top-level ingress, or list channelIds for channel-scoped ingress policy.",
        });
      }
      if (
        ["agents", "dataHandling", "execApprovals", "tools", "sandbox"].some(
          (section) => shape.value(section) !== undefined,
        ) &&
        !hasAgentIds
      ) {
        yield shape.finding("", {
          message: "{policy} {property} uses agent-scoped sections without agentIds.",
          hint: "List agentIds for agents.workspace, dataHandling.memory, tools, or sandbox policy sections.",
        });
      }
      yield shape.keys(
        "",
        [
          "agentIds",
          "channelIds",
          "agents",
          "dataHandling",
          "execApprovals",
          "tools",
          "sandbox",
          "ingress",
        ],
        "",
        "Use agentIds with agents.workspace, dataHandling.memory, execApprovals, tools, or sandbox, and channelIds with ingress.channels.",
        "{policy} {unsupported} is not a supported scoped policy section.",
      );
      yield shape.object(
        "dataHandling",
        "Fix {policy} so the scoped dataHandling policy section is an object.",
      );
      const dataHandling = shape.value("dataHandling");
      if (isRecord(dataHandling)) {
        yield scopedDataHandlingPolicyShapeFinding(dataHandling, {
          ...params,
          targetPrefix,
          scopeName,
        });
      }
      yield shape.object(
        "agents",
        "Fix {policy} so the scoped agents policy section is an object.",
      );
      yield shape.keys(
        "agents",
        ["workspace"],
        "",
        "Move the rule under agents.workspace or a supported scoped top-level section.",
        "{policy} {unsupported} is not supported by the agentIds selector.",
      );
      const sectionParams = (section: string) => ({
        ...params,
        targetPrefix: targetPrefix + "/" + section.replaceAll(".", "/"),
        propertyPrefix: propertyPrefix + "." + section,
      });
      yield posturePolicyShapeFinding(
        "workspace",
        shape.value("agents.workspace"),
        sectionParams("agents.workspace"),
      );
      yield execApprovalsPolicyShapeFinding(shape.value("execApprovals"), {
        ...sectionParams("execApprovals"),
        allowDefaults: false,
      });
      yield shape.object("tools", "Fix {policy} so the scoped tools policy overlay is an object.");
      yield posturePolicyShapeFinding("scoped-tools", shape.value("tools"), sectionParams("tools"));
      yield posturePolicyShapeFinding("sandbox", shape.value("sandbox"), sectionParams("sandbox"));
      yield ingressPolicyShapeFinding(shape.value("ingress"), {
        ...sectionParams("ingress"),
        allowSession: false,
      });
    }
    yield duplicateScopedPolicyFieldFinding(scopes, params);
  }
  return firstPolicyShapeFinding(findings());
}

function scopedSelectorShapeFinding(
  shape: ReturnType<typeof createOrderedPolicyShape>,
  path: string,
  kind: "agent" | "channel",
): HealthFinding | undefined {
  const valueName = kind + " id";
  const finding = shape.list(path, { valueName });
  if (finding !== undefined) {
    return finding;
  }
  const value = shape.value(path);
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (value.length === 0) {
    return shape.finding(
      path,
      {
        message: "{policy} {property} must include at least one {valueName}.",
        hint: "Add one or more {valueName}s to {policy} {property}.",
      },
      { valueName },
    );
  }
  const seen = new Map<string, number>();
  for (const [index, rawValue] of value.entries()) {
    if (typeof rawValue !== "string") {
      continue;
    }
    const normalized =
      kind === "agent" ? normalizeAgentId(rawValue) : normalizePolicyChannelId(rawValue);
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      return shape.finding(
        path,
        {
          message:
            "{policy} {property}[{index}] duplicates {property}[" +
            previous +
            "] after normalization.",
          hint: "List each {valueName} only once per named policy scope.",
        },
        { index, valueName },
      );
    }
    seen.set(normalized, index);
  }
  return undefined;
}

export function hasValidScopedPolicy(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): boolean {
  return (
    isRecord(policy) &&
    scopedPolicyShapeFinding(policy.scopes, { policyDocName, policyPath, policy }) === undefined
  );
}
