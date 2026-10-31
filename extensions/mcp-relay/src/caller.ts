import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { RelayError } from "./protocol.js";
import type { RelayGrant, RelayGrantAuthority } from "./state.js";

export type RelayCaller = RelayGrantAuthority & {
  principalLabel: string;
  canAdmin: boolean;
  canPair: boolean;
};

export function relayCaller(
  client: GatewayRequestHandlerOptions["client"],
  config: ReturnType<PluginRuntime["config"]["current"]>,
): RelayCaller {
  if (!client || client.connect.role !== "operator") {
    throw new RelayError("unavailable", "Reconnect to the Control UI to manage connected apps.");
  }
  const scopes = client.connect.scopes ?? [];
  const canAdmin = scopes.includes("operator.admin");
  const canWrite = canAdmin || scopes.includes("operator.write");
  const ceiling = [
    ...new Set([...scopes, ...(canWrite ? ["operator.read", "operator.write"] : [])]),
  ];
  if (config.gateway?.roles || config.gateway?.auth?.mode === "trusted-proxy") {
    const profile = client.authenticatedUserProfile;
    const actor = client.internal?.operatorRoleActor;
    if (
      !profile ||
      actor?.kind === "system" ||
      (actor?.kind === "operator" && actor.profileId !== profile.profileId)
    ) {
      throw new RelayError(
        "unavailable",
        "Sign in as a person and use the Connected apps tab to pair this Gateway.",
      );
    }
    return {
      principal: { kind: "person", profileId: profile.profileId },
      principalLabel: profile.displayName ?? "Gateway user",
      ceiling,
      canAdmin,
      canPair: canWrite,
    };
  }
  return {
    principal: { kind: "owner" },
    principalLabel: "Gateway owner",
    ceiling,
    canAdmin,
    canPair: canAdmin,
  };
}

export function ownsGrant(caller: RelayCaller, grant: RelayGrant): boolean {
  return (
    grant.principal.kind === caller.principal.kind &&
    (grant.principal.kind === "owner" ||
      (caller.principal.kind === "person" &&
        grant.principal.profileId === caller.principal.profileId))
  );
}

export function consentAuthority(caller: RelayCaller, value: unknown): RelayGrantAuthority {
  if (!caller.canPair) {
    throw new RelayError(
      "unavailable",
      "Your Gateway role cannot connect apps. Ask your administrator for access.",
    );
  }
  const ceiling =
    value ?? ["operator.read", "operator.write"].filter((scope) => caller.ceiling.includes(scope));
  if (
    !Array.isArray(ceiling) ||
    ceiling.length === 0 ||
    ceiling.length > 64 ||
    !ceiling.every(
      (scope): scope is string => typeof scope === "string" && caller.ceiling.includes(scope),
    )
  ) {
    throw new RelayError("invalid_params", "Choose access permitted by your current Gateway role.");
  }
  return {
    principal: caller.principal,
    principalLabel: caller.principalLabel,
    ceiling: [...new Set(ceiling)],
  };
}
