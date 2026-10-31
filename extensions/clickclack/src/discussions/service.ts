import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import type { OpenClawPluginGatewayEvents, PluginRuntime } from "openclaw/plugin-sdk/core";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type {
  SessionDiscussionInfo,
  SessionDiscussionProvider,
} from "openclaw/plugin-sdk/session-discussion";
import { createClickClackClient, type ClickClackClient } from "../http-client.js";
import { findClickClackWorkspace } from "../resolve.js";
import type { CoreConfig, ResolvedClickClackAccount } from "../types.js";
import {
  clearDiscussionBindingGeneration,
  getPendingDiscussionOpen,
  listPendingDiscussionOpens,
} from "./binding-generation.js";
import { DetachedDiscussionBindingRetention } from "./binding-retention.js";
import {
  attachBindingToCurrentActiveSession,
  getClickClackDiscussionBindingStore,
  readDiscussionSessionEntry,
  type ClickClackDiscussionBinding,
  type ClickClackDiscussionBindingStore,
} from "./binding-store.js";
import { controlSessionUrl } from "./control-session-url.js";
import {
  discussionAccounts,
  discussionInfoForBinding,
  resolveDiscussionBindingAccount,
  type DiscussionBindingAccountResolution,
} from "./eligibility.js";
import { getClickClackDiscussionInstallationId } from "./installation.js";
import {
  fallbackDiscussionLabel,
  resolveDiscussionLabel,
  truncateDiscussionDisplayTitle,
} from "./naming.js";
import {
  isClickClackDiscussionChannelRevokedAsync,
  markClickClackDiscussionChannelRevoked,
  prepareClickClackDiscussionChannelRevocation,
} from "./revoked-channel-store.js";
import { readDiscussionHistory } from "./service-history.js";
import {
  assertChannelPatch,
  finalizePendingDiscussionBinding,
  reconcilePendingDiscussionOpen,
  openClickClackDiscussionBinding,
  renameDiscussionChannel,
} from "./service-open.js";
import { prepareDiscussionSessionEntry } from "./session-authority.js";

const RECONCILE_INTERVAL_MS = 60_000;
const RECONCILE_DEBOUNCE_MS = 250;
const RECONCILE_RETRY_MS = 1_000;
const RECONCILE_RETRY_MAX_MS = 60_000;

type DiscussionBindingUseResolution = DiscussionBindingAccountResolution | { state: "retargeted" };

export class ClickClackDiscussionService {
  readonly provider: SessionDiscussionProvider;
  readonly #runtime: PluginRuntime;
  readonly #store: ClickClackDiscussionBindingStore;
  readonly #clientFactory: (account: ResolvedClickClackAccount) => ClickClackClient;
  #installationId: string | undefined;
  readonly #detachedBindings: DetachedDiscussionBindingRetention;
  readonly #sessionQueue = new KeyedAsyncQueue();
  #scheduler: PluginServiceSchedulerV1 | undefined;
  #scheduleReconcile: ((sessionKey: string, delayMs?: number) => void) | undefined;
  readonly #withChannelMutationLock = createAsyncLock();
  #timer: ReturnType<PluginServiceSchedulerV1["schedule"]> | undefined;
  #unsubscribeSessionsChanged: (() => void) | undefined;
  #closed = false;
  #cleanupPromise: Promise<void> | undefined;
  readonly #operations = new Set<Promise<unknown>>();

