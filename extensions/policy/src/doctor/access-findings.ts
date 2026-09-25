import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createOrderedPolicyShape } from "./ordered-shape.js";
import { SUPPORTED_AUTH_PROFILE_METADATA } from "./policy-constants.js";
import { isChannelDenyRule } from "./shape-helpers.js";

export function authProfileMetadataRequirementFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  const shape = createOrderedPolicyShape(policy, { policyPath, policyDocName });
  const finding = shape.list("auth.profiles.requireMetadata", {
    allowed: SUPPORTED_AUTH_PROFILE_METADATA,
    normalize: "lower",
    array: {
      message: "{policy} {property} must be an array of metadata keys.",
      hint: "Use supported metadata keys: {allowed}.",
    },
    entry: {
      message: "{policy} {property}[{index}] must be a supported metadata key.",
      hint: "Use supported metadata keys: {allowed}.",
    },
  });
  return finding === undefined ? [] : [finding];
}

export function invalidChannelDenyRuleFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  const shape = createOrderedPolicyShape(policy, { policyPath, policyDocName });
  const rules = shape.value("channels.denyRules");
  if (rules === undefined) {
    return [];
  }
  if (!Array.isArray(rules)) {
    return [
      shape.finding("channels.denyRules", {
        message: "{policy} {property} must be an array.",
        hint: "Fix {policy} so channel deny rules are an array.",
      }),
    ];
  }
  for (const [index, rule] of rules.entries()) {
    if (!isRecord(rule)) {
      continue;
    }
    const entry = createOrderedPolicyShape(rule, {
      policyPath,
      policyDocName,
      propertyPrefix: "channels.denyRules[" + index + "]",
      targetPrefix: "channels/denyRules/#" + index,
    });
    const finding =
      entry.keys(
        "",
        ["id", "reason", "when"],
        "",
        "Remove {unsupported} or use id, when.provider, and reason.",
        "{policy} {unsupported} is not supported in channel deny rules.",
      ) ??
      entry.keys(
        "when",
        ["provider"],
        "",
        "Remove {unsupported} or use when.provider.",
        "{policy} {unsupported} is not supported in channel deny rules.",
      );
    if (finding !== undefined) {
      return [finding];
    }
  }
  const index = rules.findIndex((rule) => !isChannelDenyRule(rule));
  return index < 0
    ? []
    : [
        shape.finding(
          "channels.denyRules",
          {
            message: "{policy} {property}[{index}] must define when.provider as a string.",
            hint: "Fix {policy} so each channel deny rule has a provider match.",
          },
          { index },
        ),
      ];
}
