import { randomUUID } from "node:crypto";
import type { OpenClawPluginGatewayEvents, PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  SessionDiscussionInfo,
  SessionDiscussionProvider,
} from "openclaw/plugin-sdk/session-discussion";
import {
  createClickClackClient,
  isClickClackChannelNameConflict,
  type ClickClackClient,
} from "../http-client.js";
import type { CoreConfig, ResolvedClickClackAccount } from "../types.js";
import {
  clearDiscussionBindingGeneration,
  listPendingDiscussionOpens,
  type PendingDiscussionOpen,
} from "./binding-generation.js";
import { DetachedDiscussionBindingRetention } from "./binding-retention.js";
import {
  attachBindingToCurrentActiveSession,
  getClickClackDiscussionBindingStore,
  MAX_RETAINED_DETACHED_DISCUSSION_BINDINGS,
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
import { formatDiscussionHistory } from "./history-format.js";
import { getClickClackDiscussionInstallationId } from "./installation.js";
import {
  fallbackDiscussionLabel,
  resolveDiscussionLabel,
  truncateDiscussionDisplayTitle,
} from "./naming.js";
import { DiscussionReconcileScheduler } from "./reconcile-scheduler.js";
import {
  clearClickClackDiscussionChannelRevoked,
  isClickClackDiscussionChannelRevoked,
  markClickClackDiscussionChannelRevoked,
} from "./revoked-channel-store.js";
import {
  assertChannelPatch,
  reconcilePendingDiscussionOpen,
  openClickClackDiscussionBinding,
  resolveAvailableChannelName,
} from "./service-open.js";

const RECONCILE_INTERVAL_MS = 60_000;
const CHANNEL_NAME_MUTATION_ATTEMPTS = 4;
type DiscussionServiceOptions = {
  clientFactory?: (account: ResolvedClickClackAccount) => ClickClackClient;
  installationId?: string;
  bindingGenerationFactory?: () => string;
  gatewayEvents?: Pick<OpenClawPluginGatewayEvents, "onSessionsChanged">;
  startTimer?: boolean;
  maxRetainedDetachedBindings?: number;
};

type DiscussionBindingUseResolution = DiscussionBindingAccountResolution | { state: "retargeted" };

export class ClickClackDiscussionService {
  readonly provider: SessionDiscussionProvider;
  readonly #runtime: PluginRuntime;
  readonly #store: ClickClackDiscussionBindingStore;
  readonly #clientFactory: (account: ResolvedClickClackAccount) => ClickClackClient;
  #installationId: string | undefined;
  readonly #bindingGenerationFactory: () => string;
  readonly #detachedBindings: DetachedDiscussionBindingRetention;
  readonly #timersEnabled: boolean;
  readonly #sessionLocks = new Map<string, Promise<unknown>>();
  readonly #reconcileScheduler = new DiscussionReconcileScheduler({
    shouldSchedule: () => !this.#closed,
    run: async (sessionKey) => await this.reconcile(sessionKey),
    warn: (message) => this.#logger().warn(message),
  });
  #channelMutationLock: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #reconcileAllPromise: Promise<void> | undefined;
  #unsubscribeSessionsChanged: (() => void) | undefined;
  #closed = false;
  #activation = 0;
  #cleanupPromise: Promise<void> | undefined;
  readonly #operations = new Set<Promise<unknown>>();

  constructor(runtime: PluginRuntime, options: DiscussionServiceOptions = {}) {
    this.#runtime = runtime;
    this.#store = getClickClackDiscussionBindingStore(runtime);
    this.#clientFactory =
      options.clientFactory ??
      ((account) => createClickClackClient({ baseUrl: account.apiEndpoint, token: account.token }));
    this.#installationId = options.installationId;
    this.#bindingGenerationFactory = options.bindingGenerationFactory ?? randomUUID;
    this.#detachedBindings = new DetachedDiscussionBindingRetention({
      runtime,
      store: this.#store,
      maxRetained: options.maxRetainedDetachedBindings ?? MAX_RETAINED_DETACHED_DISCUSSION_BINDINGS,
    });
    this.#timersEnabled = options.startTimer !== false;
    this.provider = {
      id: "clickclack",
      info: async ({ sessionKey }) => await this.info(sessionKey),
      open: async ({ sessionKey }) => await this.open(sessionKey),
    };
    // Activation (event subscription + catch-up reconciles) belongs to the
    // registered service lifecycle via bindGatewayEvents; construction alone
    // must not touch remote channels. Tests may inject events for immediacy.
    if (options.gatewayEvents) {
      void this.bindGatewayEvents(options.gatewayEvents).catch((error: unknown) => {
        this.#logger().warn(`discussion activation failed: ${String(error)}`);
      });
    }
    if (this.#timersEnabled && !options.gatewayEvents) {
      void this.#withOperation(() => this.#ensureTimer()).catch((error: unknown) => {
        this.#logger().warn(`discussion timer initialization failed: ${String(error)}`);
      });
    }
  }

  async bindGatewayEvents(
    gatewayEvents: Pick<OpenClawPluginGatewayEvents, "onSessionsChanged"> | undefined,
  ): Promise<void> {
    const activation = ++this.#activation;
    if (this.#cleanupPromise) {
      await this.#cleanupPromise;
    }
    if (activation !== this.#activation) {
      return;
    }
    this.#cleanupPromise = undefined;
    this.#unsubscribeSessionsChanged?.();
    this.#closed = false;
    this.#reconcileScheduler.supersede();
    this.#unsubscribeSessionsChanged = gatewayEvents?.onSessionsChanged((event) => {
      void this.#withOperation(async () => {
        if (
          this.#store.get(event.sessionKey) ||
          (await listPendingDiscussionOpens(this.#runtime)).some(
            (pending) => pending.sessionKey === event.sessionKey,
          )
        ) {
          if (activation === this.#activation) {
            this.#reconcileScheduler.schedule(event.sessionKey);
          }
        }
      }).catch((error: unknown) => {
        this.#logger().warn(`discussion event admission failed: ${String(error)}`);
      });
    });
    await this.#withOperation(async () => {
      for (const sessionKey of await this.#listReconcileSessionKeys()) {
        if (activation !== this.#activation) {
          return;
        }
        this.#reconcileScheduler.schedule(sessionKey, 0);
      }
      await this.#ensureTimer();
    });
  }

  hasEnabledAccount(): boolean {
    return discussionAccounts(this.#currentConfig()).length === 1;
  }

  async info(sessionKey: string): Promise<SessionDiscussionInfo> {
    return await this.#withOperation(() =>
      this.#withSessionLock(sessionKey, async () => {
        const accounts = discussionAccounts(this.#currentConfig());
        if (accounts.length !== 1) {
          return { state: "none" };
        }
        const existing = this.#store.get(sessionKey);
        if (existing) {
          const resolved = await this.#resolveBindingForUse(existing);
          if (resolved.state === "retargeted") {
            this.#revokeAndDeleteBinding(sessionKey, existing);
            return { state: "available" };
          }
          if (resolved.state === "stale") {
            await this.#releaseStaleBinding(sessionKey, existing);
            return { state: "available" };
          }
          if (resolved.state !== "active") {
            return { state: "none" };
          }
          await this.#finalizePendingBinding(sessionKey, existing);
          await this.#reconcileBinding(sessionKey, existing, resolved.account);
          const current = this.#store.get(sessionKey);
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
      this.#withSessionLock(sessionKey, () => this.#open(sessionKey)),
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
    const existing = this.#store.get(sessionKey);
    if (existing) {
      const resolved = await this.#resolveBindingForUse(existing);
      if (resolved.state === "retargeted") {
        this.#revokeAndDeleteBinding(sessionKey, existing);
      } else if (resolved.state === "stale") {
        await this.#releaseStaleBinding(sessionKey, existing);
      } else if (resolved.state === "active") {
        await this.#finalizePendingBinding(sessionKey, existing);
        await this.#reconcileBinding(sessionKey, existing, resolved.account);
        const current = this.#store.get(sessionKey);
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
        bindingGenerationFactory: this.#bindingGenerationFactory,
        sessionKey,
        ensureTimer: () => this.#ensureTimer(),
        reconcilePendingOpen: async (pending) =>
          await this.#reconcilePendingOpen(pending, { allowRetry: false }),
        withChannelMutationLock: async (run) => await this.#withChannelMutationLock(run),
        ensureBindingCapacity: (key) => this.#detachedBindings.ensureCapacity(key),
        finalizePendingBinding: (key, nextBinding) =>
          this.#finalizePendingBinding(key, nextBinding),
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
      await this.#withSessionLock(sessionKey, async () => {
        const binding = this.#store.get(sessionKey);
        if (binding) {
          await this.#reconcileBinding(sessionKey, binding);
        }
        const pending = (await listPendingDiscussionOpens(this.#runtime)).find(
          (candidate) => candidate.sessionKey === sessionKey,
        );
        if (pending) {
          await this.#reconcilePendingOpen(pending);
        }
      });
    } finally {
      await this.#ensureTimer();
    }
  }

  async reconcileAll(): Promise<void> {
    return await this.#withOperation(async () => {
      if (this.#reconcileAllPromise) {
        return await this.#reconcileAllPromise;
      }
      this.#reconcileAllPromise = (async () => {
        try {
          for (const sessionKey of await this.#listReconcileSessionKeys()) {
            try {
              await this.#reconcile(sessionKey);
            } catch (error) {
              this.#logger().warn(
                `discussion reconcile failed for ${sessionKey}: ${String(error)}`,
              );
            }
          }
        } finally {
          await this.#ensureTimer();
        }
      })().finally(() => {
        this.#reconcileAllPromise = undefined;
      });
      return await this.#reconcileAllPromise;
    });
  }

  async readLatestMessages(
    sessionKey: string,
    limit: number,
  ): Promise<{ binding?: ClickClackDiscussionBinding; text: string }> {
    return await this.#withOperation(() =>
      this.#withSessionLock(sessionKey, async () => {
        const binding = this.#store.get(sessionKey);
        if (!binding) {
          return { text: "No discussion is bound to this session." };
        }
        const resolved = await this.#resolveBindingForUse(binding);
        if (resolved.state === "retargeted") {
          return { text: "No discussion is bound to this session." };
        }
        if (resolved.state === "stale") {
          return { text: "No discussion is bound to this session." };
        }
        if (resolved.state !== "active") {
          return { text: "No discussion is bound to this session." };
        }
        const attached = this.#refreshSessionAttachment(sessionKey, binding);
        if (!attached) {
          return { text: "No discussion is bound to this session." };
        }
        if (
          isClickClackDiscussionChannelRevoked({
            runtime: this.#runtime,
            serverBaseUrl: binding.serverBaseUrl,
            channelId: binding.channelId,
          })
        ) {
          return { text: "No discussion is bound to this session." };
        }
        const history = await this.#clientFactory(resolved.account).latestChannelMessages(
          attached.channelId,
          limit,
        );
        const text = formatDiscussionHistory(history);
        return {
          binding: attached,
          text: text || "The bound discussion has no messages yet.",
        };
      }),
    );
  }

  cleanup(): Promise<void> {
    this.#closed = true;
    this.#activation += 1;
    this.#unsubscribeSessionsChanged?.();
    this.#unsubscribeSessionsChanged = undefined;
    this.#reconcileScheduler.supersede();
    this.#reconcileScheduler.clear();
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#cleanupPromise ??= Promise.allSettled(this.#operations).then(() => undefined);
    return this.#cleanupPromise;
  }

  async #reconcileBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
    resolvedAccount?: ResolvedClickClackAccount,
  ): Promise<void> {
    await this.#finalizePendingBinding(sessionKey, binding);
    if (
      isClickClackDiscussionChannelRevoked({
        runtime: this.#runtime,
        serverBaseUrl: binding.serverBaseUrl,
        channelId: binding.channelId,
      })
    ) {
      this.#store.delete(sessionKey);
      return;
    }
    const entry = this.#runtime.agent.session.getSessionEntry({
      sessionKey,
      readConsistency: "latest",
    });
    if (!entry) {
      this.#detachedBindings.mark(sessionKey, binding);
      return;
    }
    const activeBinding = this.#detachedBindings.clear(sessionKey, binding);
    if (!activeBinding) {
      return;
    }
    const resolved = resolvedAccount
      ? resolveDiscussionBindingAccount(this.#currentConfig(), activeBinding)
      : await this.#resolveBindingForUse(activeBinding);
    if (resolved.state === "retargeted") {
      this.#revokeAndDeleteBinding(sessionKey, activeBinding);
      return;
    }
    if (resolved.state === "stale") {
      await this.#releaseStaleBinding(sessionKey, activeBinding);
      return;
    }
    if (resolved.state !== "active") {
      return;
    }
    const account = resolved.account;
    if (!account.baseUrl || !account.token) {
      throw new Error(
        `ClickClack discussion account is no longer configured: ${activeBinding.accountId}`,
      );
    }
    if (entry.archivedAt !== undefined) {
      return;
    }
    const attached = this.#refreshSessionAttachment(sessionKey, activeBinding);
    if (!attached) {
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
    const serverSupportsDisplayTitle = this.#store
      .entries()
      .some(
        ({ binding: candidate }) =>
          candidate.displayTitle !== undefined &&
          candidate.serverBaseUrl === currentBinding.serverBaseUrl &&
          candidate.accountId === currentBinding.accountId,
      );
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
    const client = this.#clientFactory(account);
    let updated: Awaited<ReturnType<ClickClackClient["updateChannel"]>>;
    if (labelChanged) {
      updated = await this.#withChannelMutationLock(async () => {
        for (let attempt = 0; attempt < CHANNEL_NAME_MUTATION_ATTEMPTS; attempt += 1) {
          patch.name = await resolveAvailableChannelName({
            client,
            workspaceId: currentBinding.workspaceId,
            label,
            sessionKey,
            agentId: currentBinding.agentId,
            ownChannelId: currentBinding.channelId,
          });
          try {
            const renamed = await client.updateChannel(currentBinding.channelId, patch);
            assertChannelPatch(renamed, patch);
            return renamed;
          } catch (error) {
            if (
              !isClickClackChannelNameConflict(error) ||
              attempt === CHANNEL_NAME_MUTATION_ATTEMPTS - 1
            ) {
              throw error;
            }
          }
        }
        throw new Error("ClickClack discussion channel name retries were exhausted");
      });
    } else {
      updated = await client.updateChannel(currentBinding.channelId, patch);
      assertChannelPatch(updated, patch);
    }
    const latestBinding = this.#store.get(sessionKey);
    if (
      !latestBinding ||
      latestBinding.serverBaseUrl !== currentBinding.serverBaseUrl ||
      latestBinding.channelId !== currentBinding.channelId ||
      latestBinding.externalRef !== currentBinding.externalRef
    ) {
      return;
    }
    const nextBinding: ClickClackDiscussionBinding = {
      ...latestBinding,
      externalUrl,
      label,
      section,
      ...(updated.display_title !== undefined ? { displayTitle: updated.display_title } : {}),
    };
    if (updated.display_title === undefined) {
      delete nextBinding.displayTitle;
    }
    this.#store.set(sessionKey, nextBinding);
  }

  #refreshSessionAttachment(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): ClickClackDiscussionBinding | undefined {
    try {
      return attachBindingToCurrentActiveSession({
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

  async #reconcilePendingOpen(
    pending: PendingDiscussionOpen,
    options: { allowRetry?: boolean } = {},
  ): Promise<void> {
    await reconcilePendingDiscussionOpen({
      runtime: this.#runtime,
      store: this.#store,
      clientFactory: this.#clientFactory,
      pending,
      ...options,
      finalizePendingBinding: (key, binding) => this.#finalizePendingBinding(key, binding),
      open: (key) => this.#open(key),
    });
  }

  async #releaseStaleBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): Promise<void> {
    // Release local routing authority only. The ClickClack room remains durable,
    // and its lifecycle remains owned by ClickClack.
    await clearDiscussionBindingGeneration({ runtime: this.#runtime, sessionKey });
    this.#revokeAndDeleteBinding(sessionKey, binding);
  }

  #revokeAndDeleteBinding(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    // Persist the reverse ownership evidence first. If that write fails, retain
    // the binding so inbound routing still fails closed.
    markClickClackDiscussionChannelRevoked(this.#runtime, binding);
    this.#store.delete(sessionKey);
  }

  async #finalizePendingBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): Promise<void> {
    const pending = (await listPendingDiscussionOpens(this.#runtime)).find(
      (candidate) =>
        candidate.sessionKey === sessionKey && candidate.externalRef === binding.externalRef,
    );
    if (pending) {
      // A matching binding is the durable commit record. Clear the fail-closed
      // tombstone first, then the recovery reservation; every crash point can
      // replay this sequence without orphaning the remote channel.
      clearClickClackDiscussionChannelRevoked({
        runtime: this.#runtime,
        serverBaseUrl: binding.serverBaseUrl,
        channelId: binding.channelId,
      });
      await clearDiscussionBindingGeneration({
        runtime: this.#runtime,
        sessionKey,
        expectedGeneration: pending.generation,
      });
    }
  }

  async #resolveBindingForUse(
    binding: ClickClackDiscussionBinding,
  ): Promise<DiscussionBindingUseResolution> {
    const resolved = resolveDiscussionBindingAccount(this.#currentConfig(), binding);
    if (resolved.state !== "active") {
      return resolved;
    }
    const workspaces = await this.#clientFactory(resolved.account).workspaces();
    const workspace = workspaces.find(
      (candidate) =>
        candidate.id === resolved.account.discussions.workspace ||
        candidate.slug === resolved.account.discussions.workspace ||
        candidate.name === resolved.account.discussions.workspace,
    );
    const current = resolveDiscussionBindingAccount(this.#currentConfig(), binding);
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
      this.#unsubscribeSessionsChanged === undefined && this.#store.count() > 0;
    if (this.#closed || (!hasPendingOpens && !needsBindingPoll)) {
      if (this.#timer) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
      return;
    }
    if (!this.#timersEnabled || this.#timer) {
      return;
    }
    // Session changes drive normal binding reconciliation through gateway events.
    // Only ambiguous creates still need time-based retries while their durable
    // pending-open record exists.
    this.#timer = setInterval(() => {
      void this.reconcileAll().catch((error: unknown) => {
        this.#logger().warn(`discussion reconcile pass failed: ${String(error)}`);
      });
    }, RECONCILE_INTERVAL_MS);
    this.#timer.unref?.();
  }

  async #listReconcileSessionKeys(): Promise<Set<string>> {
    return new Set([
      ...this.#store.entries().map(({ sessionKey }) => sessionKey),
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

  async #withSessionLock<T>(sessionKey: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#sessionLocks.get(sessionKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    this.#sessionLocks.set(sessionKey, current);
    try {
      return await current;
    } finally {
      if (this.#sessionLocks.get(sessionKey) === current) {
        this.#sessionLocks.delete(sessionKey);
      }
    }
  }

  async #withChannelMutationLock<T>(run: () => Promise<T>): Promise<T> {
    const current = this.#channelMutationLock.catch(() => undefined).then(run);
    this.#channelMutationLock = current;
    return await current;
  }
}
