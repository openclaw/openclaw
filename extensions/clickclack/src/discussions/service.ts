import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import type {
  SessionDiscussionInfo,
  SessionDiscussionProvider,
} from "openclaw/plugin-sdk/session-discussion";
import { listClickClackAccountIds, resolveClickClackAccount } from "../accounts.js";
import {
  ClickClackHttpError,
  createClickClackClient,
  isClickClackChannelNameConflict,
  type ClickClackClient,
} from "../http-client.js";
import type { CoreConfig, ResolvedClickClackAccount } from "../types.js";
import {
  clearDiscussionBindingGeneration,
  listPendingDiscussionOpens,
  type PendingDiscussionOpen,
  recordPendingDiscussionOpen,
  reserveDiscussionBindingGeneration,
} from "./binding-generation.js";
import {
  getClickClackDiscussionBindingStore,
  bindingMatchesSessionIncarnation,
  type ClickClackDiscussionBinding,
  type ClickClackDiscussionBindingStore,
} from "./binding-store.js";
import {
  discussionAccounts,
  normalizedServerBaseUrl,
  resolveDiscussionBindingAccount,
  type DiscussionBindingAccountResolution,
} from "./eligibility.js";
import { getClickClackDiscussionInstallationId } from "./installation.js";
import {
  discussionCredentialFingerprint,
  discussionExternalRef,
  fallbackDiscussionLabel,
  resolveDiscussionLabel,
  slugifyDiscussionLabel,
} from "./naming.js";
import {
  clearClickClackDiscussionChannelRevoked,
  isClickClackDiscussionChannelRevoked,
  markClickClackDiscussionChannelIdentityRevoked,
  markClickClackDiscussionChannelRevoked,
} from "./revoked-channel-store.js";

const RECONCILE_INTERVAL_MS = 60_000;
const CHANNEL_NAME_MUTATION_ATTEMPTS = 4;

function isDefinitiveNoCreateHttpError(error: unknown): boolean {
  if (!(error instanceof ClickClackHttpError) || error.status < 400 || error.status >= 500) {
    return false;
  }
  // Timeout, conflict, early-data, and rate-limit responses can follow a committed
  // request or positively indicate an existing external_ref. Reconcile those.
  return ![408, 409, 425, 429].includes(error.status);
}

type DiscussionServiceOptions = {
  clientFactory?: (account: ResolvedClickClackAccount) => ClickClackClient;
  installationId?: string;
  bindingGenerationFactory?: () => string;
  startTimer?: boolean;
};

type DiscussionBindingUseResolution = DiscussionBindingAccountResolution | { state: "retargeted" };

function discussionInfoForBinding(
  binding: ClickClackDiscussionBinding,
  account: ResolvedClickClackAccount,
): SessionDiscussionInfo {
  const baseUrl = normalizedServerBaseUrl(account);
  return {
    state: "open",
    embedUrl: `${baseUrl}/embed/channel/${encodeURIComponent(binding.workspaceRouteId)}/${encodeURIComponent(binding.channelRouteId)}`,
    openUrl: `${baseUrl}/app/${encodeURIComponent(binding.workspaceRouteId)}/${encodeURIComponent(binding.channelRouteId)}`,
  };
}

