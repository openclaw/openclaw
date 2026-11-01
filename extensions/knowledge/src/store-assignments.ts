import { createHash } from "node:crypto";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import {
  assertCallerCurrent,
  canChangeAssignments,
  featurePrincipal,
  pinPrincipal,
} from "./access.js";
import { RegistryUnavailable } from "./registry-client.js";
import { bindingState, type RegistrySnapshot } from "./store-registry.js";
import {
  STORES_CONFIG_PATH,
  agentIdPattern,
  canonicalJson,
  effectiveBinding,
  grantsRevision,
  parseMembership,
  readStoresSection,
  storesRevision,
  type ConversationGrants,
  type StoresSection,
} from "./stores-config.js";
import type {
  GrantChangeInput,
  StoreEntry,
  StoresChangeInput,
  StoresChangeOutput,
  StoresSnapshot,
} from "./stores-contract.js";
import { changedAgents, type Stores } from "./stores.js";

type Outcome = StoresChangeOutput["outcome"];
const OPERATOR_READ = new Set(["operator.read", "operator.write", "operator.admin"]);
/** Change rejected before anything was journaled or written. */
class Rejected extends Error {
  constructor(
    readonly outcome: Outcome,
    message: string,
  ) {
    super(message);
  }
}
class ConfigConflict extends Error {}

