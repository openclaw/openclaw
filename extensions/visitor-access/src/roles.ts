import type { PluginRuntime } from "../api.js";
import { VisitorAccessError } from "./errors.js";

type VisitorRuntimeConfig = ReturnType<PluginRuntime["config"]["current"]>;
export type GatewayRoles = NonNullable<VisitorRuntimeConfig["gateway"]>["roles"];
type GatewayRole = NonNullable<GatewayRoles>["definitions"][string];

/** Match the Gateway's current assignment/default fallback, not a person's display identity. */
export function profileUsesVisitorRole(
  roles: GatewayRoles,
  profile: { id: string; role?: string | null },
): boolean {
  return (
    profile.id !== "gateway-owner" &&
    (!profile.role ||
      profile.role === roles?.default ||
      !Object.hasOwn(roles?.definitions ?? {}, profile.role))
  );
}

export function isRestrictedVisitorRole(role: GatewayRole): boolean {
  return (
    role.sessions.others === "view" &&
    role.sandbox === "required" &&
    (role.agents === "*" || role.agents.length > 0) &&
    role.scopes.includes("operator.sessions.write") &&
    role.scopes.every(
      (scope) => scope === "operator.sessions.read" || scope === "operator.sessions.write",
    )
  );
}

/** Visitor Access manages the configured default; other assigned roles remain independently owned. */
export function resolveVisitorRole(config: VisitorRuntimeConfig): string {
  const roles = config.gateway?.roles;
  const name = roles?.default;
  const role =
    name && roles && Object.hasOwn(roles.definitions, name) ? roles.definitions[name] : undefined;
  if (!name || !role || !isRestrictedVisitorRole(role)) {
    throw new VisitorAccessError(
      "Visitor Access requires gateway.roles.default to allow isolated own-session work and shared-session viewing with only operator.sessions.write and optional operator.sessions.read scopes.",
    );
  }
  return name;
}