  constructor(runtime: PluginRuntime) {
    this.#runtime = runtime;
    this.#store = getClickClackDiscussionBindingStore(runtime);
    this.#clientFactory = (account) =>
      createClickClackClient({ baseUrl: account.apiEndpoint, token: account.token });
    this.#detachedBindings = new DetachedDiscussionBindingRetention({
      runtime,
      store: this.#store,
    });
    this.provider = {
      id: "clickclack",
      info: ({ sessionKey }) => this.info(sessionKey),
      open: ({ sessionKey }) => this.open(sessionKey),
    };
  }

  async bindGatewayEvents(
    gatewayEvents: Pick<OpenClawPluginGatewayEvents, "onSessionsChanged"> | undefined,
    scheduler: PluginServiceSchedulerV1,
  ): Promise<void> {
    if (this.#cleanupPromise) {
      await this.#cleanupPromise;
    }
    if (this.#scheduler) {
      await this.#scheduler.stop();
    }
    this.#cleanupPromise = undefined;
    this.#unsubscribeSessionsChanged?.();
    this.#closed = false;
    this.#scheduler = scheduler.scope();
    this.#timer = undefined;
    const activationScheduler = this.#scheduler;
    /**
     * Per-session debounced reconcile scheduling with failure backoff.
     * Contracts: bursts coalesce onto the earliest scheduled run (steady event
     * traffic can never postpone one); a failed run sets a not-before floor with
     * growing backoff that later events cannot undercut; events during an
     * in-flight run collapse into one follow-up scheduled after settlement; and
     * each service activation owns a separate scheduler scope and retry state.
     */
    const retryState = new Map<string, { delayMs: number; notBefore: number }>();
    const inFlight = new Set<string>();
    const followUps = new Set<string>();
    const scheduleReconcile = (sessionKey: string, delayMs = RECONCILE_DEBOUNCE_MS): void => {
      if (activationScheduler.signal.aborted) {
        return;
      }
      if (inFlight.has(sessionKey)) {
        followUps.add(sessionKey);
        return;
      }
      const retry = retryState.get(sessionKey);
      const fireAt = Math.max(activationScheduler.now() + delayMs, retry?.notBefore ?? 0);
      activationScheduler.schedule({
        id: `session:${sessionKey}`,
        atMs: fireAt,
        mode: "earliest",
        run: async () => {
          inFlight.add(sessionKey);
          try {
            await this.reconcile(sessionKey);
            retryState.delete(sessionKey);
          } catch (error) {
            if (activationScheduler.signal.aborted) {
              return;
            }
            const previous = retryState.get(sessionKey);
            const nextRetryMs = Math.min(
              previous === undefined ? RECONCILE_RETRY_MS : previous.delayMs * 2,
              RECONCILE_RETRY_MAX_MS,
            );
            retryState.set(sessionKey, {
              delayMs: nextRetryMs,
              notBefore: activationScheduler.now() + nextRetryMs,
            });
            this.#logger().warn(
              `discussion event reconcile failed for ${sessionKey}; retrying in ${nextRetryMs}ms: ${String(error)}`,
            );
            followUps.add(sessionKey);
          } finally {
            inFlight.delete(sessionKey);
            if (!activationScheduler.signal.aborted && followUps.delete(sessionKey)) {
              scheduleReconcile(sessionKey);
            }
          }
        },
      });
    };
    this.#scheduleReconcile = scheduleReconcile;
    this.#unsubscribeSessionsChanged = gatewayEvents?.onSessionsChanged((event) => {
      void this.#withOperation(async () => {
        if (
          (await this.#store.getAsync(event.sessionKey)) ||
          (await getPendingDiscussionOpen(this.#runtime, event.sessionKey))
        ) {
          this.#scheduleReconcile?.(event.sessionKey);
        }
      }).catch((error: unknown) => {
        this.#logger().warn(`discussion event admission failed: ${String(error)}`);
      });
    });
    await this.#withOperation(async () => {
      for (const sessionKey of await this.#listReconcileSessionKeys()) {
        this.#scheduleReconcile?.(sessionKey, 0);
      }
      await this.#ensureTimer();
    });
  }

  hasEnabledAccount(): boolean {
    return discussionAccounts(this.#currentConfig()).length === 1;
  }

  resolveBindingAccount(binding: ClickClackDiscussionBinding): DiscussionBindingAccountResolution {
    return resolveDiscussionBindingAccount(this.#currentConfig(), binding);
  }

  async info(sessionKey: string): Promise<SessionDiscussionInfo> {
    return await this.#withOperation(() =>
      this.#sessionQueue.enqueue(sessionKey, async () => {
        await this.#store.prepare();
        const accounts = discussionAccounts(this.#currentConfig());
        if (accounts.length !== 1) {
          return { state: "none" };
        }
        const existing = await this.#store.getAsync(sessionKey);
        if (existing) {
          const resolved = await this.#resolveBindingForUse(existing);
          if (resolved.state === "retargeted") {
            await this.#revokeAndDeleteBinding(sessionKey, existing);
            return { state: "available" };
          }
          if (resolved.state === "stale") {
            await this.#releaseStaleBinding(sessionKey, existing);
            return { state: "available" };
          }
          if (resolved.state !== "active") {
            return { state: "none" };
          }
          await this.#reconcileBinding(sessionKey, existing, resolved.account);
          const current = await this.#store.getAsync(sessionKey);
          if (!current) {
            return { state: this.hasEnabledAccount() ? "available" : "none" };
          }
          return discussionInfoForBinding(current, resolved.account);
        }
        return { state: "available" };
      }),
    );
  }

  async open(sessionKey: string): Promise<SessionDiscussionInfo> {
    return await this.#withOperation(() =>
      this.#sessionQueue.enqueue(sessionKey, async () => {
        await this.#store.prepare();
        return await this.#open(sessionKey);
      }),
    );
  }

  async #open(sessionKey: string): Promise<SessionDiscussionInfo> {
    this.#installationId ??= await getClickClackDiscussionInstallationId(this.#runtime);
    const accounts = discussionAccounts(this.#currentConfig());
    if (accounts.length > 1) {
      throw new Error("ClickClack discussions require exactly one enabled discussion account");
    }
    const account = accounts[0];
    if (!account) {
      return { state: "none" };
    }
    const existing = await this.#store.getAsync(sessionKey);
    if (existing) {
      const resolved = await this.#resolveBindingForUse(existing);
      if (resolved.state === "retargeted") {
        if (!(await this.#revokeAndDeleteBinding(sessionKey, existing))) {
          return { state: "available" };
        }
      } else if (resolved.state === "stale") {
        if (!(await this.#releaseStaleBinding(sessionKey, existing))) {
          return { state: "available" };
        }
      } else if (resolved.state === "active") {
        await this.#reconcileBinding(sessionKey, existing, resolved.account);
        const current = await this.#store.getAsync(sessionKey);
        if (current) {
          return discussionInfoForBinding(current, resolved.account);
        }
      }
    }
    let binding: ClickClackDiscussionBinding | undefined;
    try {
      binding = await openClickClackDiscussionBinding({
        runtime: this.#runtime,
        store: this.#store,
        account,
        clientFactory: this.#clientFactory,
        installationId: this.#installationId,
        sessionKey,
        ensureTimer: () => this.#ensureTimer(),
        withChannelMutationLock: (run) => this.#withChannelMutationLock(run),
        ensureBindingCapacity: (key) => this.#detachedBindings.ensureCapacity(key),
        warn: (message) => this.#logger().warn(message),
      });
    } finally {
      await this.#ensureTimer();
    }
    if (!binding) {
      return { state: "available" };
    }
    return discussionInfoForBinding(binding, account);
  }

  async reconcile(sessionKey: string): Promise<void> {
    return await this.#withOperation(() => this.#reconcile(sessionKey));
  }

  async #reconcile(sessionKey: string): Promise<void> {
    try {
      await this.#sessionQueue.enqueue(sessionKey, async () => {
        await this.#store.prepare();
        const binding = await this.#store.getAsync(sessionKey);
        if (binding) {
          await this.#reconcileBinding(sessionKey, binding);
        }
        const pending = await getPendingDiscussionOpen(this.#runtime, sessionKey);
        if (pending) {
          const shouldRetry = await reconcilePendingDiscussionOpen({
            runtime: this.#runtime,
            store: this.#store,
            clientFactory: this.#clientFactory,
            pending,
          });
          if (shouldRetry) {
            await this.#open(sessionKey);
          }
        }
      });
    } finally {
      await this.#ensureTimer();
    }
  }

  async reconcileAll(): Promise<void> {
    return await this.#withOperation(async () => {
      try {
        for (const sessionKey of await this.#listReconcileSessionKeys()) {
          try {
            await this.#reconcile(sessionKey);
          } catch (error) {
            this.#logger().warn(`discussion reconcile failed for ${sessionKey}: ${String(error)}`);
          }
        }
      } finally {
        await this.#ensureTimer();
      }
    });
  }

  async readLatestMessages(
    sessionKey: string,
    limit: number,
  ): Promise<{ binding?: ClickClackDiscussionBinding; text: string }> {
    return await this.#withOperation(() =>
      this.#sessionQueue.enqueue(sessionKey, async () => {
        await this.#store.prepare();
        const binding = await this.#store.getAsync(sessionKey);
        if (!binding) {
          return { text: "No discussion is bound to this session." };
        }
        const resolved = await this.#resolveBindingForUse(binding);
        if (resolved.state !== "active") {
          return { text: "No discussion is bound to this session." };
        }
        const attached = await this.#refreshSessionAttachment(sessionKey, binding);
        if (!attached) {
          return { text: "No discussion is bound to this session." };
        }
        return await readDiscussionHistory({
          runtime: this.#runtime,
          store: this.#store,
          sessionKey,
          binding: attached,
          client: this.#clientFactory(resolved.account),
          limit,
        });
      }),
    );
  }

  cleanup(): Promise<void> {
    this.#closed = true;
    this.#unsubscribeSessionsChanged?.();
    this.#unsubscribeSessionsChanged = undefined;
    this.#scheduleReconcile = undefined;
    this.#timer = undefined;
    this.#cleanupPromise ??= Promise.allSettled([
      this.#scheduler?.stop(),
      ...this.#operations,
    ]).then(() => undefined);
    return this.#cleanupPromise;
  }

  async #reconcileBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
    resolvedAccount?: ResolvedClickClackAccount,
  ): Promise<void> {
    await finalizePendingDiscussionBinding(this.#runtime, sessionKey, binding);
    if (
      await isClickClackDiscussionChannelRevokedAsync({
        runtime: this.#runtime,
        serverBaseUrl: binding.serverBaseUrl,
        channelId: binding.channelId,
        binding,
      })
    ) {
      await this.#store.deleteIfCurrent(sessionKey, binding);
      return;
    }
    const entry = await readDiscussionSessionEntry(this.#runtime, sessionKey);
    if (!entry) {
      await this.#detachedBindings.mark(sessionKey, binding);
      return;
    }
    const activeBinding = await this.#detachedBindings.clear(sessionKey, binding);
    if (!activeBinding) {
      return;
    }
    const resolved = resolvedAccount
      ? this.resolveBindingAccount(activeBinding)
      : await this.#resolveBindingForUse(activeBinding);
    if (resolved.state === "retargeted") {
      await this.#revokeAndDeleteBinding(sessionKey, activeBinding);
      return;
    }
    if (resolved.state === "stale") {
      await this.#releaseStaleBinding(sessionKey, activeBinding);
      return;
    }
    if (resolved.state !== "active") {
      return;
    }
    if (!resolved.account.baseUrl || !resolved.account.token) {
      throw new Error(
        `ClickClack discussion account is no longer configured: ${activeBinding.accountId}`,
      );
    }
    if (entry.archivedAt !== undefined) {
      return;
    }
    const labelForBackfill = resolveDiscussionLabel(entry, sessionKey, activeBinding.agentId);
    const desiredBackfillTitle =
      labelForBackfill === fallbackDiscussionLabel(sessionKey, activeBinding.agentId)
        ? ""
        : truncateDiscussionDisplayTitle(labelForBackfill);
    let bindingForAttachment = activeBinding;
    let observedSiblingTitleSupport = false;
    if (
      labelForBackfill === activeBinding.label &&
      desiredBackfillTitle !== "" &&
      activeBinding.displayTitle === undefined
    ) {
      const bindings = await this.#store.entries();
      const freshBinding = await this.#store.getAsync(sessionKey);
      if (
        !freshBinding ||
        freshBinding.serverBaseUrl !== activeBinding.serverBaseUrl ||
        freshBinding.channelId !== activeBinding.channelId ||
        freshBinding.externalRef !== activeBinding.externalRef
      ) {
        return;
      }
      if (
        await isClickClackDiscussionChannelRevokedAsync({
          runtime: this.#runtime,
          serverBaseUrl: freshBinding.serverBaseUrl,
          channelId: freshBinding.channelId,
          binding: freshBinding,
        })
      ) {
        await this.#store.deleteIfCurrent(sessionKey, freshBinding);
        return;
      }
      bindingForAttachment = freshBinding;
      observedSiblingTitleSupport = bindings.some(
        ({ binding: candidate }) =>
          candidate.displayTitle !== undefined &&
          candidate.serverBaseUrl === freshBinding.serverBaseUrl &&
          candidate.accountId === freshBinding.accountId,
      );
    }
    const current = this.resolveBindingAccount(bindingForAttachment);
    if (current.state !== "active") {
      return;
    }
    const account = current.account;
    const attached = await this.#refreshSessionAttachment(sessionKey, bindingForAttachment);
    if (!attached || attached.sessionId !== entry.sessionId) {
      return;
    }
    const currentBinding = attached;
    const fallback = fallbackDiscussionLabel(sessionKey, currentBinding.agentId);
    const label = resolveDiscussionLabel(entry, sessionKey, currentBinding.agentId);
    const section = entry.category?.trim() || account.discussions.section;
    const externalUrl =
      controlSessionUrl(
        account.discussions.controlUrlBase,
        sessionKey,
        account.agentId ?? "main",
        this.#currentConfig().session?.mainKey,
        label,
      ) ?? "";
    const patch: {
      display_title?: string;
      external_url?: string;
      name?: string;
      sidebar_section?: string;
    } = {};
    const labelChanged = label !== currentBinding.label;
    const desiredDisplayTitle = label === fallback ? "" : truncateDiscussionDisplayTitle(label);
    const serverSupportsDisplayTitle =
      currentBinding.displayTitle !== undefined || observedSiblingTitleSupport;
    const shouldBackfillDisplayTitle =
      desiredDisplayTitle !== "" &&
      currentBinding.displayTitle !== desiredDisplayTitle &&
      serverSupportsDisplayTitle;
    if (labelChanged || shouldBackfillDisplayTitle) {
      patch.display_title = desiredDisplayTitle;
    }
    if (section !== currentBinding.section) {
      patch.sidebar_section = section;
    }
    if (externalUrl !== currentBinding.externalUrl) {
      patch.external_url = externalUrl;
    }
    if (Object.keys(patch).length === 0 && !labelChanged) {
      return;
    }
    const bindingFacts = await this.#store.prepareRead(sessionKey);
    let revocation:
      | Awaited<ReturnType<typeof prepareClickClackDiscussionChannelRevocation>>
      | undefined;
    let session: Awaited<ReturnType<typeof prepareDiscussionSessionEntry>> | undefined;
    try {
      revocation = await prepareClickClackDiscussionChannelRevocation({
        runtime: this.#runtime,
        serverBaseUrl: currentBinding.serverBaseUrl,
        channelId: currentBinding.channelId,
      });
      const isRevoked = revocation.isRevoked;
      session = await prepareDiscussionSessionEntry(this.#runtime, sessionKey);
      const sessionAuthority = session;
      const client = this.#clientFactory(account);
      const assertCurrentAuthority = () => {
        sessionAuthority.source();
        const bound = bindingFacts.read();
        if (
          !bound ||
          bound.externalRef !== currentBinding.externalRef ||
          bound.serverBaseUrl !== currentBinding.serverBaseUrl ||
          bound.channelId !== currentBinding.channelId ||
          sessionAuthority.entry?.sessionId !== currentBinding.sessionId ||
          sessionAuthority.entry.archivedAt !== undefined ||
          this.resolveBindingAccount(currentBinding).state !== "active" ||
          isRevoked(bound)
        ) {
          throw new Error("ClickClack discussion authority changed before channel update");
        }
      };
      let updated: Awaited<ReturnType<ClickClackClient["updateChannel"]>>;
      if (labelChanged) {
        updated = await this.#withChannelMutationLock(() =>
          renameDiscussionChannel({
            client,
            workspaceId: currentBinding.workspaceId,
            channelId: currentBinding.channelId,
            label,
            sessionKey,
            agentId: currentBinding.agentId,
            patch,
            assertCurrentAuthority,
          }),
        );
      } else {
        assertCurrentAuthority();
        updated = await client.updateChannel(currentBinding.channelId, patch);
        assertChannelPatch(updated, patch);
      }
      const nextBinding: ClickClackDiscussionBinding = {
        ...currentBinding,
        externalUrl,
        label,
        section,
        ...(updated.display_title !== undefined ? { displayTitle: updated.display_title } : {}),
      };
      if (updated.display_title === undefined) {
        delete nextBinding.displayTitle;
      }
      // Record the delivered metadata even if policy changed while HTTP was in flight.
      await this.#store.setIfCurrent(sessionKey, currentBinding, nextBinding);
    } finally {
      session?.release();
      revocation?.release();
      bindingFacts.release();
    }
  }

  async #refreshSessionAttachment(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): Promise<ClickClackDiscussionBinding | undefined> {
    try {
      return await attachBindingToCurrentActiveSession({
        runtime: this.#runtime,
        store: this.#store,
        sessionKey,
        binding,
      });
    } catch (error) {
      this.#logger().warn(
        `discussion attachment refresh failed for ${sessionKey}: ${String(error)}`,
      );
      return undefined;
    }
  }

  async #releaseStaleBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): Promise<boolean> {
    // Release local routing authority only. The ClickClack room remains durable,
    // and its lifecycle remains owned by ClickClack.
    const pending = await getPendingDiscussionOpen(this.#runtime, sessionKey);
    if (pending?.externalRef === binding.externalRef) {
      await clearDiscussionBindingGeneration({
        runtime: this.#runtime,
        sessionKey,
        expectedGeneration: pending.generation,
      });
    }
    return await this.#revokeAndDeleteBinding(sessionKey, binding);
  }

  async #revokeAndDeleteBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): Promise<boolean> {
    // Persist the reverse ownership evidence first. If that write fails, retain
    // the binding so inbound routing still fails closed.
    if (!(await markClickClackDiscussionChannelRevoked(this.#runtime, sessionKey, binding))) {
      return false;
    }
    return await this.#store.deleteIfCurrent(sessionKey, binding);
  }

  async #resolveBindingForUse(
    binding: ClickClackDiscussionBinding,
  ): Promise<DiscussionBindingUseResolution> {
    const resolved = this.resolveBindingAccount(binding);
    if (resolved.state !== "active") {
      return resolved;
    }
    const workspaces = await this.#clientFactory(resolved.account).workspaces();
    const workspace = findClickClackWorkspace(workspaces, resolved.account.discussions.workspace);
    const current = this.resolveBindingAccount(binding);
    if (current.state !== "active") {
      return current;
    }
    return workspace?.id === binding.workspaceId ? current : { state: "retargeted" };
  }

  #currentConfig(): CoreConfig {
    return this.#runtime.config.current() as CoreConfig;
  }

  async #ensureTimer(): Promise<void> {
    if (this.#closed) {
      return;
    }
    const hasPendingOpens = (await listPendingDiscussionOpens(this.#runtime)).length > 0;
    // Without a gateway-event subscription (no broadcaster in this process),
    // bindings fall back to the interval poll or renames would never reconcile.
    const needsBindingPoll =
      this.#unsubscribeSessionsChanged === undefined && (await this.#store.countAsync()) > 0;
    if (this.#closed || (!hasPendingOpens && !needsBindingPoll)) {
      if (this.#timer) {
        this.#timer.cancel();
        this.#timer = undefined;
      }
      return;
    }
    if (!this.#scheduler || this.#scheduler.signal.aborted || this.#timer) {
      return;
    }
    // Session changes drive normal binding reconciliation through gateway events.
    // Only ambiguous creates still need time-based retries while their durable
    // pending-open record exists.
    this.#timer = this.#scheduler.schedule({
      id: "reconcile-all",
      delayMs: RECONCILE_INTERVAL_MS,
      everyMs: RECONCILE_INTERVAL_MS,
      run: () =>
        this.reconcileAll().catch((error: unknown) => {
          this.#logger().warn(`discussion reconcile pass failed: ${String(error)}`);
        }),
    });
  }

  async #listReconcileSessionKeys(): Promise<Set<string>> {
    return new Set([
      ...(await this.#store.entries()).map(({ sessionKey }) => sessionKey),
      ...(await listPendingDiscussionOpens(this.#runtime)).map(({ sessionKey }) => sessionKey),
    ]);
  }

  #logger() {
    return this.#runtime.logging.getChildLogger({ plugin: "clickclack", feature: "discussions" });
  }

  #withOperation<T>(run: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error("ClickClack discussion service is stopped"));
    }
    const operation = Promise.resolve().then(run);
    this.#operations.add(operation);
    void operation.then(
      () => this.#operations.delete(operation),
      () => this.#operations.delete(operation),
    );
    return operation;
  }
}