/** Typed operator operations for store assignments (spec §7). */
export function createStoreOperations(stores: Stores) {
  const api = stores.api;
  const displayName = (agent: string) => {
    try {
      return (
        api.runtime.agent
          .resolveAgentIdentity(
            // SAFETY: resolveAgentIdentity only reads the config; the host snapshot is typed deeply readonly.
            stores.hostConfig() as Parameters<typeof api.runtime.agent.resolveAgentIdentity>[0],
            agent,
          )
          ?.name?.trim() || agent
      );
    } catch {
      return agent;
    }
  };
  const requireOperator = (context: FeatureInvocationContext) => {
    if (
      context.source !== "session-action" ||
      !stores.policy.operatorRead ||
      !context.action.client?.connId ||
      !context.action.client.scopes.some((s) => OPERATOR_READ.has(s))
    ) {
      throw new Error("Store settings are available to authorized operators only.");
    }
  };
  const writable = () => typeof api.runtime.config.mutateConfigFile === "function";

  /** Non-provisioning inventory. Counts come only from stores already running. */
  async function snapshot(context: FeatureInvocationContext): Promise<StoresSnapshot> {
    let registry: RegistrySnapshot | undefined, failure: string | undefined;
    try {
      registry = await stores.ensure();
    } catch (e) {
      if (!(e instanceof RegistryUnavailable)) {
        throw e;
      }
      failure = e.message;
    }
    const membership = stores.membership(),
      agents = stores.agents(),
      names = new Map(agents.map((a) => [a, displayName(a)]));
    const state = (binding: string) =>
      registry ? bindingState(registry, binding) : ("recovery-required" as const);
    const entries: StoreEntry[] = [];
    const members = (key: string) =>
      (membership.section[key]?.agents ?? []).filter((a) => membership.assigned.get(a) === key);
    for (const [key, store] of Object.entries(membership.section)) {
      entries.push({
        binding: `named:${key}`,
        kind: "named",
        key,
        label: store.label ?? key,
        members: members(key),
        retained: false,
        state: state(`named:${key}`),
        records: null,
      });
    }
    for (const [binding] of Object.entries(registry?.bindings ?? {})) {
      // SAFETY: registry bindings are only ever written as `agent:`/`named:`-prefixed Binding values.
      const [kind, id] = binding.split(/:(.*)/s) as [string, string];
      if (kind === "named" && !membership.section[id]) {
        entries.push({
          binding,
          kind: "named",
          key: id,
          label: registry!.labels[binding] ?? id,
          members: [],
          retained: true,
          state: state(binding),
          records: null,
        });
      } else if (kind === "agent") {
        entries.push({
          binding,
          kind: "isolated",
          owner: id,
          label: names.get(id) ?? id,
          members: effectiveBinding(membership, id) === binding ? [id] : [],
          retained: !agents.includes(id),
          state: state(binding),
          records: null,
        });
      }
    }
    // Agents using a default that does not exist yet still appear, unprovisioned.
    for (const agent of agents) {
      const binding = `agent:${agent}`;
      if (
        agentIdPattern.test(agent) &&
        effectiveBinding(membership, agent) === binding &&
        !registry?.bindings[binding]
      ) {
        entries.push({
          binding,
          kind: "isolated",
          owner: agent,
          label: names.get(agent) ?? agent,
          members: [agent],
          retained: false,
          state: "unprovisioned",
          records: null,
        });
      }
    }
    await countRecords(entries, registry, context);
    const canChange = canChangeAssignments(context) && writable() && !failure && !registry?.pending;
    const grants = stores.grants(),
      client = context.source === "session-action" ? context.action.client : undefined;
    return {
      revision: membership.revision,
      // Only grants for agents this operator's role covers; keys name conversations.
      grants: {
        revision: grants.revision,
        entries: Object.entries(grants.section)
          .map(([sessionKey, access]) => ({ sessionKey, agent: grantAgent(sessionKey), access }))
          .filter((entry) => client?.allowsAgent?.(entry.agent) ?? true),
      },
      ...(stores.defaultAgent() ? { defaultAgent: stores.defaultAgent() } : {}),
      agents: agents.map((id) => {
        const supported = agentIdPattern.test(id),
          binding = supported ? effectiveBinding(membership, id) : undefined;
        return Object.assign(
          { id, name: names.get(id) ?? id, supported },
          binding ? { binding } : {},
          !supported
            ? { issue: "This agent ID can't be used with Knowledge stores." }
            : !binding
              ? {
                  issue:
                    "This agent is assigned to more than one store; fix the stores configuration.",
                }
              : {},
        );
      }),
      stores: entries,
      canChange,
      ...(canChange
        ? {}
        : {
            changeUnavailable: failure
              ? "The store registry needs recovery before assignments can change."
              : registry?.pending
                ? "An assignment change is still being applied."
                : !writable()
                  ? "This OpenClaw version can't save Knowledge settings."
                  : "Changing store assignments requires operator admin access.",
          }),
      issues: [...(failure ? [failure] : []), ...membership.issues].slice(0, 50),
    };
  }
  // Private-partition counts for running stores, read through their lanes
  // with this operator's live authority. Stores not running stay unknown.
  async function countRecords(
    entries: StoreEntry[],
    registry: RegistrySnapshot | undefined,
    context: FeatureInvocationContext,
  ) {
    await Promise.all(
      entries.map(async (entry) => {
        const vaultId = registry?.bindings[entry.binding],
          runtime = vaultId ? stores.running(vaultId) : undefined,
          client = context.source === "session-action" ? context.action.client : undefined,
          // Count through a member this operator may browse; a count is private metadata.
          agentId = [...entry.members, entry.owner].find(
            (id) => id && (client?.allowsAgent?.(id) ?? true),
          );
        if (!runtime || entry.state !== "ready" || !agentId) {
          return;
        }
        try {
          // The same live policy as operator browsing: role agents, shared-Gateway admin.
          const pinned = pinPrincipal(
            featurePrincipal(context, stores.policy.operatorRead, false, agentId, stores.grantFor),
          );
          const access = {
            ...pinned.principal,
            assertCurrent: () => {
              pinned.assertSame();
              if (runtime.retired) {
                throw new Error("Store runtime retired.");
              }
            },
          };
          entry.records = (
            await runtime.enqueue(access.assertCurrent, () =>
              runtime.client.call("catalog", access),
            )
          ).records;
        } catch {
          entry.records = null;
        }
      }),
    );
  }

  // Build the next membership section for a change, or reject it.
  function plan(input: StoresChangeInput, registry: RegistrySnapshot) {
    const membership = stores.membership(),
      agents = stores.agents(),
      section: StoresSection = structuredClone(membership.section);
    if (!agents.includes(input.agent) || !agentIdPattern.test(input.agent)) {
      throw new Rejected("invalid", "Unknown agent.");
    }
    const current = effectiveBinding(membership, input.agent);
    if (!current) {
      throw new Rejected(
        "invalid",
        "This agent's assignment is invalid; fix the stores configuration first.",
      );
    }
    const leave = (agent: string) => {
      for (const store of Object.values(section)) {
        store.agents = store.agents.filter((a) => a !== agent);
      }
    };
    const requested = input.change;
    let rebind: { from: string; to: string; label: string } | null = null;
    if (requested.kind === "share_existing") {
      if (current !== `agent:${input.agent}`) {
        throw new Rejected("invalid", "Only an agent's own store can be shared from here.");
      }
      const sourceState = bindingState(registry, current);
      if (sourceState !== "ready") {
        throw new Rejected(
          "invalid",
          sourceState === "unprovisioned"
            ? "This store hasn't been created yet, so there is nothing to share."
            : "This store needs recovery before it can be shared.",
        );
      }
      const label = requested.label.trim(),
        others = [...new Set(requested.agents)];
      if (!label) {
        throw new Rejected("invalid", "Enter a name for the shared store.");
      }
      const taken = new Set([
        ...Object.entries(section).map(([key, s]) => (s.label ?? key).toLowerCase()),
        ...Object.values(registry.labels).map((l) => l.toLowerCase()),
      ]);
      if (taken.has(label.toLowerCase())) {
        throw new Rejected("invalid", "Another store already uses this name.");
      }
      if (others.some((a) => a === input.agent || !agents.includes(a) || !agentIdPattern.test(a))) {
        throw new Rejected("invalid", "Choose other existing agents to share with.");
      }
      const key = storeKey(
        label,
        new Set([
          ...Object.keys(section),
          ...Object.keys(registry.bindings)
            .filter((b) => b.startsWith("named:"))
            .map((b) => b.slice(6)),
        ]),
      );
      for (const agent of [input.agent, ...others]) {
        leave(agent);
      }
      section[key] = { label, agents: [input.agent, ...others] };
      rebind = { from: current, to: `named:${key}`, label };
    } else if (requested.kind === "use_named") {
      const retained = registry.bindings[`named:${requested.store}`] !== undefined;
      if (!section[requested.store] && !retained) {
        throw new Rejected("invalid", "That shared store doesn't exist.");
      }
      const targetState = bindingState(registry, `named:${requested.store}`);
      if (targetState === "unavailable" || targetState === "recovery-required") {
        throw new Rejected("invalid", "That store couldn't be opened and needs recovery first.");
      }
      if (current === `named:${requested.store}`) {
        throw new Rejected("invalid", "This agent already uses that store.");
      }
      leave(input.agent);
      section[requested.store] ??= {
        ...(registry.labels[`named:${requested.store}`]
          ? { label: registry.labels[`named:${requested.store}`] }
          : {}),
        agents: [],
      };
      section[requested.store]!.agents.push(input.agent);
    } else {
      if (current === `agent:${input.agent}`) {
        throw new Rejected("invalid", "This agent already uses its own store.");
      }
      const ownState = bindingState(registry, `agent:${input.agent}`);
      if (ownState === "unavailable" || ownState === "recovery-required") {
        throw new Rejected("invalid", "This agent's previous store needs recovery first.");
      }
      leave(input.agent);
    }
    const next = parseMembership(section);
    if (next.issues.some((issue) => issue.includes("assigned to both"))) {
      throw new Rejected("invalid", "That change would assign an agent to two stores.");
    }
    return {
      section,
      revision: next.revision,
      rebind,
      affected: changedAgents(membership, next, agents),
    };
  }

  async function change(
    input: StoresChangeInput,
    context: FeatureInvocationContext,
  ): Promise<StoresChangeOutput> {
    requireOperator(context);
    if (!canChangeAssignments(context)) {
      return {
        outcome: "forbidden",
        message: "Changing store assignments requires operator admin access. Nothing was changed.",
      };
    }
    if (!writable()) {
      return {
        outcome: "forbidden",
        message: "This OpenClaw version can't save Knowledge settings. Nothing was changed.",
      };
    }
    const intent = digest(
      canonicalJson({
        agent: input.agent,
        change: input.change,
        expectedRevision: input.expectedRevision,
      }),
    );
    const registry = await stores.ensure();
    const prior = await stores.registry.call("operation", input.requestId);
    if (prior) {
      if (prior.intent !== intent) {
        return {
          outcome: "invalid",
          message: "This request ID belongs to a different change. Nothing was changed.",
        };
      }
      return status({ requestId: input.requestId }, context);
    }
    if (stores.membership().revision !== input.expectedRevision) {
      return {
        outcome: "conflict",
        message:
          "Store settings changed since you opened them. Review the current assignments and save again.",
        snapshot: await snapshot(context),
      };
    }
    let next;
    try {
      next = plan(input, registry);
    } catch (e) {
      if (e instanceof Rejected) {
        return { outcome: e.outcome, message: `${e.message} Nothing was changed.` };
      }
      throw e;
    }
    try {
      await stores.registry.call("begin", {
        requestId: input.requestId,
        intent,
        expectedRevision: input.expectedRevision,
        nextSection: canonicalJson(next.section),
        nextRevision: next.revision,
        rebind: next.rebind,
      });
    } catch (e) {
      // An identical concurrent request may have journaled first: report its outcome.
      const raced = await stores.registry.call("operation", input.requestId);
      if (raced?.intent === intent) {
        return status({ requestId: input.requestId }, context);
      }
      // SAFETY: the registry client rejects only with Error objects.
      return { outcome: "conflict", message: `${(e as Error).message} Nothing was changed.` };
    }
    stores.activeChange = input.requestId;
    // SAFETY: widens the literal to Outcome; the cutover callback reassigns it, which narrowing cannot see.
    let outcome = "applied" as Outcome,
      message = "Assignment saved.";
    try {
      await stores.cutover(next.affected, async () => {
        try {
          await api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            // The operator may disconnect or lose access while this change waits
            // for the registry, store lanes and the config lock.
            writeOptions: { assertCurrent: () => assertCallerCurrent(context) },
            mutate(draft) {
              // Compare only the stores section; unrelated edits never conflict.
              if (storesRevision(readStoresSection(draft)) !== input.expectedRevision) {
                throw new ConfigConflict();
              }
              writeStoresSection(draft, next.section);
            },
          });
        } catch (e) {
          outcome = e instanceof ConfigConflict ? "conflict" : "unknown";
          message =
            e instanceof ConfigConflict
              ? "Store settings changed while saving. Nothing was changed; review and save again."
              : `Saving settings failed: ${(e as Error).message}`; // SAFETY: config writes throw only Error objects.
          // A failed write before persistence leaves config unchanged; if the
          // outcome is uncertain the journal stays pending for reconciliation.
          if (outcome === "conflict") {
            await stores.registry.call("settle", input.requestId, "conflict", message, false);
          }
          return;
        }
        // The host publishes this write to config.current() shortly after it
        // resolves; until then the prior revision is expected lag, not an edit.
        stores.expectLag(input.expectedRevision);
        await stores.registry.call("settle", input.requestId, "applied", message, true);
      });
    } finally {
      stores.activeChange = undefined;
    }
    // Reconcile the same request against the persisted configuration.
    if (outcome === "unknown") {
      return status({ requestId: input.requestId }, context);
    }
    return { outcome, message, snapshot: await snapshot(context) };
  }

  /** Owner direction: an operator admin grants, changes or revokes one
   * conversation's access to its agent's private partition. Grants are
   * Knowledge state in the registry, not configuration. No journal or cutover:
   * a grant never moves a physical store, the registry write is one
   * compare-and-set, and every in-flight principal re-resolves grants at its
   * next live check, so a revocation fences work that has not yet published. */
  async function grant(
    input: GrantChangeInput,
    context: FeatureInvocationContext,
  ): Promise<StoresChangeOutput> {
    requireOperator(context);
    if (!canChangeAssignments(context)) {
      return {
        outcome: "forbidden",
        message:
          "Changing conversation access requires operator admin access. Nothing was changed.",
      };
    }
    const agent = grantAgent(input.sessionKey);
    const client = context.source === "session-action" ? context.action.client : undefined;
    await stores.ensure();
    const conflict = async (): Promise<StoresChangeOutput> => ({
      outcome: "conflict",
      message:
        "Conversation access changed since you opened it. Review the current access and save again.",
      snapshot: await snapshot(context),
    });
    const current = stores.grants();
    if (current.revision !== input.expectedRevision) {
      return conflict();
    }
    if (input.access !== "none" && !stores.agents().includes(agent)) {
      return { outcome: "invalid", message: "Unknown agent. Nothing was changed." };
    }
    // The settings snapshot lists at most MAX_GRANTS; refuse more rather than hide them.
    if (
      input.access !== "none" &&
      !Object.hasOwn(current.section, input.sessionKey) &&
      Object.keys(current.section).length >= MAX_GRANTS
    ) {
      return {
        outcome: "invalid",
        message: `At most ${MAX_GRANTS} conversations can have access; remove one first. Nothing was changed.`,
      };
    }
    const next: ConversationGrants = { ...current.section };
    if (input.access === "none") {
      delete next[input.sessionKey];
    } else {
      next[input.sessionKey] = input.access;
    }
    // Checked at the write: the operator may have disconnected, or lost this
    // agent from their role, while this waited.
    assertCallerCurrent(context);
    if (client?.allowsAgent && !client.allowsAgent(agent)) {
      return {
        outcome: "forbidden",
        message: `Your operator role does not include agent "${agent}". Nothing was changed.`,
      };
    }
    await stores.registry.call("grant", input.sessionKey, input.access, input.expectedRevision);
    if (stores.grants().revision !== grantsRevision(next)) {
      return conflict();
    }
    // The registry worker can't consult caller authority, so recheck once the
    // write has committed and undo it if the operator lost access meanwhile. A
    // crash between the two leaves the grant (accepted: rare, visible, revocable).
    const stillAllowed = () => {
      try {
        assertCallerCurrent(context);
      } catch {
        return false;
      }
      return !client?.allowsAgent || client.allowsAgent(agent);
    };
    if (!stillAllowed()) {
      const previous = current.section[input.sessionKey] ?? "none";
      await stores.registry.call("grant", input.sessionKey, previous, grantsRevision(next));
      return {
        outcome: "forbidden",
        message: `Your operator access to agent "${agent}" ended while saving. Nothing was changed.`,
      };
    }
    return {
      outcome: "applied",
      message: input.access === "none" ? "Access removed." : "Access saved.",
      snapshot: await snapshot(context),
    };
  }

  async function status(
    input: { requestId: string },
    context: FeatureInvocationContext,
  ): Promise<StoresChangeOutput> {
    requireOperator(context);
    if (stores.activeChange !== input.requestId) {
      await stores.ensure();
    }
    const op = await stores.registry.call("operation", input.requestId);
    if (!op) {
      return {
        outcome: "not-applied",
        message: "No change was recorded with this request ID; nothing was changed.",
      };
    }
    const outcome: Outcome = op.state === "pending" ? "pending" : op.state;
    return {
      outcome,
      message: op.message,
      ...(outcome === "pending" ? {} : { snapshot: await snapshot(context) }),
    };
  }

  return {
    stores_snapshot: async (_: unknown, context: FeatureInvocationContext) => {
      requireOperator(context);
      return snapshot(context);
    },
    stores_change: change,
    stores_grant: grant,
    stores_change_status: status,
  };
}

function writeStoresSection(draft: Record<string, unknown>, section: StoresSection) {
  let node = draft;
  for (const key of STORES_CONFIG_PATH.slice(0, -1)) {
    const child = node[key];
    // SAFETY: the node is an existing non-null config object (checked) or a fresh {}.
    node = (node[key] = child && typeof child === "object" ? child : {}) as Record<string, unknown>;
  }
  node[STORES_CONFIG_PATH.at(-1)!] = section;
}
// Matches the snapshot schema's grant entry bound.
const MAX_GRANTS = 500;
// The agent a grant's session key belongs to (the key pattern guarantees the shape).
const grantAgent = (sessionKey: string) => sessionKey.split(":", 2)[1]!;
// Collision-safe key from a display name; keys never come from the browser.
function storeKey(label: string, taken: Set<string>) {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/^[^a-z]+/, "")
      .slice(0, 40) || "shared";
  let key = base,
    n = 2;
  while (taken.has(key)) {
    key = `${base}-${n++}`;
  }
  return key;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
