import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import type { MemoryCallerContext } from "./memory-provider-types.js";
import type { Scope } from "./model.js";
import type { GrantAccess } from "./stores-contract.js";

const denied = () =>
  new Error("Knowledge access unavailable: trusted agent/session authority is required.");
// The host mints no audience for several reasons (stale or ineligible lineage,
// unverifiable storage). Only the Gateway log names which, so this message
// points there without guessing a repair or naming other sessions.
const noAudience = () =>
  new Error(
    'Knowledge access unavailable: the host granted this session no memory audience. The Gateway log entry "memory_audience_denied" for this session names the reason and its repair.',
  );
// A read-only grant lets the conversation read the private partition but never
// save; falling back to its own conversation partition would be a silent save
// the owner did not grant.
const readOnly = () =>
  new Error(
    "Knowledge is read-only in this conversation: its owner granted it read access to the agent's private knowledge, not saves. Nothing was saved.",
  );
/** A store partition: the store's private knowledge or one trusted conversation. */
export type Partition = Exclude<Scope, { visibility: "sample" }>;
/** Who is asking, and for which partition of their effective store. */
export type Principal = { agentId: string; scope: Partition };
/** Resolved, live-checked access. `agentId` is the effective agent (reader and
 * writer); the store is chosen by membership, never by the caller. */
export type VaultAccess = Principal & {
  assertCurrent: () => void;
  activity?: import("./session-activity.js").ActivityOrigin;
};
type MemoryAudience = NonNullable<
  Extract<MemoryCallerContext["authority"], { kind: "session" }>["audience"]
>;
/** Owner grant covering a conversation session key, read live from configuration. */
export type GrantLookup = (sessionKey: string) => GrantAccess | undefined;
/** Provider principals also say whether the lease may release content at all
 * (host readiness checks may not) and whether a session reads the private
 * partition: the owner's own audience, or a conversation the owner granted it to. */
export type MemoryPrincipal = Principal & { healthOnly: boolean; sessionPrivate: boolean };
const OPERATOR_READ = new Set(["operator.read", "operator.write", "operator.admin"]),
  OPERATOR_WRITE = new Set(["operator.write", "operator.admin"]);

/** Resolve a feature invocation to a principal. No payload field participates:
 * tools use the host-minted memory audience and the owner's grants;
 * operators use `operatorAgent`, which the service chooses (the default agent or
 * an operator-only selector). The returned function re-evaluates live authority,
 * grants included, on every call. */
export function featurePrincipal(
  context: FeatureInvocationContext,
  operatorRead: boolean,
  write: boolean,
  operatorAgent: string | undefined,
  grants: GrantLookup,
): () => Principal {
  return () => {
    if (context.source === "session-action") {
      const { client, sessionKey } = context.action;
      if (!operatorRead || !client?.connId || !client.scopes.some((s) => OPERATOR_READ.has(s))) {
        throw denied();
      }
      if (write && !client.scopes.some((s) => OPERATOR_WRITE.has(s))) {
        throw denied();
      }
      // Operators browse an agent's private partition, which session turns
      // reach only with the owner's audience. On a shared Gateway that is an
      // administrator; a role's agent ceiling bounds every operator.
      if (client.isSharedGateway?.() === true && !client.scopes.includes("operator.admin")) {
        throw new Error(
          "Knowledge access unavailable: on a shared Gateway, browsing an agent's private knowledge requires an administrator.",
        );
      }
      // Operators inspect an agent's private store; a session target would be
      // conversation impersonation.
      if (sessionKey) {
        throw denied();
      }
      if (!operatorAgent) {
        throw new Error(
          "Several agents are configured and none is the default; choose which agent's knowledge to view.",
        );
      }
      if (client.allowsAgent && !client.allowsAgent(operatorAgent)) {
        throw new Error(
          `Knowledge access unavailable: your operator role does not include agent "${operatorAgent}".`,
        );
      }
      return { agentId: operatorAgent, scope: { visibility: "private" } };
    }
    if (context.source !== "tool") {
      throw denied();
    }
    const tool = context.tool;
    context.signal?.throwIfAborted();
    if (typeof tool.assertInvocationCurrent !== "function") {
      throw denied();
    }
    tool.assertInvocationCurrent();
    tool.assertMemoryAudienceCurrent?.();
    return audiencePrincipal(tool.memoryAudience, grants, write);
  };
}

/** The owner's grant for a tool invocation's conversation, if any. */
export function toolGrant(
  context: FeatureInvocationContext,
  grants: GrantLookup,
): GrantAccess | undefined {
  const audience = context.source === "tool" ? context.tool.memoryAudience : undefined;
  return audience?.kind === "conversation" ? grants(audience.sessionKey) : undefined;
}

