import path from "node:path";
import { listAgentIds, tryResolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  maintenancePrincipal,
  pinPrincipal,
  type Partition,
  type Principal,
  type VaultAccess,
} from "./access.js";
import { RegistryClient } from "./registry-client.js";
import { KnowledgeRestartError } from "./restart-error.js";
import { bindingState, type RegistrySnapshot } from "./store-registry.js";
import { StoreRuntime } from "./store-runtime.js";
import {
  agentIdPattern,
  canonicalJson,
  effectiveBinding,
  parseMembership,
  readStoresSection,
  storesRevision,
  type Membership,
  type Policy,
} from "./stores-config.js";
import type { StoreState } from "./stores-contract.js";

const reloaded = () =>
  new KnowledgeRestartError(
    "service-reloaded",
    "Knowledge service was reloaded; retry the original request.",
  );
const reassigned = () =>
  new Error("This agent's knowledge store assignment changed; retry the original request.");
const denied = () =>
  new Error("Knowledge access unavailable: trusted agent/session authority is required.");
/** A store resolved for use, or the reason it cannot be used yet. */
export type Opened =
  | { kind: "ready"; runtime: StoreRuntime; access: VaultAccess; binding: string }
  | { kind: Exclude<StoreState, "ready">; agentId: string; binding?: string; message: string };
type Host = Pick<OpenClawPluginApi, "runtime">;

/** Main-thread owner of store resolution (spec §5, §6). Membership comes from
 * the registry's reconciled copy of configuration; physical stores come from
 * registry bindings; each physical store gets one lazily started runtime. */
export class Stores {
  readonly registry: RegistryClient;
  private readonly runtimes = new Map<string, StoreRuntime>();
  private readonly provisioning = new Map<string, Promise<RegistrySnapshot>>();
  private readonly fenced = new Set<string>();
  private memo?: Membership;
  private syncing?: Promise<void>;
  // Revisions config.current() may report until the host publishes our write.
  private readonly lagging = new Set<string>();
  /** Request ID of an assignment change this process is applying right now. */
  activeChange?: string;
  private epoch = 0;
  private current = true;
  // Stops whose workers may still be exiting; disposal waits for all of them.
  private readonly stopping = new Set<Promise<void>>();
  constructor(
    readonly api: Host,
    readonly policy: Policy,
    private readonly changed: () => void,
  ) {
    this.registry = new RegistryClient(() =>
      path.join(api.runtime.state.resolveStateDir(), "knowledge"),
    );
  }

  hostConfig() {
    return this.api.runtime.config.current();
  }
  /** Host agents, as configured. Knowledge binds only IDs it can represent. */
  agents(): string[] {
    return listAgentIds(this.hostConfig());
  }
  /** The configured default agent, or undefined when several agents are
   * configured without one (operators must then choose an agent explicitly). */
  defaultAgent(): string | undefined {
    return tryResolveDefaultAgentId(this.hostConfig());
  }
  /** The membership Knowledge enforces: the registry's reconciled section. */
  membership(): Membership {
    const reconciled = this.registry.current?.reconciled;
    const revision = reconciled?.revision ?? storesRevision({});
    if (this.memo?.revision !== revision) {
      this.memo = parseMembership(reconciled ? JSON.parse(reconciled.section) : {});
    }
    return this.memo;
  }
  /** Physical store currently serving an agent, if any. */
  vaultFor(agentId: string): string | undefined {
    const binding = effectiveBinding(this.membership(), agentId);
    return binding && this.registry.current?.bindings[binding];
  }
  isFenced(agentId: string) {
    return this.fenced.has(agentId);
  }