function controlSessionUrl(baseUrl: string | undefined, sessionKey: string): string | undefined {
  if (!baseUrl) {
    return undefined;
  }
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/chat`;
  url.hash = "";
  url.searchParams.set("session", sessionKey);
  return url.toString();
}

function discussionRecordJson(value: string): string {
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/gu,
    (separator) => `\\u${separator.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export class ClickClackDiscussionService {
  readonly provider: SessionDiscussionProvider;
  readonly #runtime: PluginRuntime;
  readonly #store: ClickClackDiscussionBindingStore;
  readonly #clientFactory: (account: ResolvedClickClackAccount) => ClickClackClient;
  readonly #installationId: string;
  readonly #bindingGenerationFactory: () => string;
  readonly #timersEnabled: boolean;
  readonly #sessionLocks = new Map<string, Promise<unknown>>();
  #channelMutationLock: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #reconcileAllPromise: Promise<void> | undefined;

  constructor(runtime: PluginRuntime, options: DiscussionServiceOptions = {}) {
    this.#runtime = runtime;
    this.#store = getClickClackDiscussionBindingStore(runtime);
    this.#clientFactory =
      options.clientFactory ??
      ((account) => createClickClackClient({ baseUrl: account.baseUrl, token: account.token }));
    this.#installationId = options.installationId ?? getClickClackDiscussionInstallationId(runtime);
    this.#bindingGenerationFactory = options.bindingGenerationFactory ?? randomUUID;
    this.#timersEnabled = options.startTimer !== false;
    this.provider = {
      id: "clickclack",
      info: async ({ sessionKey }) => await this.info(sessionKey),
      open: async ({ sessionKey }) => await this.open(sessionKey),
    };
    if (this.#timersEnabled) {
      this.#ensureTimer();
    }
  }

  hasEnabledAccount(): boolean {
    return discussionAccounts(this.#currentConfig()).length === 1;
  }

  async info(sessionKey: string): Promise<SessionDiscussionInfo> {
    return await this.#withSessionLock(sessionKey, async () => {
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
        this.#finalizePendingBinding(sessionKey, existing);
        await this.#reconcileBinding(sessionKey, existing, resolved.account);
        const current = this.#store.get(sessionKey);
        if (!current) {
          return { state: this.hasEnabledAccount() ? "available" : "none" };
        }
        return discussionInfoForBinding(current, resolved.account);
      }
      return { state: "available" };
    });
  }

  async open(sessionKey: string): Promise<SessionDiscussionInfo> {
    return await this.#withSessionLock(sessionKey, async () => {
      const accounts = discussionAccounts(this.#currentConfig());
      if (accounts.length > 1) {
        throw new Error("ClickClack discussions require exactly one enabled discussion account");
      }
      const account = accounts[0];
      if (!account) {
        return { state: "none" };
      }
      let existing = this.#store.get(sessionKey);
      if (existing) {
        const resolved = await this.#resolveBindingForUse(existing);
        if (resolved.state === "retargeted") {
          this.#revokeAndDeleteBinding(sessionKey, existing);
          existing = undefined;
        } else if (resolved.state === "stale") {
          await this.#releaseStaleBinding(sessionKey, existing);
          existing = undefined;
        } else if (resolved.state === "active") {
          this.#finalizePendingBinding(sessionKey, existing);
          await this.#reconcileBinding(sessionKey, existing, resolved.account);
          const current = this.#store.get(sessionKey);
          if (current) {
            return discussionInfoForBinding(current, resolved.account);
          }
        }
      }
      const entry = this.#runtime.agent.session.getSessionEntry({
        sessionKey,
        readConsistency: "latest",
      });
      if (!entry) {
        return { state: "available" };
      }
      if (!entry.sessionId?.trim()) {
        throw new Error("OpenClaw session does not yet have a concrete session id");
      }
      const client = this.#clientFactory(account);
      const workspaces = await client.workspaces();
      const workspace = workspaces.find(
        (candidate) =>
          candidate.id === account.discussions.workspace ||
          candidate.slug === account.discussions.workspace ||
          candidate.name === account.discussions.workspace,
      );
      if (!workspace) {
        throw new Error(
          `ClickClack discussions workspace not found: ${account.discussions.workspace}`,
        );
      }
      if (!workspace.route_id) {
        throw new Error("ClickClack discussions workspace is missing its route id");
      }
      const serverBaseUrl = normalizedServerBaseUrl(account);
      const credentialFingerprint = discussionCredentialFingerprint(account.token);
      const unresolved = listPendingDiscussionOpens(this.#runtime).find(
        (pending) => pending.sessionKey === sessionKey,
      );
      if (
        unresolved &&
        (unresolved.accountId !== account.accountId ||
          unresolved.credentialFingerprint !== credentialFingerprint ||
          unresolved.sessionId !== entry.sessionId ||
          unresolved.serverBaseUrl !== serverBaseUrl ||
          unresolved.workspaceId !== workspace.id)
      ) {
        await this.#reconcilePendingOpen(unresolved, { allowRetry: false });
        if (
          listPendingDiscussionOpens(this.#runtime).some(
            (pending) => pending.sessionKey === sessionKey,
          )
        ) {
          throw new Error(
            "A previous ClickClack discussion open is still unresolved; restore its credential and retry",
          );
        }
      }

      const label = resolveDiscussionLabel(entry?.label, sessionKey);
      const section = entry?.category?.trim() || account.discussions.section;
      const externalUrl = controlSessionUrl(account.discussions.controlUrlBase, sessionKey);
      const archived = entry?.archivedAt !== undefined;
      const binding = await this.#withChannelMutationLock(async () => {
        if (!this.#store.hasCapacity(sessionKey)) {
          throw new Error("ClickClack discussion binding capacity is exhausted");
        }
        let channels = await client.channels(workspace.id);
        this.#assertManagedChannelListContract(channels);
        const destinationIdentity = [serverBaseUrl, workspace.id].join("\0");
        const bindingGeneration = reserveDiscussionBindingGeneration({
          runtime: this.#runtime,
          sessionKey,
          destinationIdentity,
          createGeneration: this.#bindingGenerationFactory,
        });
        const externalRef = discussionExternalRef(
          this.#installationId,
          sessionKey,
          entry.sessionId,
          destinationIdentity,
          bindingGeneration,
        );
        let adopted: (typeof channels)[number] | undefined;
        let managedFields:
          | {
              name: string;
              external_managed: true;
              external_ref: string;
              external_url: string;
              sidebar_section: string;
            }
          | undefined;
        let resolved: Awaited<ReturnType<ClickClackClient["createChannel"]>> | undefined;
        for (let attempt = 0; attempt < CHANNEL_NAME_MUTATION_ATTEMPTS; attempt += 1) {
          adopted = channels.find(
            (candidate) =>
              candidate.external_managed === true && candidate.external_ref === externalRef,
          );
          const name = await this.#resolveAvailableChannelName({
            client,
            workspaceId: workspace.id,
            label,
            sessionKey,
            channels,
            ownChannelId: adopted?.id,
          });
          managedFields = {
            name,
            external_managed: true,
            external_ref: externalRef,
            external_url: externalUrl ?? "",
            sidebar_section: section,
          };
          recordPendingDiscussionOpen({
            runtime: this.#runtime,
            sessionKey,
            generation: bindingGeneration,
            pending: {
              accountId: account.accountId,
              serverBaseUrl,
              workspaceId: workspace.id,
              sessionId: entry.sessionId,
              externalRef,
              credentialFingerprint,
            },
          });
          this.#ensureTimer();
          try {
            if (adopted) {
              markClickClackDiscussionChannelIdentityRevoked({
                runtime: this.#runtime,
                accountId: account.accountId,
                serverBaseUrl,
                channelId: adopted.id,
              });
              resolved = await client.updateChannel(adopted.id, { ...managedFields, archived });
            } else {
              resolved = await client.createChannel(workspace.id, {
                ...managedFields,
                kind: "public",
              });
              markClickClackDiscussionChannelIdentityRevoked({
                runtime: this.#runtime,
                accountId: account.accountId,
                serverBaseUrl,
                channelId: resolved.id,
              });
            }
            break;
          } catch (error) {
            const nameConflict = isClickClackChannelNameConflict(error);
            if (nameConflict && attempt < CHANNEL_NAME_MUTATION_ATTEMPTS - 1) {
              try {
                channels = await client.channels(workspace.id);
                this.#assertManagedChannelListContract(channels);
              } catch (relistError) {
                // A name conflict can identify an existing external_ref, and an
                // adopted channel is already known to exist. Keep the reservation
                // until a later relist can reconcile the remote channel.
                throw relistError;
              }
              continue;
            }
            const definitiveNoCreate = isDefinitiveNoCreateHttpError(error);
            try {
              const relisted = await client.channels(workspace.id);
              this.#assertManagedChannelListContract(relisted);
              const recovered = relisted.find(
                (candidate) =>
                  candidate.external_managed === true && candidate.external_ref === externalRef,
              );
              if (recovered) {
                adopted = recovered;
                markClickClackDiscussionChannelIdentityRevoked({
                  runtime: this.#runtime,
                  accountId: account.accountId,
                  serverBaseUrl,
                  channelId: recovered.id,
                });
                resolved = await client.updateChannel(recovered.id, {
                  ...managedFields,
                  archived,
                });
                break;
              }
              if (definitiveNoCreate) {
                clearDiscussionBindingGeneration({
                  runtime: this.#runtime,
                  sessionKey,
                  expectedGeneration: bindingGeneration,
                });
              }
            } catch {
              if (definitiveNoCreate && !adopted) {
                clearDiscussionBindingGeneration({
                  runtime: this.#runtime,
                  sessionKey,
                  expectedGeneration: bindingGeneration,
                });
              }
              // Otherwise a failed relist leaves the POST outcome genuinely
              // ambiguous. Keep its destination quarantined for reconciliation.
            }
            throw error;
          }
        }
        if (!resolved || !managedFields) {
          throw new Error("ClickClack discussion channel name retries were exhausted");
        }
        try {
          this.#assertManagedChannelContract(resolved, {
            sessionKey,
            externalRef,
            section,
            externalUrl,
          });
          if (adopted) {
            this.#assertChannelPatch(resolved, { ...managedFields, archived });
          }
        } catch (error) {
          try {
            const updated = await client.updateChannel(resolved.id, { archived: true });
            this.#assertChannelPatch(updated, { archived: true });
            clearDiscussionBindingGeneration({
              runtime: this.#runtime,
              sessionKey,
              expectedGeneration: bindingGeneration,
            });
          } catch (archiveError) {
            this.#logger().warn(
              `failed to archive incompatible discussion channel ${resolved.id}: ${String(archiveError)}`,
            );
          }
          throw error;
        }
        if (!resolved.route_id) {
          try {
            const updated = await client.updateChannel(resolved.id, { archived: true });
            this.#assertChannelPatch(updated, { archived: true });
            clearDiscussionBindingGeneration({
              runtime: this.#runtime,
              sessionKey,
              expectedGeneration: bindingGeneration,
            });
          } catch (archiveError) {
            this.#logger().warn(
              `failed to archive route-less discussion channel ${resolved.id}: ${String(archiveError)}`,
            );
          }
          throw new Error("ClickClack discussion channel is missing its route id");
        }
        let channel = resolved;
        if (!adopted && archived) {
          channel = await client.updateChannel(resolved.id, { archived: true });
          this.#assertChannelPatch(channel, { archived: true });
        }
        const nextBinding: ClickClackDiscussionBinding = {
          accountId: account.accountId,
          agentId: resolveAgentIdFromSessionKey(sessionKey),
          sessionId: entry.sessionId,
          serverBaseUrl,
          credentialFingerprint,
          externalRef,
          externalUrl: externalUrl ?? "",
          workspaceRef: account.discussions.workspace,
          workspaceId: workspace.id,
          channelId: channel.id,
          channelRouteId: channel.route_id,
          workspaceRouteId: workspace.route_id,
          section,
          archived,
          label,
        };
        const currentEntry = this.#runtime.agent.session.getSessionEntry({
          sessionKey,
          readConsistency: "latest",
        });
        if (!currentEntry || currentEntry.sessionId !== entry.sessionId) {
          try {
            const updated = await client.updateChannel(channel.id, { archived: true });
            this.#assertChannelPatch(updated, { archived: true });
            clearDiscussionBindingGeneration({
              runtime: this.#runtime,
              sessionKey,
              expectedGeneration: bindingGeneration,
            });
          } catch (archiveError) {
            this.#logger().warn(
              `failed to archive superseded discussion channel ${channel.id}: ${String(archiveError)}`,
            );
          }
          throw new Error("OpenClaw session changed while opening its ClickClack discussion");
        }
        try {
          this.#store.set(sessionKey, nextBinding);
        } catch (error) {
          try {
            const updated = await client.updateChannel(channel.id, { archived: true });
            this.#assertChannelPatch(updated, { archived: true });
            clearDiscussionBindingGeneration({
              runtime: this.#runtime,
              sessionKey,
              expectedGeneration: bindingGeneration,
            });
          } catch (archiveError) {
            this.#logger().warn(
              `failed to archive unbound discussion channel ${channel.id}: ${String(archiveError)}`,
            );
          }
          throw error;
        }
        this.#finalizePendingBinding(sessionKey, nextBinding);
        return nextBinding;
      });
      this.#ensureTimer();
      return discussionInfoForBinding(binding, account);
    });
  }

  async reconcile(sessionKey: string): Promise<void> {
    await this.#withSessionLock(sessionKey, async () => {
      const binding = this.#store.get(sessionKey);
      if (binding) {
        await this.#reconcileBinding(sessionKey, binding);
      }
    });
  }

  async reconcileAll(): Promise<void> {
    if (this.#reconcileAllPromise) {
      return await this.#reconcileAllPromise;
    }
    this.#reconcileAllPromise = (async () => {
      for (const { sessionKey } of this.#store.entries()) {
        try {
          await this.reconcile(sessionKey);
        } catch (error) {
          this.#logger().warn(`discussion reconcile failed for ${sessionKey}: ${String(error)}`);
        }
      }
      for (const pending of listPendingDiscussionOpens(this.#runtime)) {
        try {
          await this.#reconcilePendingOpen(pending);
        } catch (error) {
          this.#logger().warn(
            `discussion pending-open reconcile failed for ${pending.sessionKey}: ${String(error)}`,
          );
        }
      }
    })().finally(() => {
      this.#reconcileAllPromise = undefined;
    });
    return await this.#reconcileAllPromise;
  }

  async readLatestMessages(
    sessionKey: string,
    limit: number,
  ): Promise<{ binding?: ClickClackDiscussionBinding; text: string }> {
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
    if (!bindingMatchesSessionIncarnation(this.#runtime, sessionKey, binding)) {
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
      binding.channelId,
      limit,
    );
    const text = history.messages
      .map((message) => {
        const author =
          message.author?.display_name || message.author?.handle || message.author_id || "Unknown";
        return `timestamp=${discussionRecordJson(message.created_at)} [Author ${discussionRecordJson(author)} id=${discussionRecordJson(message.author_id)}] text=${discussionRecordJson(message.body)}`;
      })
      .join("\n");
    const truncationNote = history.truncated
      ? "\n[History scan reached its safety bound; older active threads may be omitted.]"
      : "";
    return {
      binding,
      text: text ? `${text}${truncationNote}` : "The bound discussion has no messages yet.",
    };
  }

  cleanup(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #reconcileBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
    resolvedAccount?: ResolvedClickClackAccount,
  ): Promise<void> {
    this.#finalizePendingBinding(sessionKey, binding);
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
    const resolved = resolvedAccount
      ? ({ state: "active", account: resolvedAccount } as const)
      : await this.#resolveBindingForUse(binding);
    if (resolved.state === "retargeted") {
      this.#revokeAndDeleteBinding(sessionKey, binding);
      return;
    }
    if (resolved.state === "stale") {
      await this.#releaseStaleBinding(sessionKey, binding);
      return;
    }
    if (resolved.state !== "active") {
      return;
    }
    const account = resolved.account;
    if (!account.baseUrl || !account.token) {
      throw new Error(
        `ClickClack discussion account is no longer configured: ${binding.accountId}`,
      );
    }
    const entry = this.#runtime.agent.session.getSessionEntry({
      sessionKey,
      readConsistency: "latest",
    });
    if (entry && (!binding.sessionId || entry.sessionId !== binding.sessionId)) {
      await this.#archiveAndDeleteBinding(sessionKey, binding, account);
      return;
    }
    const archived = entry ? entry.archivedAt !== undefined : true;
    const deleted = entry === undefined;
    const label = entry ? resolveDiscussionLabel(entry.label, sessionKey) : binding.label;
    const section = entry?.category?.trim() || account.discussions.section;
    const externalUrl = controlSessionUrl(account.discussions.controlUrlBase, sessionKey) ?? "";
    const patch: {
      archived?: boolean;
      external_url?: string;
      name?: string;
      sidebar_section?: string;
    } = {};
    if (archived !== binding.archived) {
      patch.archived = archived;
    }
    const labelChanged = label !== binding.label;
    if (section !== binding.section) {
      patch.sidebar_section = section;
    }
    if (externalUrl !== binding.externalUrl) {
      patch.external_url = externalUrl;
    }
    if (Object.keys(patch).length === 0 && !labelChanged) {
      if (deleted) {
        this.#revokeAndDeleteBinding(sessionKey, binding);
      }
      return;
    }
    const client = this.#clientFactory(account);
    if (labelChanged) {
      await this.#withChannelMutationLock(async () => {
        for (let attempt = 0; attempt < CHANNEL_NAME_MUTATION_ATTEMPTS; attempt += 1) {
          patch.name = await this.#resolveAvailableChannelName({
            client,
            workspaceId: binding.workspaceId,
            label,
            sessionKey,
            ownChannelId: binding.channelId,
          });
          try {
            const updated = await client.updateChannel(binding.channelId, patch);
            this.#assertChannelPatch(updated, patch);
            return;
          } catch (error) {
            if (
              !isClickClackChannelNameConflict(error) ||
              attempt === CHANNEL_NAME_MUTATION_ATTEMPTS - 1
            ) {
              throw error;
            }
          }
        }
      });
    } else {
      const updated = await client.updateChannel(binding.channelId, patch);
      this.#assertChannelPatch(updated, patch);
    }
    if (deleted) {
      this.#revokeAndDeleteBinding(sessionKey, binding);
      return;
    }
    this.#store.set(sessionKey, { ...binding, archived, externalUrl, label, section });
  }

  async #reconcilePendingOpen(
    pending: PendingDiscussionOpen,
    options: { allowRetry?: boolean } = {},
  ): Promise<void> {
    const currentBinding = this.#store.get(pending.sessionKey);
    if (currentBinding?.externalRef === pending.externalRef) {
      this.#finalizePendingBinding(pending.sessionKey, currentBinding);
      return;
    }
    const cfg = this.#currentConfig();
    const account = listClickClackAccountIds(cfg)
      .map((accountId) => resolveClickClackAccount({ cfg, accountId }))
      .find(
        (candidate) =>
          candidate.configured &&
          normalizedServerBaseUrl(candidate) === pending.serverBaseUrl &&
          discussionCredentialFingerprint(candidate.token) === pending.credentialFingerprint,
      );
    if (!account) {
      // Without the creating credential, keep the destination quarantined until
      // an operator restores access or explicitly cleans up the pending record.
      return;
    }
    const client = this.#clientFactory(account);
    const entry = this.#runtime.agent.session.getSessionEntry({
      sessionKey: pending.sessionKey,
      readConsistency: "latest",
    });
    const activeAccounts = discussionAccounts(cfg);
    const retryAccount = activeAccounts.length === 1 ? activeAccounts[0] : undefined;
    if (
      options.allowRetry !== false &&
      entry?.sessionId === pending.sessionId &&
      retryAccount &&
      normalizedServerBaseUrl(retryAccount) === pending.serverBaseUrl &&
      discussionCredentialFingerprint(retryAccount.token) === pending.credentialFingerprint
    ) {
      const retryClient = this.#clientFactory(retryAccount);
      const workspaces = await retryClient.workspaces();
      const configuredWorkspace = workspaces.find(
        (candidate) =>
          candidate.id === retryAccount.discussions.workspace ||
          candidate.slug === retryAccount.discussions.workspace ||
          candidate.name === retryAccount.discussions.workspace,
      );
      if (configuredWorkspace?.id === pending.workspaceId) {
        await this.open(pending.sessionKey);
        return;
      }
    }
    const channels = await client.channels(pending.workspaceId);
    this.#assertManagedChannelListContract(channels);
    const channel = channels.find(
      (candidate) =>
        candidate.external_managed === true && candidate.external_ref === pending.externalRef,
    );
    if (channel) {
      markClickClackDiscussionChannelIdentityRevoked({
        runtime: this.#runtime,
        accountId: pending.accountId,
        serverBaseUrl: pending.serverBaseUrl,
        channelId: channel.id,
      });
      const updated = await client.updateChannel(channel.id, { archived: true });
      this.#assertChannelPatch(updated, { archived: true });
    }
    clearDiscussionBindingGeneration({
      runtime: this.#runtime,
      sessionKey: pending.sessionKey,
      expectedGeneration: pending.generation,
    });
  }

  async #resolveAvailableChannelName(params: {
    client: ClickClackClient;
    workspaceId: string;
    label: string;
    sessionKey: string;
    ownChannelId?: string;
    channels?: Awaited<ReturnType<ClickClackClient["channels"]>>;
  }): Promise<string> {
    const desired = slugifyDiscussionLabel(params.label, params.sessionKey);
    const channels = params.channels ?? (await params.client.channels(params.workspaceId));
    const occupied = new Set(
      channels
        .filter((channel) => channel.id !== params.ownChannelId)
        .map((channel) => channel.name),
    );
    if (!occupied.has(desired)) {
      return desired;
    }
    const fallback = fallbackDiscussionLabel(params.sessionKey);
    if (!occupied.has(fallback)) {
      return fallback;
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${fallback}-${suffix}`;
      if (!occupied.has(candidate)) {
        return candidate;
      }
    }
  }

  #assertChannelPatch(
    channel: Awaited<ReturnType<ClickClackClient["updateChannel"]>>,
    patch: Parameters<ClickClackClient["updateChannel"]>[1],
  ): void {
    for (const key of ["archived", "external_url", "name", "sidebar_section"] as const) {
      if (patch[key] !== undefined && channel[key] !== patch[key]) {
        throw new Error(`ClickClack channel update did not apply ${key}`);
      }
    }
  }

  #assertManagedChannelContract(
    channel: Awaited<ReturnType<ClickClackClient["createChannel"]>>,
    expected: {
      sessionKey: string;
      externalRef: string;
      section: string;
      externalUrl?: string;
    },
  ): void {
    if (
      channel.external_managed !== true ||
      channel.external_ref !== expected.externalRef ||
      channel.sidebar_section !== expected.section ||
      typeof channel.external_url !== "string" ||
      channel.external_url !== (expected.externalUrl ?? "")
    ) {
      throw new Error(
        `ClickClack server does not support the managed discussion channel contract for ${expected.sessionKey}`,
      );
    }
  }

  #assertManagedChannelListContract(
    channels: Awaited<ReturnType<ClickClackClient["channels"]>>,
  ): void {
    if (
      channels.some(
        (channel) =>
          typeof channel.external_managed !== "boolean" ||
          typeof channel.external_ref !== "string" ||
          typeof channel.external_url !== "string" ||
          typeof channel.sidebar_section !== "string",
      )
    ) {
      throw new Error("ClickClack server does not advertise the managed discussion contract");
    }
  }

  async #releaseStaleBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
  ): Promise<void> {
    // Clear the durable interrupted-open reservation before releasing ownership.
    // A crash after this point can retry archival, but can never re-adopt the old channel.
    clearDiscussionBindingGeneration({ runtime: this.#runtime, sessionKey });
    const boundAccount = resolveClickClackAccount({
      cfg: this.#currentConfig(),
      accountId: binding.accountId,
    });
    if (
      !boundAccount.configured ||
      binding.serverBaseUrl !== normalizedServerBaseUrl(boundAccount) ||
      !binding.credentialFingerprint ||
      binding.credentialFingerprint !== discussionCredentialFingerprint(boundAccount.token)
    ) {
      this.#revokeAndDeleteBinding(sessionKey, binding);
      return;
    }
    // Eligibility checks revoke routing/tool authority immediately, while the
    // durable binding remains as the retry record until archival is verified.
    const updated = await this.#clientFactory(boundAccount).updateChannel(binding.channelId, {
      archived: true,
    });
    this.#assertChannelPatch(updated, { archived: true });
    this.#revokeAndDeleteBinding(sessionKey, binding);
  }

  async #archiveAndDeleteBinding(
    sessionKey: string,
    binding: ClickClackDiscussionBinding,
    account: ResolvedClickClackAccount,
  ): Promise<void> {
    clearDiscussionBindingGeneration({ runtime: this.#runtime, sessionKey });
    const updated = await this.#clientFactory(account).updateChannel(binding.channelId, {
      archived: true,
    });
    this.#assertChannelPatch(updated, { archived: true });
    this.#revokeAndDeleteBinding(sessionKey, binding);
  }

  #revokeAndDeleteBinding(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    // Persist the reverse ownership evidence first. If that write fails, retain
    // the binding so inbound routing still fails closed.
    markClickClackDiscussionChannelRevoked(this.#runtime, binding);
    this.#store.delete(sessionKey);
  }

  #finalizePendingBinding(sessionKey: string, binding: ClickClackDiscussionBinding): void {
    const pending = listPendingDiscussionOpens(this.#runtime).find(
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
      clearDiscussionBindingGeneration({
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
    return workspace?.id === binding.workspaceId ? resolved : { state: "retargeted" };
  }

  #currentConfig(): CoreConfig {
    return this.#runtime.config.current() as CoreConfig;
  }

  #ensureTimer(): void {
    if (
      !this.#timersEnabled ||
      this.#timer ||
      (this.#store.entries().length === 0 && listPendingDiscussionOpens(this.#runtime).length === 0)
    ) {
      return;
    }
    // The plugin event facade does not expose sessions.changed, and gateway.request
    // has no subscriber connection to receive it. Reconcile only while bindings
    // or ambiguous creates exist, at a coarse cadence, so this is not a hot poll.
    this.#timer = setInterval(() => {
      void this.reconcileAll()
        .catch((error) => {
          this.#logger().warn(`discussion reconcile pass failed: ${String(error)}`);
        })
        .finally(() => {
          if (
            this.#store.entries().length === 0 &&
            listPendingDiscussionOpens(this.#runtime).length === 0 &&
            this.#timer
          ) {
            clearInterval(this.#timer);
            this.#timer = undefined;
          }
        });
    }, RECONCILE_INTERVAL_MS);
    this.#timer.unref?.();
  }

  #logger() {
    return this.#runtime.logging.getChildLogger({ plugin: "clickclack", feature: "discussions" });
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
