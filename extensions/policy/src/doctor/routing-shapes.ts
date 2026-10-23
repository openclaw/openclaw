import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { hasNonEmptyString as nonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { validPolicyRoutingMatchKinds } from "../policy-routing.js";
import { createOrderedPolicyShape, firstPolicyShapeFinding } from "./ordered-shape.js";
import { policyShapeFinding } from "./shape-helpers.js";

type ShapeContext = {
  readonly policyPath: string;
  readonly policyDocName: string;
};
type RoutingShape = ReturnType<typeof createOrderedPolicyShape>;
const ROUTING_HINT = "Fix {policy} so routing uses the documented policy syntax.";

export function routingPolicyShapeFinding(
  value: unknown,
  ctx: ShapeContext,
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  const shape = createOrderedPolicyShape(value, {
    ...ctx,
    propertyPrefix: "routing",
    targetPrefix: "routing",
  });
  function* findings() {
    yield shape.object("", ROUTING_HINT, true);
    yield routingKeys(shape, "", ["probes", "requireBindings", "requireConfiguredChannels"]);
    for (const key of ["requireBindings", "requireConfiguredChannels"]) {
      yield shape.boolean(key, ROUTING_HINT);
    }
    const probes = shape.value("probes");
    if (probes === undefined) {
      return;
    }
    if (!Array.isArray(probes)) {
      yield routingFinding(shape, "probes", "must be an array.");
      return;
    }
    const ids = new Set<string>();
    for (const [index, probe] of probes.entries()) {
      const target = `routing/probes/#${index}`;
      const entry = createOrderedPolicyShape(probe, {
        ...ctx,
        propertyPrefix: `routing.probes[${index}]`,
        targetPrefix: target,
      });
      yield entry.object("", ROUTING_HINT, true);
      yield routingKeys(entry, "", ["expect", "id", "route"]);
      yield entry.string("id", ROUTING_HINT, true);
      const id = entry.value("id");
      if (typeof id === "string") {
        if (ids.has(id.trim())) {
          yield policyShapeFinding(
            ctx.policyPath,
            `oc://${ctx.policyDocName}/${target}/id`,
            `${ctx.policyPath} routing check id ${id.trim()} must be unique.`,
            `Fix ${ctx.policyPath} so routing uses the documented policy syntax.`,
          );
        }
        ids.add(id.trim());
      }
      yield* routeShapeFindings(entry);
      yield* expectShapeFindings(entry);
    }
  }
  return firstPolicyShapeFinding(findings());
}

function* routeShapeFindings(shape: RoutingShape) {
  yield shape.object("route", ROUTING_HINT, true);
  yield routingKeys(shape, "route", [
    "accountId",
    "channel",
    "guildId",
    "memberRoleIds",
    "parentPeer",
    "peer",
    "teamId",
  ]);
  yield shape.string("route.channel", ROUTING_HINT, true);
  for (const key of ["accountId", "guildId", "teamId"]) {
    yield shape.string(`route.${key}`, ROUTING_HINT);
  }
  for (const key of ["peer", "parentPeer"]) {
    const path = `route.${key}`;
    if (shape.value(path) === undefined) {
      continue;
    }
    yield shape.object(path, ROUTING_HINT, true);
    yield routingKeys(shape, path, ["id", "kind"]);
    const kind = shape.value(`${path}.kind`);
    if (typeof kind !== "string" || !["channel", "direct", "group"].includes(kind)) {
      yield routingFinding(shape, `${path}.kind`, "must be direct, group, or channel.");
    }
    yield shape.string(`${path}.id`, ROUTING_HINT, true);
  }
  const memberRoleIds = shape.value("route.memberRoleIds");
  if (
    memberRoleIds !== undefined &&
    (!Array.isArray(memberRoleIds) ||
      memberRoleIds.length === 0 ||
      memberRoleIds.some((entry) => !nonEmptyString(entry)) ||
      new Set(memberRoleIds.map((entry) => String(entry).trim())).size !== memberRoleIds.length)
  ) {
    yield routingFinding(shape, "route.memberRoleIds", "must contain unique non-empty strings.");
  }
}

function* expectShapeFindings(shape: RoutingShape) {
  yield shape.object("expect", ROUTING_HINT, true);
  yield routingKeys(shape, "expect", ["agentId", "matchedBy"]);
  yield shape.string("expect.agentId", ROUTING_HINT, true);
  const matchedBy = shape.value("expect.matchedBy");
  if (matchedBy !== undefined && !validPolicyRoutingMatchKinds(matchedBy)) {
    yield routingFinding(shape, "expect.matchedBy", "must contain unique supported match kinds.");
  }
}

function routingKeys(shape: RoutingShape, path: string, allowed: readonly string[]) {
  return shape.keys(path, allowed, "", ROUTING_HINT, "{policy} {unsupported} is not supported.");
}

function routingFinding(shape: RoutingShape, path: string, message: string) {
  return shape.finding(path, { message: "{policy} {property} " + message, hint: ROUTING_HINT });
}