// A conversation reads, or writes, the private partition only when the owner
// granted it that access; otherwise it keeps its own conversation partition.
// Revoking or narrowing a grant changes this result, so pinned principals
// (pinPrincipal) fence work already in flight.
function audiencePrincipal(
  audience: MemoryAudience | undefined,
  grants: GrantLookup,
  write: boolean,
): Principal {
  if (!audience) {
    throw noAudience();
  }
  if (audience.kind === "owner-private") {
    return { agentId: audience.agentId, scope: { visibility: "private" } };
  }
  // Every grant reads the private partition; only read-write also saves there.
  // There is no write-only grant: saves run against the private partition, so
  // their results would reveal private records to a conversation that cannot read.
  const grant = grants(audience.sessionKey);
  if (grant && write && grant !== "read-write") {
    throw readOnly();
  }
  if (grant) {
    return { agentId: audience.agentId, scope: { visibility: "private" } };
  }
  return {
    agentId: audience.agentId,
    scope: { visibility: "conversation", sessionId: audience.sessionId },
  };
}

/** Provider runtime access is host-issued, not a fabricated feature/tool invocation. */
export function memoryPrincipal(
  context: MemoryCallerContext,
  requestedAgent: string,
  operatorRead: boolean,
  purpose: "default" | "status" | "cli" | undefined,
  grants: GrantLookup,
): () => MemoryPrincipal {
  return () => {
    if (typeof context.assertCurrent !== "function") {
      throw denied();
    }
    context.signal?.throwIfAborted();
    context.assertCurrent();
    const caller = context.authority;
    if (caller.kind === "host") {
      if (purpose !== "status") {
        throw denied();
      }
      // The scope is internal to validation; this lease cannot release content.
      return {
        agentId: requestedAgent,
        scope: { visibility: "private" },
        healthOnly: true,
        sessionPrivate: false,
      };
    }
    if (caller.kind === "operator") {
      if (!operatorRead || !caller.connId || !caller.scopes.some((s) => OPERATOR_READ.has(s))) {
        throw denied();
      }
      return {
        agentId: requestedAgent,
        scope: { visibility: "private" },
        healthOnly: false,
        sessionPrivate: false,
      };
    }
    // Background host calls are not session delegation. Session identity is a
    // host-minted audience; providers consume it without reconstructing lineage.
    if (caller.kind !== "session" || caller.sandboxed) {
      throw denied();
    }
    // Provider calls only read.
    const principal = audiencePrincipal(caller.audience, grants, false);
    if (principal.agentId !== requestedAgent) {
      throw denied();
    }
    return {
      ...principal,
      healthOnly: false,
      sessionPrivate: principal.scope.visibility === "private",
    };
  };
}

/** Scheduled maintenance acts on one store partition with no session,
 * operator or tool behind it. Only the plugin's own service code mints it
 * (Stores.openMaintenance); no feature, tool or provider path resolves to it,
 * and its writes are attributed to "maintenance", never an agent. */
const MAINTENANCE_AGENT = "knowledge-maintenance";
export function maintenancePrincipal(scope: Partition): Principal {
  return { agentId: MAINTENANCE_AGENT, scope };
}

/** Whether a feature caller may change store assignments (spec §7). A host that
 * cannot confirm the caller live at publication cannot accept assignment changes. */
export function canChangeAssignments(context: FeatureInvocationContext): boolean {
  return (
    context.source === "session-action" &&
    Boolean(context.action.client?.connId) &&
    Boolean(context.action.client?.scopes.includes("operator.admin")) &&
    typeof context.action.client?.assertCurrent === "function"
  );
}

/** Live: throws once the operator's request authority has ended. Assignment
 * writes pass this to the config writer, which checks it at publication. */
export function assertCallerCurrent(context: FeatureInvocationContext): void {
  if (context.source !== "session-action" || !context.action.client?.assertCurrent) {
    throw new Error("Knowledge can't confirm the operator's access; nothing was changed.");
  }
  context.action.client.assertCurrent();
}

/** Pin a principal: later checks fail if live authority now resolves differently. */
export function pinPrincipal<P extends Principal>(
  resolve: () => P,
): { principal: P; assertSame(): void } {
  const principal = resolve(),
    identity = JSON.stringify(principal);
  return {
    principal,
    assertSame() {
      if (JSON.stringify(resolve()) !== identity) {
        throw denied();
      }
    },
  };
}
