import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { POLICY_RULE_METADATA, type PolicyRuleMetadata } from "./metadata.js";
import { createOrderedPolicyShape, firstPolicyShapeFinding } from "./ordered-shape.js";

type PostureShape = "agents" | "workspace" | "tools" | "scoped-tools" | "sandbox" | "gateway";
type ShapeContext = {
  readonly policyDocName: string;
  readonly policyPath: string;
  readonly targetPrefix?: string;
  readonly propertyPrefix?: string;
};
type ListStyle =
  | { readonly kind: "node-commands" }
  | {
      readonly kind: "workspace-access" | "workspace-tools" | "http-endpoints";
      readonly allowed: readonly string[];
    };
type ShapeStep =
  | { readonly kind: "object"; readonly path: readonly string[] }
  | {
      readonly kind: "keys";
      readonly path: readonly string[];
      readonly allowed: readonly string[];
      readonly section: string;
      readonly hint: string | { readonly key: string };
      readonly scoped: boolean;
    }
  | {
      readonly kind: "rule";
      readonly path: readonly string[];
      readonly metadata: PolicyRuleMetadata;
      readonly valueName: string;
      readonly style?: ListStyle;
    };

const rules: readonly PolicyRuleMetadata[] = POLICY_RULE_METADATA;

function object(path: string): ShapeStep {
  return { kind: "object", path: path.split(".") };
}

function keys(
  path: string,
  section: string,
  hint: string | { readonly key: string },
  scoped = false,
): ShapeStep {
  const prefix = path.split(".");
  const allowed = new Set<string>();
  for (const entry of rules) {
    if (
      prefix.every((part, index) => entry.policyPath[index] === part) &&
      (!scoped || entry.scopeSelectors?.includes("agentIds"))
    ) {
      const key = entry.policyPath[prefix.length];
      if (key !== undefined) {
        allowed.add(key);
      }
    }
  }
  return { kind: "keys", path: prefix, allowed: [...allowed], section, hint, scoped };
}

function rule(path: string, valueName = "", style?: ListStyle["kind"]): ShapeStep {
  const metadata = rules.find((entry) => entry.policyPath.join(".") === path);
  if (
    metadata === undefined ||
    (metadata.valueType !== "boolean" && metadata.valueType !== "string-list")
  ) {
    throw new Error(`Unsupported posture shape rule: ${path}`);
  }
  let listStyle: ListStyle | undefined;
  if (style === "node-commands") {
    listStyle = { kind: style };
  } else if (style !== undefined) {
    if (metadata.allowedValues === undefined) {
      throw new Error(`Missing posture shape enum values: ${path}`);
    }
    listStyle = { kind: style, allowed: metadata.allowedValues };
  }
  return { kind: "rule", path: metadata.policyPath, metadata, valueName, style: listStyle };
}

const workspace = [
  object("agents.workspace"),
  keys("agents.workspace", "agent workspace", "a supported agent workspace policy rule"),
  rule("agents.workspace.allowedAccess", "", "workspace-access"),
  rule("agents.workspace.denyTools", "", "workspace-tools"),
];

const tools = [
  keys("tools", "tools", "a supported tools policy rule"),
  ...["profiles", "fs", "exec", "elevated", "alsoAllow"].map((key) => object(`tools.${key}`)),
  keys("tools.profiles", "tools", { key: "allow" }),
  rule("tools.profiles.allow", "tool profile id"),
  keys("tools.fs", "tools", { key: "requireWorkspaceOnly" }),
  rule("tools.fs.requireWorkspaceOnly"),
  keys("tools.exec", "tools", "a supported tools exec policy rule"),
  rule("tools.exec.allowSecurity", "exec security mode"),
  rule("tools.exec.requireAsk", "exec ask mode"),
  rule("tools.exec.allowHosts", "exec host"),
  keys("tools.elevated", "tools", { key: "allow" }),
  rule("tools.elevated.allow"),
  keys("tools.alsoAllow", "tools", { key: "expected" }),
  rule("tools.alsoAllow.expected", "tool id"),
  rule("tools.denyTools", "tool id or group"),
];

const gatewaySections = ["exposure", "auth", "controlUi", "remote", "http", "nodes"];

