import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { AutofillApprovalLinks } from "./autofill-approval-links.js";
import { autofillBrowserGuidance } from "./autofill-browser.js";
import type {
  AccessRequest,
  AccessRequestInput,
  AccessRequestStatus,
  AgenticAutofillExtension,
  ExtResult,
} from "./autofill-contract.js";
import { accessRequestInputSchema, decodeConnectionPath } from "./autofill-input.js";
import { autofillClock, pollAutofillDecision, type AutofillClock } from "./autofill-poll.js";
import {
  AutofillError,
  type AutofillRelayClient,
  type AutofillTokens,
  type Pickup,
  type RelaySession,
} from "./autofill-relay.js";

export type AutofillConnection = {
  path: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  integrationKey: string;
  expiresAt: number;
  statusNotBefore?: number;
};
export type AutofillRequest = {
  connectionPath: string;
  integrationKeyFingerprint: string;
  scope: string;
  request: AccessRequest;
  status: AccessRequestStatus;
  openedAt?: number;
  pollingEnded?: boolean;
};
type Store<T> = Pick<PluginStateKeyedStore<T, 2>, "lookup" | "register" | "delete" | "entries">;
export type AutofillStores = {
  connections: Store<AutofillConnection>;
  requests: Store<AutofillRequest>;
};
export type AutofillAuthority = { assertCurrent(): void; signal?: AbortSignal };
type ServiceOptions = {
  stores: AutofillStores;
  relay: Pick<AutofillRelayClient, "create" | "pickup" | "refresh" | "revoke">;
  extension: AgenticAutofillExtension;
  assertEnabled(): void;
  clock?: AutofillClock;
};

// Extension errors are untrusted strings. Keep only the finite documented vocabulary.
const safeExtensionErrors = new Set([
  "invalidRequest",
  "authenticationFailed",
  "invalidTabId",
  "agenticModeNotEnabled",
  "noExistingCredentials",
  "fillFailed",
  "autosubmitFailed",
  "extensionNotReady",
  "rateLimitExceeded",
]);
function unwrap<T>(response: ExtResult<T>): T {
  if (!response.success) {
    throw new AutofillError(
      safeExtensionErrors.has(response.error.code) ? response.error.code : "extensionFailed",
    );
  }
  return response.result;
}

