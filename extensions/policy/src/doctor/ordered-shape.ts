import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getPolicyPath } from "../policy-value.js";
import { readExecApprovalAllowlistRequirements } from "./exec-approval-rules.js";
import type { PolicyRuleMetadata } from "./metadata.js";
import { policyShapeFinding } from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export type PolicyShapeContext = {
  readonly policyDocName: string;
  readonly policyPath: string;
  readonly propertyPrefix?: string;
  readonly targetPrefix?: string;
};

type Diagnostic = { readonly message: string; readonly hint: string };
type ListDiagnostic = {
  readonly array?: Diagnostic;
  readonly entry?: Diagnostic;
  readonly allowed?: readonly string[];
  readonly normalize?: "raw" | "trim" | "lower";
  readonly valueName?: string;
};

export function policyRuleValueIsValid(metadata: PolicyRuleMetadata, value: unknown): boolean {
  switch (metadata.valueType) {
    case "boolean":
      return typeof value === "boolean";
    case "channel-provider-deny-rules":
      return (
        Array.isArray(value) &&
        value.every(
          (entry) =>
            isRecord(entry) &&
            isRecord(entry.when) &&
            typeof entry.when.provider === "string" &&
            entry.when.provider.trim() !== "",
        )
      );
    case "routing-probes":
      return Array.isArray(value);
    case "string-list":
    case "string": {
      if (
        metadata.valueType === "string-list" &&
        metadata.policyPath.join(".") === "execApprovals.agents.allowlist.expected"
      ) {
        return readExecApprovalAllowlistRequirements(value, []) !== undefined;
      }
      const allowed = metadata.allowedValues ?? metadata.orderedValues;
      return (
        stringListIssue(
          metadata.valueType === "string" ? [value] : value,
          metadata.caseSensitive === true ? allowed : allowed?.map((entry) => entry.toLowerCase()),
          metadata.caseSensitive === true ? "trim" : "lower",
          false,
        ) === undefined
      );
    }
  }
  return false;
}

export function firstPolicyShapeFinding(
  findings: Iterable<HealthFinding | undefined>,
): HealthFinding | undefined {
  for (const finding of findings) {
    if (finding !== undefined) {
      return finding;
    }
  }
  return undefined;
}

export function collectPolicyShapeFindings(
  findings: Iterable<HealthFinding | undefined>,
): HealthFinding[] {
  return Array.from(findings).filter((finding): finding is HealthFinding => finding !== undefined);
}

function stringListIssue(
  value: unknown,
  allowed?: readonly string[],
  normalize: "raw" | "trim" | "lower" = "trim",
  visitHoles = true,
): { kind: "array" } | { kind: "entry"; index: number } | undefined {
  if (!Array.isArray(value)) {
    return { kind: "array" };
  }
  const index = value.findIndex((entry, entryIndex) => {
    if (!visitHoles && !(entryIndex in value)) {
      return false;
    }
    if (typeof entry !== "string") {
      return true;
    }
    const normalized =
      normalize === "raw"
        ? entry
        : normalize === "lower"
          ? entry.trim().toLowerCase()
          : entry.trim();
    return normalized === "" || (allowed !== undefined && !allowed.includes(normalized));
  });
  return index < 0 ? undefined : { kind: "entry", index };
}

/** Executes primitive checks; callers retain their explicit first/all diagnostic schedule. */
export function createOrderedPolicyShape(value: unknown, context: PolicyShapeContext) {
  const paths = (path: string) => {
    const parts = path === "" ? [] : path.split(".");
    return {
      value: getPolicyPath(value, parts),
      property: [context.propertyPrefix, ...parts].filter((part) => part !== undefined).join("."),
      target: [context.targetPrefix, ...parts.map(ocPathSegment)]
        .filter((part) => part !== undefined)
        .join("/"),
      hasTarget: context.targetPrefix !== undefined || parts.length > 0,
    };
  };
  const diagnostic = (
    path: string,
    text: Diagnostic,
    detail: { key?: string; index?: number; valueName?: string; allowed?: readonly string[] } = {},
  ) => {
    const location = paths(path);
    const property = location.property;
    const fields: Record<string, string> = {
      policy: context.policyPath,
      property,
      key: detail.key ?? "",
      index: String(detail.index ?? ""),
      unsupported: property + "." + (detail.key ?? ""),
      valueName: detail.valueName ?? "",
      allowed: detail.allowed?.join(", ") ?? "",
    };
    const render = (template: string) =>
      template.replace(
        /\{(policy|property|key|index|unsupported|valueName|allowed)\}/g,
        (_, key: string) => fields[key]!,
      );
    const suffix =
      detail.key !== undefined
        ? "/" + ocPathSegment(detail.key)
        : detail.index !== undefined
          ? "/#" + detail.index
          : "";
    return policyShapeFinding(
      context.policyPath,
      "oc://" + context.policyDocName + (location.hasTarget ? "/" + location.target : "") + suffix,
      render(text.message),
      render(text.hint),
    );
  };
  return {
    value: (path: string) => paths(path).value,
    finding: diagnostic,
    object(path: string, hint = "Fix {policy} so {property} is an object.", required = false) {
      const current = paths(path).value;
      return (current === undefined && !required) || isRecord(current)
        ? undefined
        : diagnostic(path, {
            message: "{policy} {property} must be an object.",
            hint,
          });
    },
    keys(
      path: string,
      allowed: readonly string[],
      section: string,
      hint: string,
      message = "{policy} {unsupported} is not supported in " + section + " policy.",
    ) {
      const current = paths(path).value;
      if (!isRecord(current)) {
        return undefined;
      }
      const key = Object.keys(current).find((entry) => !allowed.includes(entry));
      return key === undefined ? undefined : diagnostic(path, { message, hint }, { key });
    },
    boolean(path: string, hint = "Set {property} to true or false.") {
      const current = paths(path).value;
      return current === undefined || typeof current === "boolean"
        ? undefined
        : diagnostic(path, {
            message: "{policy} {property} must be a boolean.",
            hint,
          });
    },
    enum(path: string, allowed: readonly string[], text: Diagnostic) {
      const current = paths(path).value;
      return current === undefined || (typeof current === "string" && allowed.includes(current))
        ? undefined
        : diagnostic(path, text, { allowed });
    },
    list(path: string, options: ListDiagnostic = {}) {
      const current = paths(path).value;
      if (current === undefined) {
        return undefined;
      }
      const issue = stringListIssue(current, options.allowed, options.normalize);
      if (issue === undefined) {
        return undefined;
      }
      const text =
        issue.kind === "array"
          ? (options.array ?? {
              message: "{policy} {property} must be an array.",
              hint: "Fix {policy} so {property} is an array of {valueName}s.",
            })
          : (options.entry ?? {
              message: "{policy} {property}[{index}] must be a supported {valueName}.",
              hint:
                "Use non-empty {valueName} entries." +
                (options.allowed === undefined ? "" : " Supported values: {allowed}."),
            });
      return diagnostic(path, text, {
        ...(issue.kind === "entry" ? { index: issue.index } : {}),
        valueName: options.valueName,
        allowed: options.allowed,
      });
    },
  };
}