  /** Load the registry and apply any configuration it has not reconciled.
   * Callers await this before resolving; affected agents wait, then resolve
   * against the new assignment. */
  async ensure(): Promise<RegistrySnapshot> {
    this.assertLive(this.epoch);
    if (!this.registry.current) {
      await this.registry.load();
    }
    if (this.activeChange) {
      return this.registry.current!;
    }
    const raw = readStoresSection(this.hostConfig()),
      revision = storesRevision(raw);
    const snapshot = this.registry.current!;
    if (!snapshot.pending && snapshot.reconciled?.revision === revision) {
      this.lagging.clear();
      return snapshot;
    }
    this.syncing ??= this.reconcile(raw, revision).finally(() => {
      this.syncing = undefined;
    });
    await this.syncing;
    return this.registry.current!;
  }
  // Settle a crashed change, then adopt external edits (spec §7). The
  // persisted file is the witness: config.current() can lag a write.
  private async reconcile(raw: unknown, revision: string) {
    const pending = this.registry.current!.pending;
    if (pending) {
      const persisted = await this.persistedSection();
      const persistedRevision = storesRevision(persisted);
      const outcome =
        persistedRevision === pending.nextRevision
          ? "applied"
          : persistedRevision === pending.expectedRevision
            ? "not-applied"
            : "conflict";
      // A shared store keeps its data whenever the persisted config names it with its sharer.
      const rebind = pending.rebind !== null && namesSharer(persisted, pending.rebind);
      const before = this.membership();
      const settle = () =>
        this.registry.call(
          "settle",
          pending.requestId,
          outcome,
          outcome === "applied"
            ? "Applied (recovered after interruption)."
            : outcome === "not-applied"
              ? "Not applied: the configuration was never changed."
              : "Configuration changed outside this request; review assignments.",
          rebind,
        );
      if (outcome !== "applied") {
        await settle();
      } else {
        await this.cutover(
          changedAgents(before, parseMembership(JSON.parse(pending.nextSection)), this.agents()),
          settle,
        );
        return;
      }
    }
    // Right after this plugin's own write, config.current() still reports the
    // previous revision; ignore it only while the file confirms the write.
    if (
      this.lagging.has(revision) &&
      storesRevision(await this.persistedSection()) === this.registry.current!.reconciled?.revision
    ) {
      return;
    }
    this.lagging.clear();
    const before = this.membership(),
      next = parseMembership(raw);
    await this.cutover(changedAgents(before, next, this.agents()), () =>
      this.registry.call("reconcile", canonicalJson(raw), revision),
    );
  }
  /** Record that config.current() may briefly report `revision` after a write. */
  expectLag(revision: string) {
    this.lagging.add(revision);
  }

  /** The stores section of the persisted config file. Reads it under the
   * host's config write lock and aborts before anything is written. */
  async persistedSection(): Promise<unknown> {
    let section: unknown,
      read = false;
    const probe = new Error("knowledge-stores-probe");
    try {
      await this.api.runtime.config.mutateConfigFile({
        afterWrite: { mode: "none", reason: "Knowledge reads the stores section" },
        mutate(draft) {
          section = structuredClone(readStoresSection(draft));
          read = true;
          throw probe;
        },
      });
    } catch (e) {
      if (e !== probe) {
        throw e;
      }
    }
    if (!read) {
      throw new Error("Could not read the persisted Knowledge stores configuration.");
    }
    return section;
  }

  /** Fence agents, drain their stores' lanes, apply, then release (spec §6).
   * Once `apply` resolves, no invocation bound to the old assignment can
   * release data or begin a publication: its next live check fails. */
  async cutover(agents: Iterable<string>, apply: () => Promise<unknown>) {
    const affected = [...agents];
    for (const agent of affected) {
      this.fenced.add(agent);
    }
    try {
      const vaults = new Set(
        affected.map((agent) => this.vaultFor(agent)).filter((v): v is string => Boolean(v)),
      );
      await Promise.all(
        [...vaults].map((vaultId) => this.runtimes.get(vaultId)?.drain() ?? Promise.resolve()),
      );
      await apply();
    } finally {
      for (const agent of affected) {
        this.fenced.delete(agent);
      }
    }
    await this.retireUnused();
  }
  // A runtime stops once its store serves no agent (no idle timer; spec §5.3).
  private async retireUnused() {
    const inUse = new Set(this.agents().map((agent) => this.vaultFor(agent)));
    await Promise.all(
      [...this.runtimes]
        .filter(([vaultId]) => !inUse.has(vaultId))
        .map(([vaultId, runtime]) => {
          this.runtimes.delete(vaultId);
          return runtime.retire();
        }),
    );
  }

