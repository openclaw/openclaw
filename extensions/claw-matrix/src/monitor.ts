import { initHttpClient, matrixFetch } from "./client/http.js";
import { initCryptoMachine, getCryptoStorePath, closeMachine, getMachine } from "./crypto/machine.js";
import { processOutgoingRequests } from "./crypto/outgoing.js";
import { restoreCrossSigningFromSSSSIfNeeded, serverHasCrossSigningKeys, readLocalSskSeed, type SsssRestoreResult } from "./crypto/ssss.js";
import { selfSignDevice } from "./crypto/self-sign.js";
import { runSyncLoop } from "./client/sync.js";
import { sendMatrixMessage, sendTyping } from "./client/send.js";
import { downloadAndDecryptMedia, type EncryptedFile } from "./client/media.js";
import { isDmRoomAsync, getRoomName, getMemberDisplayName, initMDirectCache } from "./client/rooms.js";
import { getMatrixRuntime } from "./runtime.js";
import type { MatrixEvent } from "./types.js";
import type { ResolvedMatrixAccount } from "./config.js";
import type { OpenClawConfig, PluginLogger, GatewayStatus, PluginRuntime } from "./openclaw-types.js";
import { incrementCounter } from "./health.js";
import { createLogger } from "./util/logger.js";

// SINGLETON: Only one account can run at a time. Multi-account requires
// refactoring all module-level singletons to per-account state.
let _activeAccountId: string | null = null;

/**
 * Monitor options — passed from gateway.startAccount() context.
 */
export interface MonitorMatrixOpts {
  config: OpenClawConfig;
  account: ResolvedMatrixAccount;
  accountId: string;
  abortSignal: AbortSignal;
  log?: PluginLogger;
  getStatus: () => GatewayStatus;
  setStatus: (next: GatewayStatus) => void;
}

/**
 * Start the Matrix monitor.
 *
 * This is called by gateway.startAccount() in channel.ts.
 * It initializes crypto, starts the sync loop, and dispatches
 * inbound messages to OpenClaw's auto-reply pipeline via MsgContext.
 */
