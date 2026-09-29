import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { execApprovalAllowlistExpectedShapeFinding } from "./exec-approval-rules.js";
import {
  createOrderedPolicyShape,
  firstPolicyShapeFinding,
  type PolicyShapeContext,
} from "./ordered-shape.js";
import {
  SUPPORTED_DM_POLICIES,
  SUPPORTED_DM_SCOPES,
  SUPPORTED_EXEC_APPROVAL_SECURITY,
} from "./policy-constants.js";

export function ingressPolicyShapeFinding(
  value: unknown,
  params: PolicyShapeContext & {
    readonly allowSession?: boolean;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  const context = {
    ...params,
    propertyPrefix: params.propertyPrefix ?? "ingress",
    targetPrefix: params.targetPrefix ?? "ingress",
  };
  const shape = createOrderedPolicyShape(value, context);
  function* findings() {
    yield shape.object("");
    if (params.allowSession === false && shape.value("session") !== undefined) {
      yield shape.finding("session", {
        message: "{policy} {property} is not supported by the channelIds selector.",
        hint: "Move session ingress rules to top-level ingress; scoped ingress currently supports ingress.channels.*.",
      });
    }
    yield shape.keys(
      "",
      ["channels", "session"],
      "ingress",
      "Remove {unsupported} or use ingress.session or ingress.channels.",
    );
    yield shape.object("session");
    yield shape.object("channels");
    yield shape.keys(
      "session",
      ["requireDmScope"],
      "ingress",
      "Remove {unsupported} or use {property}.requireDmScope.",
    );
    yield shape.enum("session.requireDmScope", SUPPORTED_DM_SCOPES, {
      message: "{policy} {property} must be a supported DM scope.",
      hint: "Use supported DM scopes: {allowed}.",
    });
    yield shape.keys(
      "channels",
      ["allowDmPolicies", "denyOpenGroups", "requireMentionInGroups"],
      "ingress",
      "Remove {unsupported} or use a supported ingress channel policy rule.",
    );
    yield shape.list("channels.allowDmPolicies", {
      allowed: SUPPORTED_DM_POLICIES,
      valueName: "DM policy",
    });
    yield shape.boolean("channels.denyOpenGroups");
    yield shape.boolean("channels.requireMentionInGroups");
  }
  return firstPolicyShapeFinding(findings());
}

export function execApprovalsPolicyShapeFinding(
  value: unknown,
  params: PolicyShapeContext & {
    readonly allowDefaults?: boolean;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  const context = {
    ...params,
    propertyPrefix: params.propertyPrefix ?? "execApprovals",
    targetPrefix: params.targetPrefix ?? "execApprovals",
  };
  const shape = createOrderedPolicyShape(value, context);
  const allowDefaults = params.allowDefaults ?? true;
  function* findings() {
    yield shape.object("");
    yield shape.keys(
      "",
      allowDefaults ? ["agents", "defaults", "requireFile"] : ["agents"],
      "exec approvals",
      "Remove {unsupported} or use a supported execApprovals rule.",
    );
    yield shape.boolean("requireFile", "Set execApprovals.requireFile to true or false.");
    for (const section of allowDefaults ? ["defaults", "agents"] : ["agents"]) {
      yield shape.object(section);
    }
    if (allowDefaults) {
      yield shape.keys(
        "defaults",
        ["allowSecurity"],
        "exec approvals",
        "Use execApprovals.defaults.allowSecurity or remove the unsupported rule.",
      );
      yield shape.list("defaults.allowSecurity", {
        allowed: SUPPORTED_EXEC_APPROVAL_SECURITY,
        valueName: "exec approval security mode",
      });
    }
    yield shape.keys(
      "agents",
      ["allowAutoAllowSkills", "allowSecurity", "allowlist"],
      "exec approvals",
      "Use execApprovals.agents.allowSecurity, execApprovals.agents.allowAutoAllowSkills, or execApprovals.agents.allowlist.expected.",
    );
    yield shape.list("agents.allowSecurity", {
      allowed: SUPPORTED_EXEC_APPROVAL_SECURITY,
      valueName: "exec approval security mode",
    });
    yield shape.boolean(
      "agents.allowAutoAllowSkills",
      "Set execApprovals.agents.allowAutoAllowSkills to true or false.",
    );
    yield shape.object("agents.allowlist");
    yield shape.keys(
      "agents.allowlist",
      ["expected"],
      "exec approvals",
      "Use execApprovals.agents.allowlist.expected or remove the unsupported rule.",
    );
    yield execApprovalAllowlistExpectedShapeFinding(shape.value("agents.allowlist.expected"), {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: context.propertyPrefix + ".agents.allowlist.expected",
      target: context.targetPrefix + "/agents/allowlist/expected",
    });
  }
  return firstPolicyShapeFinding(findings());
}

export function scopedDataHandlingPolicyShapeFinding(
  dataHandling: Record<string, unknown>,
  params: {
    readonly policyPath: string;
    readonly policyDocName: string;
    readonly targetPrefix: string;
    readonly scopeName: string;
  },
): HealthFinding | undefined {
  const shape = createOrderedPolicyShape(dataHandling, {
    ...params,
    propertyPrefix: "scopes." + params.scopeName + ".dataHandling",
    targetPrefix: params.targetPrefix + "/dataHandling",
  });
  function* findings() {
    yield shape.keys(
      "",
      ["memory"],
      "",
      "Move global data-handling rules to top-level dataHandling, or use dataHandling.memory with agentIds.",
      "{policy} {unsupported} is not a supported scoped policy section.",
    );
    yield shape.object(
      "memory",
      "Fix {policy} so the scoped dataHandling.memory policy section is an object.",
    );
    yield shape.keys(
      "memory",
      ["denySessionTranscriptIndexing"],
      "",
      "Use dataHandling.memory.denySessionTranscriptIndexing or remove the unsupported rule.",
      "{policy} {unsupported} is not a supported scoped policy rule.",
    );
    yield shape.boolean(
      "memory.denySessionTranscriptIndexing",
      "Set dataHandling.memory.denySessionTranscriptIndexing to true or false.",
    );
  }
  return firstPolicyShapeFinding(findings());
}