  /** Resolve a caller to its effective store. Only `provision` callers (agent
   * knowledge operations, provider reads/search) may create a never-provisioned
   * store; inspection reports its state instead (spec §5.1). */
  async open(
    resolvePrincipal: () => Principal,
    options: { provision: boolean },
    epoch = this.epoch,
  ): Promise<Opened> {
    // The service incarnation is captured before any await: a reload while
    // this call waits must fail it rather than let it adopt the new epoch.
    await this.ensure();
    this.assertLive(epoch);
    const pinned = pinPrincipal(resolvePrincipal),
      agentId = pinned.principal.agentId;
    if (!agentIdPattern.test(agentId)) {
      throw denied();
    }
    if (this.fenced.has(agentId)) {
      throw reassigned();
    }
    const binding = effectiveBinding(this.membership(), agentId);
    if (!binding) {
      return {
        kind: "unavailable",
        agentId,
        message:
          "This agent's store assignment is invalid; review the Knowledge stores configuration.",
      };
    }
    let snapshot = this.registry.current!,
      state = bindingState(snapshot, binding, false);
    // Only a host agent's own first use creates storage.
    if (
      (state === "unprovisioned" || state === "initializing") &&
      options.provision &&
      this.agents().includes(agentId)
    ) {
      snapshot = await this.provision(binding);
      state = bindingState(snapshot, binding, false);
    }
    if (state !== "ready") {
      return { kind: state, agentId, binding, message: stateMessage(state) };
    }
    const vaultId = snapshot.bindings[binding]!,
      runtime = this.runtime(vaultId);
    const access: VaultAccess = {
      ...pinned.principal,
      assertCurrent: () => {
        this.assertLive(epoch);
        pinned.assertSame();
        if (this.fenced.has(agentId) || this.vaultFor(agentId) !== vaultId || runtime.retired) {
          throw reassigned();
        }
      },
    };
    access.assertCurrent();
    return { kind: "ready", runtime, access, binding };
  }
  /**
   * Every store the operator has defined that maintenance may visit: each
   * configured agent's effective store and every named store, deduplicated by
   * physical store. Stores that are not ready are reported, never created.
   */
  async maintenanceTargets(): Promise<
    {
      binding: string;
      label: string;
      vaultId?: string;
      state: Exclude<StoreState, "ready"> | "ready";
    }[]
  > {
    const snapshot = await this.ensure(),
      membership = this.membership();
    const bindings = new Set<string>([
      ...this.agents()
        .filter((agent) => agentIdPattern.test(agent))
        .map((agent) => effectiveBinding(membership, agent))
        .filter((b): b is NonNullable<typeof b> => Boolean(b)),
      ...Object.keys(membership.section).map((key) => `named:${key}`),
    ]);
    const seen = new Set<string>(),
      targets: Awaited<ReturnType<Stores["maintenanceTargets"]>> = [];
    for (const binding of [...bindings].toSorted()) {
      // SAFETY: every binding here is an `agent:`- or `named:`-prefixed Binding built above.
      const [kind, key] = binding.split(/:(.*)/s) as [string, string];
      const label =
        kind === "named" ? (membership.section[key]?.label ?? key) : `${key} (agent store)`;
      const state = bindingState(snapshot, binding, false),
        vaultId = snapshot.bindings[binding];
      if (vaultId && seen.has(vaultId)) {
        continue;
      }
      if (vaultId) {
        seen.add(vaultId);
      }
      targets.push({ binding, label, state, ...(vaultId ? { vaultId } : {}) });
    }
    return targets;
  }
  /** Maintenance access to one partition of a ready store. Never provisions.
   * Fails once the service reloads, the store is reassigned or retired. */
  openMaintenance(
    vaultId: string,
    scope: Partition,
    epoch = this.epoch,
  ): { runtime: StoreRuntime; access: VaultAccess } {
    this.assertLive(epoch);
    const bound = () => Object.values(this.registry.current?.bindings ?? {}).includes(vaultId);
    if (!bound() || !this.registry.current?.stores[vaultId]) {
      throw reassigned();
    }
    const runtime = this.runtime(vaultId);
    const access: VaultAccess = {
      ...maintenancePrincipal(scope),
      assertCurrent: () => {
        this.assertLive(epoch);
        if (!bound() || runtime.retired) {
          throw reassigned();
        }
      },
    };
    return { runtime, access };
  }
  // Concurrent first uses of one binding share one provisioning attempt.
  private provision(binding: string): Promise<RegistrySnapshot> {
    let attempt = this.provisioning.get(binding);
    if (!attempt) {
      attempt = this.registry
        .call("provision", binding)
        .finally(() => this.provisioning.delete(binding));
      this.provisioning.set(binding, attempt);
    }
    return attempt;
  }
  private runtime(vaultId: string): StoreRuntime {
    let runtime = this.runtimes.get(vaultId);
    if (!runtime) {
      const store = this.registry.current!.stores[vaultId]!;
      runtime = new StoreRuntime(
        {
          root: store.root,
          statePath: store.statePath,
          vaultId,
          publicationId: store.publicationId,
          writesEnabled: this.policy.writesEnabled,
          hubPercentile: this.policy.hubPercentile,
        },
        this.changed,
      );
      this.runtimes.set(vaultId, runtime);
      // Change hints carry no data; operator reads reconcile through authorized calls.
      if (this.policy.operatorRead) {
        runtime.live.start();
      }
    }
    return runtime;
  }
  /** Stop runtimes that only maintenance started; stores serving agents keep running. */
  releaseIdle() {
    return this.retireUnused();
  }
  /** Running runtime for a store, without starting one. */
  running(vaultId: string) {
    return this.runtimes.get(vaultId);
  }
  /** Wait for every running store's queued work (memory-provider reload drain). */
  async drainAll() {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.drain()));
  }

  /** Current service incarnation; leases compare against it. */
  get incarnation() {
    return this.epoch;
  }
  assertLive(epoch: number) {
    if (!this.current || epoch !== this.epoch) {
      throw reloaded();
    }
  }
  /** Plugin service lifecycle. Stopping fences the current incarnation at once,
   * retires every runtime after queued work settles, waits for `settled` (work
   * outside the lanes that still writes through the registry), then closes the
   * registry unless the service restarted meanwhile. Resolves once those workers
   * have exited. */
  start() {
    ++this.epoch;
    this.current = true;
  }
  stop(settled: Promise<unknown> = Promise.resolve()): Promise<void> {
    ++this.epoch;
    this.current = false;
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    const stopped = Promise.allSettled([
      ...runtimes.map((runtime) => runtime.retire()),
      settled,
    ]).then(() => (this.current ? undefined : this.registry.close()));
    this.stopping.add(stopped);
    const forget = () => {
      this.stopping.delete(stopped);
    };
    stopped.then(forget, forget);
    return stopped;
  }
  /** Plugin instance disposal: stop for good once every earlier stop has
   * finished. No worker starts afterwards; resolves once all have exited. */
  async dispose(settled?: Promise<unknown>): Promise<void> {
    await Promise.all([this.stop(settled), ...this.stopping]);
    await this.registry.dispose();
  }
}