/** Gateway-only credential owner. All connection mutations share its serialization queue. */
export class AutofillService {
  private readonly clock: AutofillClock;
  private consentEpoch = 0;
  private readonly sessions = new Map<
    string,
    RelaySession & { epoch: number; createdAt: number }
  >();
  private readonly finalStatuses = new Map<string, AccessRequestStatus>();
  private readonly pickups = new Map<string, Exclude<Pickup, { state: "pending" }>>();
  private readonly unsettledConnections = new Map<string, AutofillConnection>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly approvalLinks: AutofillApprovalLinks;
  private readonly checkers = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ServiceOptions) {
    this.clock = options.clock ?? autofillClock;
    this.approvalLinks = new AutofillApprovalLinks(this.clock);
  }

  // Queue settlement includes rotation publication: a sibling never reads the old refresh token.
  private async serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(run);
    this.queues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(key) === pending) {
        this.queues.delete(key);
      }
    }
  }

  private assertCurrent(authority: AutofillAuthority): void {
    authority.signal?.throwIfAborted();
    authority.assertCurrent();
    this.options.assertEnabled();
  }

  private async connection(
    path: string,
    authority: AutofillAuthority,
  ): Promise<AutofillConnection> {
    let stored = await this.options.stores.connections.lookup(path);
    this.assertCurrent(authority);
    const pendingUpdate = this.unsettledConnections.get(path);
    if (pendingUpdate && stored) {
      // A successful external rotation must never be repeated with the old refresh token
      // just because its local write failed. Re-publish the same complete row first.
      await this.options.stores.connections.register(path, pendingUpdate, {
        assertCurrent: () => this.assertCurrent(authority),
      });
      this.unsettledConnections.delete(path);
      stored = pendingUpdate;
    }
    if (!stored) {
      throw new AutofillError("reconnectRequired");
    }
    if (stored.expiresAt > this.clock.now() + 60_000) {
      return stored;
    }
    try {
      const issuedNotBefore = this.clock.now();
      const tokens = await this.options.relay.refresh(stored.refreshToken, authority.signal);
      if (tokens.user_id && tokens.user_id !== stored.userId) {
        throw new AutofillError("connectionMismatch");
      }
      const rotated = this.withTokens(stored, tokens, issuedNotBefore);
      this.unsettledConnections.set(path, rotated);
      this.assertCurrent(authority);
      await this.options.stores.connections.register(path, rotated, {
        assertCurrent: () => this.assertCurrent(authority),
      });
      this.unsettledConnections.delete(path);
      return rotated;
    } catch (error) {
      if (error instanceof AutofillError && error.code === "reconnectRequired") {
        // invalid_grant is positive upstream evidence that the standing connection ended.
        await this.removeConnection(stored.path, authority);
      }
      throw error;
    }
  }

  private withTokens(
    connection: AutofillConnection,
    tokens: AutofillTokens,
    issuedNotBefore: number,
  ): AutofillConnection {
    return {
      ...connection,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: issuedNotBefore + tokens.expires_in * 1000,
    };
  }

  private async removeConnection(path: string, authority: AutofillAuthority): Promise<void> {
    this.assertCurrent(authority);
    await this.options.stores.connections.delete(path, {
      assertCurrent: () => this.assertCurrent(authority),
    });
    this.unsettledConnections.delete(path);
    for (const entry of await this.options.stores.requests.entries()) {
      if (entry.value.connectionPath === path) {
        this.finalStatuses.delete(entry.key);
        this.forgetApprovalLink(entry.key);
        await this.options.stores.requests.delete(entry.key, {
          assertCurrent: () => this.assertCurrent(authority),
        });
      }
    }
  }

  /** Start owner consent; only these three public session fields may reach a model. */
  async connect(authority: AutofillAuthority) {
    this.assertCurrent(authority);
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= this.clock.now() && !this.pickups.has(id)) {
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size >= 8) {
      throw new AutofillError("tooManyConnectAttempts");
    }
    const epoch = this.consentEpoch;
    const createdAt = this.clock.now();
    const session = await this.options.relay.create(authority.signal);
    this.assertCurrent(authority);
    if (epoch !== this.consentEpoch) {
      throw new AutofillError("connectCanceled");
    }
    this.sessions.set(session.sessionId, { ...session, epoch, createdAt });
    return {
      state: "pending",
      sessionId: session.sessionId,
      connectUrl: session.connectUrl,
      confirmationCode: session.confirmationCode,
      expiresAt: session.expiresAt,
    };
  }

  /** Explicit pickup is shared by CLI polling and chat; private keys never leave this service. */
  async pickup(sessionId: string, authority: AutofillAuthority) {
    return this.serialize("connect", async () => {
      this.assertCurrent(authority);
      const session = this.sessions.get(sessionId);
      if (
        !session ||
        session.epoch !== this.consentEpoch ||
        (Date.parse(session.expiresAt) <= this.clock.now() && !this.pickups.has(sessionId))
      ) {
        if (!this.pickups.has(sessionId)) {
          this.sessions.delete(sessionId);
        }
        throw new AutofillError("connectExpired");
      }
      const result =
        this.pickups.get(sessionId) ?? (await this.options.relay.pickup(session, authority.signal));
      // Pickup is one-use. Retain its result even if the requesting turn closes
      // while the relay is answering; later authorized work settles this same result.
      if (result.state !== "pending") {
        this.pickups.set(sessionId, result);
      }
      this.assertCurrent(authority);
      if (result.state === "pending") {
        return { state: "pending" };
      }
      if (result.state === "failed") {
        this.sessions.delete(sessionId);
        this.pickups.delete(sessionId);
        return { state: "failed", guidance: "Start connect again if you want to grant consent." };
      }
      const { tokens } = result;
      let stored: AutofillConnection | undefined;
      if (result.integrationKey) {
        let identity: ReturnType<typeof decodeConnectionPath>;
        try {
          identity = decodeConnectionPath(result.integrationKey);
        } catch {
          this.assertCurrent(authority);
          await this.options.relay.revoke(tokens.access_token, authority.signal);
          this.sessions.delete(sessionId);
          this.pickups.delete(sessionId);
          throw new AutofillError("invalidIntegrationKey");
        }
        if (tokens.user_id && tokens.user_id !== identity.userId) {
          this.assertCurrent(authority);
          await this.options.relay.revoke(tokens.access_token, authority.signal);
          this.sessions.delete(sessionId);
          this.pickups.delete(sessionId);
          throw new AutofillError("connectionMismatch");
        }
        stored = {
          ...identity,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: 0,
          integrationKey: result.integrationKey,
        };
      } else if (tokens.user_id) {
        const candidates = (await this.options.stores.connections.entries())
          .map(({ value }) => value)
          .filter((connection) => connection.userId === tokens.user_id);
        // With no new key, an ambiguous or absent identity must never borrow another account's key.
        if (candidates.length === 1) {
          stored = candidates[0];
        }
      }
      this.assertCurrent(authority);
      if (!stored) {
        await this.options.relay.revoke(tokens.access_token, authority.signal);
        this.sessions.delete(sessionId);
        this.pickups.delete(sessionId);
        throw new AutofillError("integrationKeyMissingReconnect");
      }
      // The protocol seals the original expires_in, not an issuance timestamp.
      // Consent cannot predate this attempt: use its start as a conservative expiry
      // bound so a delayed chat pickup never extends an already-aging access token.
      const connection = this.withTokens(stored, tokens, session.createdAt);
      const existing = await this.options.stores.connections.entries();
      this.assertCurrent(authority);
      if (existing.some((entry) => entry.key !== connection.path)) {
        await this.options.relay.revoke(tokens.access_token, authority.signal);
        this.sessions.delete(sessionId);
        this.pickups.delete(sessionId);
        throw new AutofillError("disconnectExistingConnectionFirst");
      }
      await this.serialize(connection.path, async () => {
        this.assertCurrent(authority);
        const previous = await this.options.stores.connections.lookup(connection.path);
        if (previous && previous.integrationKey !== connection.integrationKey) {
          // A replacement keyset invalidates every old reference on this path.
          await this.removeConnection(connection.path, authority);
        }
        this.unsettledConnections.delete(connection.path);
        await this.options.stores.connections.register(connection.path, connection, {
          assertCurrent: () => this.assertCurrent(authority),
        });
      });
      this.sessions.delete(sessionId);
      this.pickups.delete(sessionId);
      return { state: "connected" };
    });
  }

  /** Report readiness without access/refresh tokens, key, or connection paths. */
  async status(authority: AutofillAuthority) {
    const entries = await this.options.stores.connections.entries();
    this.assertCurrent(authority);
    const readiness = await this.options.extension.readiness?.();
    this.assertCurrent(authority);
    return {
      state: entries.length ? "connected" : "disconnected",
      connectionCount: entries.length,
      extensionAdapter: readiness?.success ? "ready" : "unavailable",
      ...(!readiness?.success
        ? { code: "extensionNotReady", guidance: autofillBrowserGuidance }
        : {}),
    };
  }

  // One owner account per browser. Explicit ambiguity is safer than selecting a stored login at random.
  private async selectedPath(authority: AutofillAuthority): Promise<string> {
    const entries = await this.options.stores.connections.entries();
    this.assertCurrent(authority);
    if (entries.length !== 1 || !entries[0]) {
      throw new AutofillError(
        entries.length ? "multipleConnectionsDisconnectFirst" : "reconnectRequired",
      );
    }
    return entries[0].key;
  }

  /** Revoke the whole connection; failure preserves credentials and grants for a later retry. */
  async disconnect(authority: AutofillAuthority) {
    return this.serialize("connect", async () => {
      this.assertCurrent(authority);
      // Invalidate locally pending consent too, including create() calls still awaiting
      // the relay. There is no protocol endpoint for canceling upstream OAuth consent.
      this.consentEpoch += 1;
      for (const [id, pickup] of this.pickups) {
        if (pickup.state === "connected") {
          const entries = await this.options.stores.connections.entries();
          let matchedPath = entries.find(
            ({ value }) => value.userId === pickup.tokens.user_id,
          )?.key;
          if (pickup.integrationKey) {
            try {
              matchedPath = decodeConnectionPath(pickup.integrationKey).path;
            } catch {
              // Malformed pickup keys must not prevent revoking their valid OAuth tokens.
              matchedPath = undefined;
            }
          }
          await this.serialize(matchedPath ?? "unidentified-pickup", async () => {
            let tokens = pickup.tokens;
            let ended = false;
            const session = this.sessions.get(id);
            // Recovery pickups may be expired or already invalidated by revoking
            // another consent for this same connection. Refresh once to distinguish
            // a usable current token from positive invalid_grant termination evidence.
            this.assertCurrent(authority);
            const issuedNotBefore = this.clock.now();
            try {
              tokens = await this.options.relay.refresh(tokens.refresh_token, authority.signal);
              // Preserve a successful one-use rotation even if this disconnect is canceled.
              this.pickups.set(id, { ...pickup, tokens });
              if (session) {
                this.sessions.set(id, { ...session, createdAt: issuedNotBefore });
              }
            } catch (error) {
              if (!(error instanceof AutofillError) || error.code !== "reconnectRequired") {
                throw error;
              }
              ended = true;
            }
            this.assertCurrent(authority);
            if (!ended) {
              await this.options.relay.revoke(tokens.access_token, authority.signal);
            }
            this.pickups.delete(id);
            this.sessions.delete(id);
            if (matchedPath) {
              await this.removeConnection(matchedPath, authority);
            }
          });
        }
        this.pickups.delete(id);
        this.sessions.delete(id);
      }
      for (const { key: path } of await this.options.stores.connections.entries()) {
        await this.serialize(path, async () => {
          const connection = await this.connection(path, authority);
          this.assertCurrent(authority);
          await this.options.relay.revoke(connection.accessToken, authority.signal);
          await this.removeConnection(path, authority);
        });
      }
      // Complete an earlier interrupted local cleanup even if its credential row
      // was already deleted after successful revocation. No connections remain.
      for (const entry of await this.options.stores.requests.entries()) {
        await this.options.stores.requests.delete(entry.key, {
          assertCurrent: () => this.assertCurrent(authority),
        });
        this.finalStatuses.delete(entry.key);
      }
      this.sessions.clear();
      this.clearApprovalLinks();
      return { state: "disconnected" };
    });
  }

  /** Request a task's logins and hand its opaque approval link only to sensitive delivery code. */
  async requestLogins(input: AccessRequestInput, scope: string, authority: AutofillAuthority) {
    const parsed = accessRequestInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new AutofillError("invalidRequest");
    }
    const path = await this.selectedPath(authority);
    return this.serialize(path, async () => {
      const connection = await this.connection(path, authority);
      this.assertCurrent(authority);
      const created = unwrap(
        await this.options.extension.createAccessRequest({
          accessToken: connection.accessToken,
          integrationKey: connection.integrationKey,
          requests: parsed.data,
        }),
      );
      this.assertCurrent(authority);
      const record: AutofillRequest = {
        connectionPath: path,
        integrationKeyFingerprint: sha256Hex(connection.integrationKey),
        scope,
        request: created.accessRequest,
        status: {
          path: created.accessRequest.path,
          state: created.accessRequest.state,
          resolved: [],
        },
      };
      await this.options.stores.requests.register(created.accessRequest.id, record, {
        assertCurrent: () => this.assertCurrent(authority),
      });
      this.assertCurrent(authority);
      this.approvalLinks.remember(record.request.id, created.appLink);
      return this.publicRequest(record);
    });
  }

  /** Release ephemeral links at service retirement and during its expiry sweep. */
  clearApprovalLinks(): void {
    this.approvalLinks.clear();
  }

  /** Retire an unusable or completed private approval reference. */
  forgetApprovalLink(id: string): void {
    this.approvalLinks.forget(id);
  }

  /** The service scheduler calls this even when nobody reads old transcript views. */
  pruneApprovalLinks(): void {
    this.approvalLinks.prune();
  }

  /** Private native-view hydration. Reading never acknowledges or polls a request. */
  async approval(id: string, scope: string, authority: AutofillAuthority) {
    let record = await this.request(id, scope, authority);
    const checker = this.checkers.get(id);
    // The window's final read joins the existing checker, never starts a second
    // 1Password check or reports expiry while its last response is still in flight.
    if (checker && record.openedAt !== undefined && this.clock.now() >= record.openedAt + 120_000) {
      await checker;
      record = await this.request(id, scope, authority);
    }
    const connection = await this.options.stores.connections.lookup(record.connectionPath);
    this.assertCurrent(authority);
    if (!connection || sha256Hex(connection.integrationKey) !== record.integrationKeyFingerprint) {
      throw new AutofillError("requestNotFound");
    }
    return this.approvalLinks.snapshot(record);
  }

  /** Persist the explicit button click before admitting a service-owned checker. */
  async noteApprovalOpened(id: string, scope: string, authority: AutofillAuthority): Promise<void> {
    const openedAt = this.clock.now();
    const initial = await this.request(id, scope, authority);
    await this.serialize(initial.connectionPath, async () => {
      const current = await this.request(id, scope, authority, false);
      if (current.status.state === "pending" && current.openedAt === undefined) {
        await this.options.stores.requests.register(
          id,
          { ...current, openedAt },
          {
            assertCurrent: () => this.assertCurrent(authority),
          },
        );
      }
    });
  }

  private async request(
    id: string,
    scope: string,
    authority: AutofillAuthority,
    settleFinal = true,
  ): Promise<AutofillRequest> {
    const request = await this.options.stores.requests.lookup(id);
    this.assertCurrent(authority);
    if (!request || request.scope !== scope) {
      throw new AutofillError("requestNotFound");
    }
    const observed = this.finalStatuses.get(id);
    if (observed && request.status.state === "pending") {
      if (!settleFinal) {
        return { ...request, status: observed, pollingEnded: true };
      }
      return this.serialize(request.connectionPath, async () => {
        const current = await this.options.stores.requests.lookup(id);
        const connection = await this.options.stores.connections.lookup(request.connectionPath);
        this.assertCurrent(authority);
        if (
          !connection ||
          !current ||
          current.scope !== scope ||
          sha256Hex(connection.integrationKey) !== request.integrationKeyFingerprint
        ) {
          this.finalStatuses.delete(id);
          throw new AutofillError("requestNotFound");
        }
        const settled = { ...request, status: observed, pollingEnded: true };
        await this.options.stores.requests.register(id, settled, {
          assertCurrent: () => this.assertCurrent(authority),
        });
        this.finalStatuses.delete(id);
        return settled;
      });
    }
    return request;
  }

  // Deliberately project, never spread upstream objects: references and link text stay host-only.
  private publicRequest(record: AutofillRequest) {
    return {
      state: record.status.state,
      requestId: record.request.id,
      entries: record.request.entries.map((entry) => ({
        entryId: entry.id,
        website: entry.parameters.website,
        label: entry.reason ?? "Login",
        granted:
          record.status.state === "resolved" &&
          record.status.resolved.some((grant) => grant.entryId === entry.id),
      })),
    };
  }

  /** Check only after the user says they opened the link. Finished requests are read locally. */
  async checkStatus(id: string, scope: string, opened: boolean, authority: AutofillAuthority) {
    const record = await this.request(id, scope, authority);
    if (record.status.state !== "pending" || !opened) {
      return {
        ...this.publicRequest(record),
        guidance:
          record.status.state === "pending"
            ? record.openedAt === undefined
              ? "Confirm you opened the approval link on your device before polling."
              : "The approval was opened. Check its Control UI status or explicitly confirm approval for another check."
            : "Request finished; it will not be checked again.",
      };
    }
    if (this.checkers.has(id)) {
      return {
        ...this.publicRequest(record),
        guidance: "A status checker is already running for this request.",
      };
    }
    const pending = this.pollRequest(record, authority);
    this.checkers.set(id, pending);
    try {
      return await pending;
    } finally {
      this.checkers.delete(id);
    }
  }

  private async pollRequest(initial: AutofillRequest, authority: AutofillAuthority) {
    const id = initial.request.id;
    const record = await this.serialize(initial.connectionPath, async () => {
      // The initiating lookup may predate disconnect or another checker's final
      // publication. Reread under the writer queue; never upsert that old snapshot.
      const current = await this.request(id, initial.scope, authority, false);
      const connection = await this.options.stores.connections.lookup(current.connectionPath);
      this.assertCurrent(authority);
      if (
        !connection ||
        sha256Hex(connection.integrationKey) !== current.integrationKeyFingerprint
      ) {
        throw new AutofillError("requestNotFound");
      }
      if (current.status.state !== "pending" || current.pollingEnded) {
        return current;
      }
      const started = { ...current, openedAt: current.openedAt ?? this.clock.now() };
      await this.options.stores.requests.register(id, started, {
        assertCurrent: () => this.assertCurrent(authority),
      });
      return started;
    });
    if (record.status.state !== "pending") {
      return {
        ...this.publicRequest(record),
        guidance: "Request finished; it will not be checked again.",
      };
    }
    if (record.pollingEnded) {
      // After the automatic window, an explicit user acknowledgement permits exactly one check.
      const final = await this.checkOnce(record, authority);
      return {
        ...this.publicRequest(final),
        guidance:
          final.status.state === "pending"
            ? "Still pending. Ask the user before creating a new request."
            : "Request finished.",
      };
    }
    const openedAt = record.openedAt ?? this.clock.now();
    const status = await pollAutofillDecision({
      clock: this.clock,
      openedAt,
      signal: authority.signal,
      check: () =>
        this.serialize(record.connectionPath, async () => {
          return this.statusCheck(record, authority);
        }),
    });
    const settled = { ...record, pollingEnded: true, ...(status ? { status } : {}) };
    await this.serialize(record.connectionPath, async () => {
      // Final status persistence does not need fresh OAuth tokens. Check only
      // whether the standing connection still exists; do not refresh after a final.
      const connection = await this.options.stores.connections.lookup(record.connectionPath);
      const current = await this.options.stores.requests.lookup(id);
      this.assertCurrent(authority);
      if (
        !connection ||
        !current ||
        sha256Hex(connection.integrationKey) !== record.integrationKeyFingerprint
      ) {
        throw new AutofillError("requestNotFound");
      }
      await this.options.stores.requests.register(id, settled, {
        assertCurrent: () => this.assertCurrent(authority),
      });
    });
    this.finalStatuses.delete(id);
    return {
      ...this.publicRequest(settled),
      guidance: status
        ? "Request finished."
        : "Polling stopped after two minutes. Tell me when you have approved; then I can check once more.",
    };
  }

  private async checkOnce(
    record: AutofillRequest,
    authority: AutofillAuthority,
  ): Promise<AutofillRequest> {
    return this.serialize(record.connectionPath, async () => {
      const status = unwrap(await this.statusCheck(record, authority));
      const updated = { ...record, status };
      await this.options.stores.requests.register(record.request.id, updated, {
        assertCurrent: () => this.assertCurrent(authority),
      });
      this.finalStatuses.delete(record.request.id);
      return updated;
    });
  }

  // Called only under the connection queue. A connection-level cooldown also covers
  // manual follow-up checks and other requests after a rate limit or process restart.
  private async statusCheck(
    record: AutofillRequest,
    authority: AutofillAuthority,
  ): Promise<ExtResult<AccessRequestStatus>> {
    const current = await this.request(record.request.id, record.scope, authority, false);
    if (current.status.state !== "pending") {
      return { success: true, result: current.status };
    }
    const connection = await this.connection(record.connectionPath, authority);
    this.assertCurrent(authority);
    if (sha256Hex(connection.integrationKey) !== record.integrationKeyFingerprint) {
      throw new AutofillError("requestNotFound");
    }
    if ((connection.statusNotBefore ?? 0) > this.clock.now()) {
      return { success: false, error: { code: "rateLimitExceeded" } };
    }
    const result = await this.options.extension.getAccessRequestStatus({
      accessToken: connection.accessToken,
      integrationKey: connection.integrationKey,
      accessRequestUUID: record.request.id,
    });
    // An observed final response is immutable. Retain it before any awaited local
    // bookkeeping, so storage failure or cancellation can never trigger another check.
    if (result.success && result.result.state !== "pending") {
      this.finalStatuses.set(record.request.id, result.result);
    }
    const cooldown = !result.success && result.error.code === "rateLimitExceeded" ? 60_000 : 2000;
    const updated = { ...connection, statusNotBefore: this.clock.now() + cooldown };
    // A received rate limit survives a canceled invocation or failed local write too.
    this.unsettledConnections.set(connection.path, updated);
    await this.options.stores.connections.register(connection.path, updated, {
      assertCurrent: () => this.assertCurrent(authority),
    });
    this.unsettledConnections.delete(connection.path);
    return result;
  }

  /** Fill only a matched grant from this task's request; no caller-supplied references. */
  async fill(
    id: string,
    entryId: string,
    tab: { targetId: string; profile?: string },
    scope: string,
    authority: AutofillAuthority,
  ) {
    const request = await this.request(id, scope, authority);
    return this.serialize(request.connectionPath, async () => {
      const current = await this.request(id, scope, authority, false);
      const entry = current.request.entries.find((candidate) => candidate.id === entryId);
      const grant = current.status.resolved.find((candidate) => candidate.entryId === entryId);
      if (current.status.state !== "resolved" || !entry || !grant) {
        throw new AutofillError("loginNotGranted");
      }
      const connection = await this.connection(current.connectionPath, authority);
      this.assertCurrent(authority);
      if (sha256Hex(connection.integrationKey) !== current.integrationKeyFingerprint) {
        throw new AutofillError("requestNotFound");
      }
      const result = unwrap(
        await this.options.extension.fillCredential({
          accessToken: connection.accessToken,
          integrationKey: connection.integrationKey,
          resourcePath: grant.reference,
          tab,
        }),
      );
      return {
        state: result.status,
        website: entry.parameters.website,
        entryId,
        guidance:
          "The form was filled and submitted. Check the page to see whether sign-in succeeded.",
      };
    });
  }
}