export async function monitorMatrixProvider(
  opts: MonitorMatrixOpts
): Promise<void> {
  const { account, accountId, abortSignal, log, setStatus } = opts;
  const slog = createLogger("matrix", log);

  // Guard: only one account at a time — singletons are not per-account
  if (_activeAccountId !== null) {
    throw new Error(
      `[claw-matrix] Cannot start account "${accountId}": account "${_activeAccountId}" is already running. ` +
      `Multi-account requires refactoring module-level singletons (OlmMachine, HTTP client, sync state, room caches).`
    );
  }
  _activeAccountId = accountId;

  if (!account.homeserver || !account.userId || !account.accessToken) {
    slog.error("Missing required config (homeserver/userId/accessToken)");
    return;
  }

  slog.info("Starting monitor", { userId: account.userId, homeserver: account.homeserver });

  // 1. Initialize HTTP client
  initHttpClient(account.homeserver, account.accessToken);

  // 1b. Initialize m.direct cache for DM detection
  initMDirectCache(account.userId);

  // 2. Initialize crypto machine
  const cryptoStorePath = getCryptoStorePath(
    account.homeserver,
    account.userId,
    account.accessToken
  );

  // 2a. Restore cross-signing keys from SSSS before OlmMachine opens the store
  let ssssResult: SsssRestoreResult = { restored: false };
  try {
    ssssResult = await restoreCrossSigningFromSSSSIfNeeded({
      storePath: cryptoStorePath,
      recoveryKey: account.recoveryKey,
      userId: account.userId,
      log,
    });
    if (ssssResult.restored) {
      slog.info("Cross-signing keys restored from SSSS into local store");
    }
  } catch (err: any) {
    slog.warn("SSSS cross-signing restore failed", { error: err.message });
  }

  try {
    await initCryptoMachine(
      account.userId,
      account.deviceName,
      cryptoStorePath
    );
    slog.info("Crypto initialized", { store: cryptoStorePath });

    // Crypto startup diagnostics
    try {
      const machine = getMachine();
      const identity = machine.identityKeys;
      slog.info("Device keys", {
        curve25519: String(identity.curve25519).slice(0, 8) + "...",
        ed25519: String(identity.ed25519).slice(0, 8) + "...",
      });
      const crossSigning = await machine.crossSigningStatus();
      slog.info("Cross-signing status", {
        master: crossSigning.hasMaster,
        self: crossSigning.hasSelfSigning,
        user: crossSigning.hasUserSigning,
      });
      if (!crossSigning.hasMaster) {
        if (serverHasCrossSigningKeys()) {
          // Keys exist on server but not locally — SSSS restore either wasn't
          // possible (no recovery key) or didn't succeed. DO NOT bootstrap:
          // that would destroy the existing server-side identity.
          slog.warn("Cross-signing keys on server but not available locally — " +
            "configure recoveryKey to restore. Device will remain unverified.");
        } else {
          // Truly no keys anywhere — initial bootstrap is correct
          slog.info("No cross-signing keys found anywhere — bootstrapping");
          try {
            await machine.bootstrapCrossSigning(true);
            await processOutgoingRequests(log);
            slog.info("Cross-signing bootstrapped successfully");
          } catch (bsErr: any) {
            slog.warn("Cross-signing bootstrap failed", { error: bsErr.message });
          }
        }
      }
    } catch (diagErr: any) {
      slog.warn("Crypto diagnostics failed", { error: diagErr.message });
    }

    // 2a-ii. Self-sign device with cross-signing key (every startup)
    // SSK seed comes from SSSS restore (if it just ran) or local SQLite store
    {
      const sskSeedB64 = ssssResult.secrets?.selfSigning
        ?? readLocalSskSeed(cryptoStorePath);
      if (sskSeedB64) {
        try {
          const keysResp = await matrixFetch<{
            self_signing_keys?: Record<string, { keys?: Record<string, string> }>;
            device_keys?: Record<string, Record<string, { signatures?: Record<string, Record<string, string>> }>>;
          }>("POST", "/_matrix/client/v3/keys/query", {
            device_keys: { [account.userId]: [account.deviceName] },
          });

          const sskKeyData = keysResp.self_signing_keys?.[account.userId];
          const sskEntry = Object.entries(sskKeyData?.keys ?? {}).find(([k]) => k.startsWith("ed25519:"));
          const sskPublicKeyId = sskEntry?.[1];

          const deviceSigs = keysResp.device_keys?.[account.userId]?.[account.deviceName]?.signatures?.[account.userId] ?? {};
          const alreadySigned = Object.keys(deviceSigs).some(
            (k) => k.startsWith("ed25519:") && k !== `ed25519:${account.deviceName}`
          );

          if (alreadySigned) {
            slog.info("Device already cross-signed — skipping self-sign");
          } else if (sskPublicKeyId) {
            const machine = getMachine();
            const identity = machine.identityKeys;
            await selfSignDevice({
              userId: account.userId,
              deviceId: account.deviceName,
              sskSeed: Buffer.from(sskSeedB64, "base64"),
              sskPublicKeyId,
              deviceEd25519Key: String(identity.ed25519),
              deviceCurve25519Key: String(identity.curve25519),
              log,
            });
            slog.info("Device self-signed with cross-signing key");
          } else {
            slog.warn("Could not find SSK public key ID on server — skipping self-sign");
          }
        } catch (selfSignErr: any) {
          slog.warn("Device self-signing failed", { error: selfSignErr.message });
        }
      }
    }
  } catch (err: any) {
    slog.error("Failed to initialize crypto", { error: err.message });
    return;
  }

  // 2b. Activate recovery key for server-side key backup (if configured)
  let backupInfo: { decryptionKey: any; version: string } | undefined;
  if (account.recoveryKey) {
    try {
      const { activateRecoveryKey } = await import("./crypto/recovery.js");
      backupInfo = await activateRecoveryKey(account.recoveryKey, log);
      if (backupInfo) {
        slog.info("Key backup activated", { version: backupInfo.version });
      }
    } catch (err: any) {
      slog.warn("Recovery key activation failed", { error: err.message });
    }
  }

  // 3. Graceful shutdown: let the sync loop detect abortSignal and close
  // the machine in its finally block. This ensures the current sync cycle
  // completes before crypto teardown — prevents mid-operation FFI panics.
  abortSignal.addEventListener("abort", () => {
    slog.info("Shutdown requested (abortSignal) — waiting for sync loop to exit");
  });

  setStatus({
    running: true,
    connected: false,
    lastStartAt: Date.now(),
  });

  // 4. Get OpenClaw runtime for dispatch
  const core: PluginRuntime = getMatrixRuntime();

  // Per-room serial dispatch queue — prevents interleaved agent replies
  const roomQueues = new Map<string, Promise<void>>();
  function enqueueForRoom(roomId: string, fn: () => Promise<void>): void {
    const prev = roomQueues.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      // Self-clean if this is still the tail
      if (roomQueues.get(roomId) === next) roomQueues.delete(roomId);
    });
    roomQueues.set(roomId, next);
  }

  // 5. Build message handler
  async function handleMessage(event: MatrixEvent, roomId: string): Promise<void> {
    // Skip own messages
    if (event.sender === account.userId) return;

    // Access control — use async m.direct check for authoritative DM detection
    const chatType = (await isDmRoomAsync(roomId)) ? "dm" : "group";

    if (chatType === "dm") {
      if (account.dm.policy === "disabled") return;
      if (account.dm.policy === "allowlist") {
        const sender = (event.sender ?? "").replace(/^matrix:/, "");
        const allowed = account.dm.allowFrom.some(
          (a) => a.replace(/^matrix:/, "") === sender
        );
        if (!allowed) {
          slog.info("Dropping DM (not in allowlist)", { sender: event.sender });
          return;
        }
      }
    } else {
      if (account.groupPolicy === "disabled") return;
      if (account.groupPolicy === "allowlist") {
        const groupConfig = account.groups[roomId];
        if (!groupConfig?.allow) {
          const sender = (event.sender ?? "").replace(/^matrix:/, "");
          const allowed = account.groupAllowFrom.some(
            (a) => a.replace(/^matrix:/, "") === sender
          );
          if (!allowed) return;
        }
      }
    }

    // Handle reactions — log but don't dispatch as message
    if (event.type === "m.reaction") {
      const relates = event.content?.["m.relates_to"] as Record<string, unknown> | undefined;
      slog.info("Reaction received", { sender: event.sender, key: relates?.key, target: relates?.event_id });
      return;
    }

    // For edited messages, use the new content
    const newContent = event.content?.["m.new_content"] as Record<string, unknown> | undefined;
    const effectiveContent = newContent ?? event.content ?? {};
    const body =
      typeof effectiveContent.body === "string" ? effectiveContent.body as string : "";
    const msgtype = (effectiveContent.msgtype ?? event.content?.msgtype) as string | undefined;

    // Detect media messages
    const isMedia = msgtype && !["m.text", "m.notice"].includes(msgtype);
    let mediaPath: string | undefined;
    let mediaType: string | undefined;

    if (isMedia) {
      const mxcUrl = (effectiveContent.url ?? (effectiveContent.file as any)?.url) as string | undefined;
      const encFile = effectiveContent.file as EncryptedFile | undefined;
      const mimeType = (effectiveContent.info as any)?.mimetype as string | undefined;

      if (mxcUrl) {
        try {
          const buffer = await downloadAndDecryptMedia(
            mxcUrl,
            encFile,
            account.maxMediaSize
          );
          // Save via runtime media API if available
          if (core.channel.media?.saveMediaBuffer) {
            const saved = await core.channel.media.saveMediaBuffer(
              buffer,
              mimeType ?? "application/octet-stream",
            );
            mediaPath = saved?.path;
          }
          mediaType = mimeType;
          incrementCounter("mediaReceived");
          slog.info("Downloaded media", { mimeType, bytes: buffer.length });
        } catch (mediaErr: any) {
          slog.warn("Media download failed", { error: mediaErr.message });
          // Continue dispatch without media
        }
      }
    }

    // Skip messages with no text body and no media
    if (!body.trim() && !isMedia) return;

    slog.info("Message received", {
      sender: event.sender,
      roomId,
      chatType,
      msgtype: isMedia ? msgtype : undefined,
      bodyPreview: body.slice(0, 80) + (body.length > 80 ? "..." : ""),
    });

    // Resolve which agent handles this message
    let route: { agentId: string; sessionKey: string } | null;
    try {
      route = core.channel.routing.resolveAgentRoute({
        cfg: opts.config,
        channel: "matrix",
        accountId,
        peer: {
          kind: chatType === "dm" ? "direct" : "group",
          id: chatType === "dm" ? (event.sender ?? "") : roomId,
        },
      });
      slog.info("Route resolved", { agent: route?.agentId, session: route?.sessionKey });
    } catch (routeErr: any) {
      slog.error("resolveAgentRoute failed", { error: routeErr.message });
      return;
    }

    if (!route || !route.sessionKey) {
      slog.error("No route found", { channel: "matrix", accountId, peer: chatType === "dm" ? event.sender : roomId });
      return;
    }

    // Parse reply/thread relations
    const relates = event.content?.["m.relates_to"] as Record<string, unknown> | undefined;
    const inReplyTo = relates?.["m.in_reply_to"] as Record<string, unknown> | undefined;
    const replyToId = typeof inReplyTo?.event_id === "string" ? inReplyTo.event_id : undefined;
    const threadId = relates?.rel_type === "m.thread" && typeof relates.event_id === "string"
      ? relates.event_id
      : undefined;

    // Adjust session key for threads
    const sessionKey = threadId
      ? `${route.sessionKey}:thread:${threadId}`
      : route.sessionKey;

    // Build and finalize MsgContext for OpenClaw dispatch
    let ctxPayload: Record<string, unknown>;
    try {
      ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: body,
      CommandBody: body,
      From:
        chatType === "dm"
          ? `matrix:${event.sender}`
          : `matrix:room:${roomId}`,
      To: `matrix:${roomId}`,
      SessionKey: sessionKey,
      AccountId: accountId,
      ChatType: chatType === "dm" ? "direct" : "group",
      GroupSubject: chatType === "group" ? getRoomName(roomId) : undefined,
      SenderName: await getMemberDisplayName(roomId, event.sender ?? ""),
      SenderId: event.sender,
      ReplyToId: replyToId,
      MessageThreadId: threadId,
      Provider: "matrix",
      Surface: "matrix",
      MessageSid: event.event_id,
      OriginatingChannel: "matrix",
      OriginatingTo: roomId,
      Timestamp: event.origin_server_ts,
      MediaPath: mediaPath,
      MediaType: mediaType,
      CommandAuthorized: true,
    });

      slog.info("Context finalized, dispatching to agent");
    } catch (ctxErr: any) {
      slog.error("finalizeInboundContext failed", { error: ctxErr.message });
      return;
    }

    // Record inbound session for OpenClaw session management
    const storePath = core.channel.session?.resolveStorePath?.(
      (opts.config as Record<string, any>).session?.store,
      { agentId: route.agentId }
    );
    if (storePath) {
      core.channel.session?.recordInboundSession?.({
        storePath,
        sessionKey: (ctxPayload.SessionKey as string) ?? route.sessionKey,
        ctx: ctxPayload,
        updateLastRoute: chatType === "dm" ? {
          sessionKey: route.mainSessionKey ?? `agent:${route.agentId}:main`,
          channel: "matrix",
          to: `user:${event.sender}`,
          accountId,
        } : undefined,
        onRecordError: (err: unknown) => {
          slog.error("recordInboundSession failed", { error: String(err) });
        },
      });
    }

    // Enqueue for per-room serial dispatch
    enqueueForRoom(roomId, async () => {
      // Send typing indicator before dispatch
      sendTyping(roomId, account.userId, true);

      try {
        await core.channel.reply
          .dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg: opts.config,
            dispatcherOptions: {
              deliver: async (payload: { text?: string; [key: string]: unknown }) => {
                const text = payload.text ?? "";
                if (!text.trim()) return;
                await sendMatrixMessage({
                  roomId,
                  text,
                  replyToId: undefined,
                });
              },
              onError: (err: unknown, info: { kind: string }) => {
                slog.error("Reply dispatch failed", { kind: info.kind, error: String(err) });
              },
            },
          });
      } catch (err: any) {
        slog.error("Dispatch failed", { error: err.message });
      } finally {
        sendTyping(roomId, account.userId, false);
      }
    });
  }

  // 6. Run sync loop
  try {
    await runSyncLoop({
      userId: account.userId,
      cryptoStorePath,
      abortSignal,
      onMessage: handleMessage,
      log,
      setStatus,
      password: account.password,
      deviceName: account.deviceName,
      autoJoin: account.autoJoin,
      autoJoinAllowFrom: account.autoJoinAllowFrom,
      backupDecryptionKey: backupInfo?.decryptionKey,
      backupVersion: backupInfo?.version,
    });
  } catch (err: any) {
    if (!abortSignal.aborted) {
      slog.error("Sync loop crashed", { error: err.message });
      setStatus({
        connected: false,
        running: false,
        lastError: err.message,
      });
    }
  } finally {
    // Drain in-flight per-room dispatch queues before closing crypto
    const pendingQueues = [...roomQueues.values()];
    if (pendingQueues.length > 0) {
      slog.info("Draining room dispatch queues", { count: pendingQueues.length });
      await Promise.allSettled(pendingQueues);
    }
    _activeAccountId = null;
    await closeMachine();
    setStatus({ running: false, connected: false });
    slog.info("Monitor stopped");
  }
}