// Whether a persisted section assigns a share's originating agent to the new store.
function namesSharer(section: unknown, rebind: { from: string; to: string }) {
  const key = rebind.to.slice("named:".length),
    agent = rebind.from.slice("agent:".length);
  const store =
    section && typeof section === "object"
      ? (section as Record<string, { agents?: unknown }>)[key] // SAFETY: non-null object (checked); agents verified below.
      : undefined;
  return Array.isArray(store?.agents) && store.agents.includes(agent);
}

/** Agents whose effective binding differs between two memberships. */
export function changedAgents(before: Membership, after: Membership, known: string[]): Set<string> {
  const agents = new Set([
    ...known,
    ...before.assigned.keys(),
    ...before.invalid,
    ...after.assigned.keys(),
    ...after.invalid,
  ]);
  return new Set(
    [...agents].filter(
      (agent) => effectiveBinding(before, agent) !== effectiveBinding(after, agent),
    ),
  );
}

const STATE_MESSAGES: Record<Exclude<StoreState, "ready">, string> = {
  unprovisioned: "This store is created on first authorized use.",
  initializing: "This store is being created.",
  unavailable:
    "This store couldn't be opened; its files or database are missing. Recovery review is required.",
  "recovery-required": "The Knowledge store registry needs recovery review.",
};

function stateMessage(state: Exclude<StoreState, "ready">) {
  return STATE_MESSAGES[state];
}