// These are validation sequences, not recursive schemas: preflight order determines
// the first diagnostic for a policy with more than one invalid field.
const shapes: Record<PostureShape, readonly ShapeStep[]> = {
  agents: [object("agents"), keys("agents", "agents", { key: "workspace" }), ...workspace],
  workspace,
  tools,
  "scoped-tools": [
    keys("tools", "agent-scoped tools", "", true),
    ...["profiles", "fs", "exec", "elevated", "alsoAllow"].map((key) =>
      keys(`tools.${key}`, "agent-scoped tools", "", true),
    ),
    ...tools,
  ],
  sandbox: [
    object("sandbox"),
    keys("sandbox", "sandbox", "a supported sandbox posture rule"),
    rule("sandbox.requireMode", "sandbox mode"),
    rule("sandbox.allowBackends", "sandbox backend id"),
    object("sandbox.containers"),
    object("sandbox.browser"),
    keys("sandbox.containers", "sandbox", "a supported sandbox container posture rule"),
    ...rules
      .filter((entry) => entry.policyPath[0] === "sandbox" && entry.policyPath[1] === "containers")
      .map((entry) => rule(entry.policyPath.join("."))),
    keys("sandbox.browser", "sandbox", "a supported sandbox browser posture rule"),
    rule("sandbox.browser.requireCdpSourceRange"),
  ],
  gateway: [
    object("gateway"),
    ...gatewaySections.map((key) => object(`gateway.${key}`)),
    keys("gateway", "Gateway", "a supported Gateway policy section"),
    ...gatewaySections.map((key) =>
      keys(`gateway.${key}`, "Gateway", "a supported Gateway policy rule"),
    ),
    rule("gateway.exposure.allowNonLoopbackBind"),
    rule("gateway.exposure.allowTailscaleFunnel"),
    rule("gateway.auth.requireAuth"),
    rule("gateway.auth.requireExplicitRateLimit"),
    rule("gateway.controlUi.allowInsecure"),
    rule("gateway.remote.allow"),
    rule("gateway.http.requireUrlAllowlists"),
    rule("gateway.http.denyEndpoints", "", "http-endpoints"),
    rule("gateway.nodes.denyCommands", "", "node-commands"),
  ],
};

export function posturePolicyShapeFinding(
  shape: PostureShape,
  value: unknown,
  params: ShapeContext,
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  const root =
    shape === "workspace" ? "agents.workspace" : shape === "scoped-tools" ? "tools" : shape;
  const rootDepth = root.split(".").length;
  const validator = createOrderedPolicyShape(value, {
    ...params,
    propertyPrefix: params.propertyPrefix ?? root,
    targetPrefix: params.targetPrefix ?? root.replaceAll(".", "/"),
  });
  function* findings() {
    for (const step of shapes[shape]) {
      const path = step.path.slice(rootDepth).join(".");
      if (step.kind === "object") {
        yield validator.object(path);
      } else if (step.kind === "keys") {
        const hint = typeof step.hint === "string" ? step.hint : "{property}." + step.hint.key;
        yield validator.keys(
          path,
          step.allowed,
          step.section,
          step.scoped
            ? "Move {unsupported} to top-level tools or use a supported scoped tools posture rule."
            : "Remove {unsupported} or use " + hint + ".",
        );
      } else if (step.metadata.valueType === "boolean") {
        yield validator.boolean(
          path,
          shape === "gateway" ? "Fix {policy} so {property} is true or false." : undefined,
        );
      } else if (step.style === undefined) {
        yield validator.list(path, {
          allowed: step.metadata.allowedValues,
          valueName: step.valueName,
        });
      } else {
        yield customListShapeFinding(validator, path, step.style);
      }
    }
  }
  return firstPolicyShapeFinding(findings());
}

function customListShapeFinding(
  validator: ReturnType<typeof createOrderedPolicyShape>,
  path: string,
  style: ListStyle,
): HealthFinding | undefined {
  let arrayHint: string;
  let entryHint: string;
  let entryMessage: string;
  switch (style.kind) {
    case "workspace-access":
      arrayHint = 'Use workspace access values such as ["none", "ro"].';
      entryHint = arrayHint;
      entryMessage = "must be none, ro, or rw.";
      break;
    case "workspace-tools":
      arrayHint = 'Use tool ids such as ["exec", "process", "write", "edit", "apply_patch"].';
      entryHint = "Use supported tool ids: {allowed}.";
      entryMessage = "must be a supported agent workspace tool id.";
      break;
    case "http-endpoints":
      arrayHint =
        'Use an array of endpoint ids such as ["responses"] or remove gateway.http.denyEndpoints.';
      entryHint = "Use supported endpoint ids: {allowed}.";
      entryMessage = "must be a supported endpoint id.";
      break;
    case "node-commands":
      arrayHint =
        'Use an array of node command ids such as ["system.run"] or remove gateway.nodes.denyCommands.';
      entryHint = "Use non-empty node command ids.";
      entryMessage = "must be a non-empty node command id.";
      break;
  }
  return validator.list(path, {
    allowed: style.kind === "node-commands" ? undefined : style.allowed,
    normalize: style.kind === "workspace-access" ? "raw" : "trim",
    array: { message: "{policy} {property} must be an array.", hint: arrayHint },
    entry: { message: "{policy} {property}[{index}] " + entryMessage, hint: entryHint },
  });
}
