/**
 * SAS (Short Authentication String) verification state machine.
 *
 * Manages active verification sessions and automatically completes
 * the SAS verification flow when another user initiates verification.
 *
 * Supports both in-room and to-device verification.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import {
  buildMacInfoString,
  buildSasInfoString,
  canonicalJson,
  computeCommitment,
  computeMac,
  computeSharedSecret,
  computeSasEmojis,
  decodeUnpaddedBase64,
  deriveSasBytes,
  encodeUnpaddedBase64,
  formatSasEmojis,
  generateX25519KeyPair,
} from "./sas-crypto.js";
import {
  CancelCode,
  VerificationEventType,
  type SasSession,
  type SasSessionState,
  type VerificationAcceptContent,
  type VerificationCancelContent,
  type VerificationKeyContent,
  type VerificationMacContent,
  type VerificationRawEvent,
  type VerificationReadyContent,
  type VerificationRelation,
  type VerificationRequestContent,
  type VerificationStartContent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAS_METHOD = "m.sas.v1";
const KEY_AGREEMENT = "curve25519-hkdf-sha256";
const HASH_METHOD = "sha256";
const MAC_METHOD_V2 = "hkdf-hmac-sha256.v2";
const MAC_METHOD_V1 = "hkdf-hmac-sha256";
const SAS_TYPES = ["emoji", "decimal"];

/** Maximum session lifetime (10 minutes) */
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/** Delay before auto-confirming SAS (allows user to see emojis) */
const AUTO_CONFIRM_DELAY_MS = 5_000;

/** Maximum number of concurrent sessions */
const MAX_SESSIONS = 16;

// ---------------------------------------------------------------------------
// Helper: build m.relates_to for in-room verification
// ---------------------------------------------------------------------------

function buildRelation(session: SasSession): VerificationRelation | undefined {
  if (!session.inRoom || !session.requestEventId) {
    return undefined;
  }
  return {
    rel_type: "m.reference" as const,
    event_id: session.requestEventId,
  };
}

// ---------------------------------------------------------------------------
// SasVerificationHandler
// ---------------------------------------------------------------------------

export type SasVerificationHandlerParams = {
  client: MatrixClient;
  logVerboseMessage: (message: string) => void;
};

export class SasVerificationHandler {
  private readonly client: MatrixClient;
  private readonly logVerboseMessage: (message: string) => void;
  private readonly sessions: Map<string, SasSession> = new Map();
  private selfUserId: string | undefined;
  private selfDeviceId: string | undefined;

  constructor(params: SasVerificationHandlerParams) {
    this.client = params.client;
    this.logVerboseMessage = params.logVerboseMessage;
  }

  /**
   * Handle an incoming verification event (either room event or to-device).
   */
  handleVerificationEvent(event: VerificationRawEvent, roomId?: string): void {
    // Run async handler without blocking the event loop
    void this.handleVerificationEventAsync(event, roomId).catch((err) => {
      this.logVerboseMessage(`matrix: verification handler error: ${String(err)}`);
    });
  }

  private async handleVerificationEventAsync(
    event: VerificationRawEvent,
    roomId?: string,
  ): Promise<void> {
    const eventType = event.type;
    const content = event.content as Record<string, unknown>;

    // Resolve self identity
    if (!this.selfUserId || !this.selfDeviceId) {
      try {
        this.selfUserId = await this.client.getUserId();
        this.selfDeviceId = await resolveDeviceId(this.client);
      } catch (err) {
        this.logVerboseMessage(
          `matrix: verification: failed to resolve self identity: ${String(err)}`,
        );
        return;
      }
    }

    // Determine transaction ID
    const transactionId = this.resolveTransactionId(event, roomId);
    if (!transactionId) {
      this.logVerboseMessage(
        `matrix: verification: cannot determine transaction ID for ${eventType}`,
      );
      return;
    }

    // Clean expired sessions
    this.cleanExpiredSessions();

    // Dispatch based on event type
    if (
      eventType === VerificationEventType.Request ||
      (eventType === "m.room.message" &&
        (content as { msgtype?: string }).msgtype === VerificationEventType.Request)
    ) {
      await this.handleRequest(event, transactionId, roomId);
    } else if (eventType === VerificationEventType.Ready) {
      await this.handleReady(event, transactionId);
    } else if (eventType === VerificationEventType.Start) {
      await this.handleStart(event, transactionId);
    } else if (eventType === VerificationEventType.Accept) {
      await this.handleAccept(event, transactionId);
    } else if (eventType === VerificationEventType.Key) {
      await this.handleKey(event, transactionId);
    } else if (eventType === VerificationEventType.Mac) {
      await this.handleMac(event, transactionId);
    } else if (eventType === VerificationEventType.Done) {
      this.handleDone(transactionId);
    } else if (eventType === VerificationEventType.Cancel) {
      this.handleCancel(event, transactionId);
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  /**
   * Handle m.key.verification.request
   * Auto-accept and send m.key.verification.ready
   */
  private async handleRequest(
    event: VerificationRawEvent,
    transactionId: string,
    roomId?: string,
  ): Promise<void> {
    const content = event.content as unknown as VerificationRequestContent;
    const sender = event.sender;

    if (sender === this.selfUserId) {
      return; // Ignore our own requests
    }

    const methods = content.methods ?? [];
    if (!methods.includes(SAS_METHOD)) {
      this.logVerboseMessage(
        `matrix: verification: request from ${sender} does not support ${SAS_METHOD}, ignoring`,
      );
      return;
    }

    if (this.sessions.size >= MAX_SESSIONS) {
      this.logVerboseMessage("matrix: verification: too many active sessions, ignoring request");
      return;
    }

    const inRoom = roomId !== undefined;
    const session: SasSession = {
      transactionId,
      inRoom,
      roomId,
      requestEventId: inRoom ? event.event_id : undefined,
      remoteUserId: sender,
      remoteDeviceId: content.from_device,
      selfUserId: this.selfUserId!,
      selfDeviceId: this.selfDeviceId!,
      state: "requested",
      initiator: "them",
      createdAt: Date.now(),
    };

    this.sessions.set(transactionId, session);
    this.logVerboseMessage(
      `matrix: verification: request from ${sender} (device ${content.from_device}), txn=${transactionId}, inRoom=${String(inRoom)}`,
    );

    // Send m.key.verification.ready
    const readyContent: VerificationReadyContent = {
      from_device: this.selfDeviceId!,
      methods: [SAS_METHOD],
    };

    if (inRoom) {
      readyContent["m.relates_to"] = buildRelation(session);
    } else {
      readyContent.transaction_id = transactionId;
    }

    await this.sendVerificationEvent(session, VerificationEventType.Ready, readyContent);
    session.state = "ready";
    this.logVerboseMessage(`matrix: verification: sent ready for txn=${transactionId}`);
  }

  /**
   * Handle m.key.verification.ready (when we initiated, or after our ready was sent)
   * The initiator should send m.key.verification.start after both sides are ready.
   */
  private async handleReady(event: VerificationRawEvent, transactionId: string): Promise<void> {
    const session = this.sessions.get(transactionId);
    if (!session) {
      this.logVerboseMessage(
        `matrix: verification: ready for unknown txn=${transactionId}, ignoring`,
      );
      return;
    }

    const content = event.content as unknown as VerificationReadyContent;
    const methods = content.methods ?? [];
    if (!methods.includes(SAS_METHOD)) {
      this.logVerboseMessage(
        `matrix: verification: ready from ${event.sender} does not support ${SAS_METHOD}`,
      );
      await this.cancelSession(session, CancelCode.UnknownMethod, "No supported method");
      return;
    }

    session.state = "ready";
    session.remoteDeviceId = content.from_device;

    // If both sides are ready and we are the one with the lexicographically smaller user ID,
    // we should send start. If equal user ID, compare device IDs.
    const shouldWeStart = this.shouldInitiateStart(session);
    if (shouldWeStart) {
      await this.sendStart(session);
    }
  }

  /**
   * Handle m.key.verification.start
   * Compute commitment and send m.key.verification.accept
   */
  private async handleStart(event: VerificationRawEvent, transactionId: string): Promise<void> {
    const session = this.sessions.get(transactionId);
    if (!session) {
      this.logVerboseMessage(
        `matrix: verification: start for unknown txn=${transactionId}, ignoring`,
      );
      return;
    }

    const content = event.content as unknown as VerificationStartContent;
    if (content.method !== SAS_METHOD) {
      await this.cancelSession(
        session,
        CancelCode.UnknownMethod,
        `Unsupported method: ${content.method}`,
      );
      return;
    }

    // Check key agreement
    if (!content.key_agreement_protocols?.includes(KEY_AGREEMENT)) {
      await this.cancelSession(
        session,
        CancelCode.UnknownMethod,
        "No supported key agreement protocol",
      );
      return;
    }

    // Check MAC methods (prefer v2, accept v1)
    const macMethod = content.message_authentication_codes?.includes(MAC_METHOD_V2)
      ? MAC_METHOD_V2
      : content.message_authentication_codes?.includes(MAC_METHOD_V1)
        ? MAC_METHOD_V1
        : undefined;

    if (!macMethod) {
      await this.cancelSession(session, CancelCode.UnknownMethod, "No supported MAC method");
      return;
    }

    // Check SAS types
    const hasEmoji = content.short_authentication_string?.includes("emoji");
    const hasDecimal = content.short_authentication_string?.includes("decimal");
    if (!hasEmoji && !hasDecimal) {
      await this.cancelSession(session, CancelCode.UnknownMethod, "No supported SAS type");
      return;
    }

    // Store the canonical start content for commitment verification
    session.startContent = content;
    session.macMethod = macMethod;
    session.state = "started";

    // Generate our key pair
    const keyPair = generateX25519KeyPair();
    session.keyPair = keyPair;
    session.ourPublicKeyBase64 = encodeUnpaddedBase64(keyPair.publicKey);

    // Compute commitment = SHA256(our_pubkey_base64 || canonical_json(start_content))
    const commitment = computeCommitment(session.ourPublicKeyBase64, content);
    session.commitment = commitment;

    // Send accept
    const acceptContent: VerificationAcceptContent = {
      method: SAS_METHOD,
      key_agreement_protocol: KEY_AGREEMENT,
      hash: HASH_METHOD,
      message_authentication_code: macMethod,
      short_authentication_string: hasEmoji ? SAS_TYPES : ["decimal"],
      commitment,
    };

    if (session.inRoom) {
      acceptContent["m.relates_to"] = buildRelation(session);
    } else {
      acceptContent.transaction_id = transactionId;
    }

    await this.sendVerificationEvent(session, VerificationEventType.Accept, acceptContent);
    session.state = "accepted";
    this.logVerboseMessage(
      `matrix: verification: sent accept for txn=${transactionId}, mac=${macMethod}`,
    );
  }

  /**
   * Handle m.key.verification.accept (when we sent start)
   * Verify their commitment hash and send our key.
   */
  private async handleAccept(event: VerificationRawEvent, transactionId: string): Promise<void> {
    const session = this.sessions.get(transactionId);
    if (!session) {
      return;
    }

    const content = event.content as unknown as VerificationAcceptContent;
    session.commitment = content.commitment;
    session.macMethod = content.message_authentication_code;
    session.state = "accepted";

    // If we initiated, generate key pair and send our key
    if (session.initiator === "us") {
      if (!session.keyPair) {
        const keyPair = generateX25519KeyPair();
        session.keyPair = keyPair;
        session.ourPublicKeyBase64 = encodeUnpaddedBase64(keyPair.publicKey);
      }
      await this.sendKey(session);
    }
  }

  /**
   * Handle m.key.verification.key
   * Send our key (if not already sent), compute shared SAS, display emojis
   */
  private async handleKey(event: VerificationRawEvent, transactionId: string): Promise<void> {
    const session = this.sessions.get(transactionId);
    if (!session) {
      this.logVerboseMessage(
        `matrix: verification: key for unknown txn=${transactionId}, ignoring`,
      );
      return;
    }

    const content = event.content as unknown as VerificationKeyContent;
    session.theirPublicKeyBase64 = content.key;

    // If we are the accepter and haven't sent our key yet, send it now
    if (session.initiator === "them" && session.state === "accepted") {
      await this.sendKey(session);
    }

    // If we are the initiator and received their key, verify commitment
    if (session.initiator === "us" && session.commitment) {
      const expectedCommitment = computeCommitment(content.key, session.startContent!);
      if (expectedCommitment !== session.commitment) {
        this.logVerboseMessage(
          `matrix: verification: commitment mismatch for txn=${transactionId}`,
        );
        await this.cancelSession(session, CancelCode.MismatchedCommitment, "Commitment mismatch");
        return;
      }
    }

    session.state = "key_exchanged";

    // Compute shared secret via ECDH
    if (!session.keyPair || !session.theirPublicKeyBase64) {
      await this.cancelSession(session, CancelCode.UnexpectedMessage, "Missing key material");
      return;
    }

    const theirPublicKey = decodeUnpaddedBase64(session.theirPublicKeyBase64);
    session.sharedSecret = computeSharedSecret(session.keyPair.privateKey, theirPublicKey);

    // Determine sender/receiver based on who sent the start event
    const startSender = session.initiator === "them" ? session.remoteUserId : session.selfUserId;
    const startSenderDevice =
      session.initiator === "them" ? session.remoteDeviceId : session.selfDeviceId;
    const startSenderKey =
      session.initiator === "them" ? session.theirPublicKeyBase64 : session.ourPublicKeyBase64!;

    const startReceiver = session.initiator === "them" ? session.selfUserId : session.remoteUserId;
    const startReceiverDevice =
      session.initiator === "them" ? session.selfDeviceId : session.remoteDeviceId;
    const startReceiverKey =
      session.initiator === "them" ? session.ourPublicKeyBase64! : session.theirPublicKeyBase64;

    const sasInfoString = buildSasInfoString({
      senderUserId: startSender,
      senderDeviceId: startSenderDevice,
      senderKey: startSenderKey,
      receiverUserId: startReceiver,
      receiverDeviceId: startReceiverDevice,
      receiverKey: startReceiverKey,
      transactionId,
    });

    // Derive 6 bytes for emoji SAS
    session.sasBytes = deriveSasBytes(session.sharedSecret, sasInfoString, 6);

    // Compute and display emojis
    const emojis = computeSasEmojis(session.sasBytes);
    const emojiDisplay = formatSasEmojis(emojis);
    const emojiOnly = emojis.map((e) => e.emoji).join(" ");
    session.state = "sas_shown";

    this.logVerboseMessage(
      `matrix: verification: SAS emojis for txn=${transactionId}: ${emojiDisplay}`,
    );

    // Send emojis as a message to the room (if in-room) for user comparison
    if (session.inRoom && session.roomId) {
      try {
        await this.client.sendMessage(session.roomId, {
          msgtype: "m.text",
          body: `Verification emojis: ${emojiOnly}\n${emojiDisplay}\nPlease confirm these match on your device.`,
        });
      } catch (err) {
        this.logVerboseMessage(
          `matrix: verification: failed to send emoji message: ${String(err)}`,
        );
      }
    }

    // Auto-confirm after a short delay (the bot trusts the SAS since it computed them correctly)
    setTimeout(() => {
      void this.sendMac(session).catch((err) => {
        this.logVerboseMessage(
          `matrix: verification: auto-confirm MAC send failed: ${String(err)}`,
        );
      });
    }, AUTO_CONFIRM_DELAY_MS);
  }

  /**
   * Handle m.key.verification.mac
   * Verify their MAC, then send done.
   */
  private async handleMac(event: VerificationRawEvent, transactionId: string): Promise<void> {
    const session = this.sessions.get(transactionId);
    if (!session) {
      return;
    }

    const content = event.content as unknown as VerificationMacContent;
    session.state = "mac_received";

    // Verify their MAC
    if (!session.sharedSecret || !session.macMethod) {
      await this.cancelSession(session, CancelCode.UnexpectedMessage, "Missing shared secret");
      return;
    }

    // The MAC sender is the remote user
    const macInfoBase = buildMacInfoString({
      senderUserId: session.remoteUserId,
      senderDeviceId: session.remoteDeviceId,
      senderKey: session.theirPublicKeyBase64!,
      receiverUserId: session.selfUserId,
      receiverDeviceId: session.selfDeviceId,
      receiverKey: session.ourPublicKeyBase64!,
      transactionId,
    });

    // Verify the "keys" MAC (MAC of the comma-separated key list)
    const keyList = Object.keys(content.mac).sort().join(",");
    const expectedKeysMac = computeMac(
      session.macMethod,
      session.sharedSecret,
      macInfoBase + "KEY_IDS",
      keyList,
    );

    if (expectedKeysMac !== content.keys) {
      this.logVerboseMessage(`matrix: verification: keys MAC mismatch for txn=${transactionId}`);
      await this.cancelSession(session, CancelCode.KeyMismatch, "Keys MAC mismatch");
      return;
    }

    this.logVerboseMessage(`matrix: verification: MAC verified for txn=${transactionId}`);

    // If we haven't sent our MAC yet, send it now
    if ((session.state as string) !== "mac_sent") {
      await this.sendMac(session);
    }

    // Send done
    await this.sendDone(session);
  }

  /**
   * Handle m.key.verification.done
   */
  private handleDone(transactionId: string): void {
    const session = this.sessions.get(transactionId);
    if (!session) {
      return;
    }

    session.state = "done";
    this.logVerboseMessage(
      `matrix: verification: completed for txn=${transactionId} with ${session.remoteUserId}`,
    );
    this.sessions.delete(transactionId);
  }

  /**
   * Handle m.key.verification.cancel
   */
  private handleCancel(event: VerificationRawEvent, transactionId: string): void {
    const content = event.content as unknown as VerificationCancelContent;
    const session = this.sessions.get(transactionId);
    if (session) {
      session.state = "cancelled";
      this.sessions.delete(transactionId);
    }
    this.logVerboseMessage(
      `matrix: verification: cancelled txn=${transactionId} code=${content.code} reason=${content.reason}`,
    );
  }

  // -------------------------------------------------------------------------
  // Outgoing message helpers
  // -------------------------------------------------------------------------

  /**
   * Send a m.key.verification.start event (when we initiate).
   */
  private async sendStart(session: SasSession): Promise<void> {
    // Generate key pair
    const keyPair = generateX25519KeyPair();
    session.keyPair = keyPair;
    session.ourPublicKeyBase64 = encodeUnpaddedBase64(keyPair.publicKey);
    session.initiator = "us";

    const startContent: VerificationStartContent = {
      from_device: session.selfDeviceId,
      method: SAS_METHOD,
      key_agreement_protocols: [KEY_AGREEMENT],
      hashes: [HASH_METHOD],
      message_authentication_codes: [MAC_METHOD_V2, MAC_METHOD_V1],
      short_authentication_string: SAS_TYPES,
    };

    if (session.inRoom) {
      startContent["m.relates_to"] = buildRelation(session);
    } else {
      startContent.transaction_id = session.transactionId;
    }

    session.startContent = startContent;
    await this.sendVerificationEvent(session, VerificationEventType.Start, startContent);
    session.state = "started";
    this.logVerboseMessage(`matrix: verification: sent start for txn=${session.transactionId}`);
  }

  /**
   * Send our public key.
   */
  private async sendKey(session: SasSession): Promise<void> {
    if (!session.ourPublicKeyBase64) {
      return;
    }

    const keyContent: VerificationKeyContent = {
      key: session.ourPublicKeyBase64,
    };

    if (session.inRoom) {
      keyContent["m.relates_to"] = buildRelation(session);
    } else {
      keyContent.transaction_id = session.transactionId;
    }

    await this.sendVerificationEvent(session, VerificationEventType.Key, keyContent);
    this.logVerboseMessage(`matrix: verification: sent key for txn=${session.transactionId}`);
  }

  /**
   * Compute and send our MAC.
   */
  private async sendMac(session: SasSession): Promise<void> {
    if (!session.sharedSecret || !session.macMethod || !session.ourPublicKeyBase64) {
      return;
    }

    // Prevent double-send
    if (session.state === "mac_sent" || session.state === "done") {
      return;
    }

    const macInfoBase = buildMacInfoString({
      senderUserId: session.selfUserId,
      senderDeviceId: session.selfDeviceId,
      senderKey: session.ourPublicKeyBase64,
      receiverUserId: session.remoteUserId,
      receiverDeviceId: session.remoteDeviceId,
      receiverKey: session.theirPublicKeyBase64!,
      transactionId: session.transactionId,
    });

    // Compute MAC for our ed25519 key
    // The key ID format is "ed25519:<device_id>"
    const keyId = `ed25519:${session.selfDeviceId}`;

    // Get our ed25519 signing key from the crypto module
    let signingKeyBase64 = "";
    try {
      // CryptoClient exposes clientDeviceEd25519 as a getter
      const crypto = this.client.crypto as unknown as
        | {
            clientDeviceEd25519?: string;
          }
        | undefined;
      if (crypto?.clientDeviceEd25519) {
        signingKeyBase64 = crypto.clientDeviceEd25519;
      }
    } catch {
      // If we can't get the signing key, use an empty placeholder
      // The remote side may still accept based on device trust
    }

    const macMap: Record<string, string> = {};
    if (signingKeyBase64) {
      macMap[keyId] = computeMac(
        session.macMethod,
        session.sharedSecret,
        macInfoBase + keyId,
        signingKeyBase64,
      );
    }

    const keyList = Object.keys(macMap).sort().join(",");
    const keysMac = computeMac(
      session.macMethod,
      session.sharedSecret,
      macInfoBase + "KEY_IDS",
      keyList,
    );

    const macContent: VerificationMacContent = {
      mac: macMap,
      keys: keysMac,
    };

    if (session.inRoom) {
      macContent["m.relates_to"] = buildRelation(session);
    } else {
      macContent.transaction_id = session.transactionId;
    }

    await this.sendVerificationEvent(session, VerificationEventType.Mac, macContent);
    session.state = "mac_sent";
    this.logVerboseMessage(`matrix: verification: sent MAC for txn=${session.transactionId}`);
  }

  /**
   * Send m.key.verification.done.
   */
  private async sendDone(session: SasSession): Promise<void> {
    const doneContent: Record<string, unknown> = {};

    if (session.inRoom) {
      doneContent["m.relates_to"] = buildRelation(session);
    } else {
      doneContent.transaction_id = session.transactionId;
    }

    await this.sendVerificationEvent(session, VerificationEventType.Done, doneContent);
    session.state = "done";
    this.logVerboseMessage(
      `matrix: verification: sent done for txn=${session.transactionId}, verified ${session.remoteUserId}`,
    );
    this.sessions.delete(session.transactionId);
  }

  /**
   * Cancel a session with a reason.
   */
  private async cancelSession(session: SasSession, code: string, reason: string): Promise<void> {
    const cancelContent: VerificationCancelContent = {
      code,
      reason,
    };

    if (session.inRoom) {
      cancelContent["m.relates_to"] = buildRelation(session);
    } else {
      cancelContent.transaction_id = session.transactionId;
    }

    try {
      await this.sendVerificationEvent(session, VerificationEventType.Cancel, cancelContent);
    } catch (err) {
      this.logVerboseMessage(`matrix: verification: failed to send cancel: ${String(err)}`);
    }

    session.state = "cancelled";
    this.sessions.delete(session.transactionId);
    this.logVerboseMessage(
      `matrix: verification: cancelled txn=${session.transactionId} code=${code} reason=${reason}`,
    );
  }

  // -------------------------------------------------------------------------
  // Transport helpers
  // -------------------------------------------------------------------------

  /**
   * Send a verification event via the appropriate transport (room or to-device).
   */
  private async sendVerificationEvent(
    session: SasSession,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    if (session.inRoom && session.roomId) {
      await this.client.sendEvent(session.roomId, eventType, content);
    } else {
      await this.client.sendToDevices(eventType, {
        [session.remoteUserId]: {
          [session.remoteDeviceId]: content,
        },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /**
   * Resolve the transaction ID from an event.
   * - For to-device events: content.transaction_id
   * - For in-room events: the event_id of the original request (from m.relates_to)
   *   or the event_id itself if this is the request
   */
  private resolveTransactionId(event: VerificationRawEvent, roomId?: string): string | undefined {
    const content = event.content as Record<string, unknown>;

    // To-device: use transaction_id from content
    const txnId = content.transaction_id;
    if (typeof txnId === "string" && txnId) {
      return txnId;
    }

    // In-room: use m.relates_to.event_id (reference to request event)
    const relatesTo = content["m.relates_to"] as { event_id?: string } | undefined;
    if (relatesTo?.event_id) {
      return relatesTo.event_id;
    }

    // If this is the request event itself (in-room), use the event_id as transaction ID
    const eventType = event.type;
    const isRequest =
      eventType === VerificationEventType.Request ||
      (eventType === "m.room.message" &&
        (content as { msgtype?: string }).msgtype === VerificationEventType.Request);
    if (isRequest && event.event_id && roomId) {
      return event.event_id;
    }

    return undefined;
  }

  /**
   * Determine if we should initiate the start event.
   * The user with the lexicographically smaller user ID starts.
   * If user IDs are equal, compare device IDs.
   */
  private shouldInitiateStart(session: SasSession): boolean {
    if (session.selfUserId < session.remoteUserId) {
      return true;
    }
    if (session.selfUserId === session.remoteUserId) {
      return session.selfDeviceId < session.remoteDeviceId;
    }
    return false;
  }

  /**
   * Clean up expired sessions.
   */
  private cleanExpiredSessions(): void {
    const now = Date.now();
    for (const [txnId, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TIMEOUT_MS) {
        this.logVerboseMessage(`matrix: verification: session expired txn=${txnId}`);
        this.sessions.delete(txnId);
      }
    }
  }

  /**
   * Get the number of active sessions (for testing/monitoring).
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve device ID from the client
// ---------------------------------------------------------------------------

async function resolveDeviceId(client: MatrixClient): Promise<string> {
  // Try to get device ID from the crypto module
  // CryptoClient exposes clientDeviceId as a getter
  const crypto = client.crypto as unknown as
    | {
        clientDeviceId?: string;
      }
    | undefined;

  if (crypto?.clientDeviceId) {
    return crypto.clientDeviceId;
  }

  // Fallback: get device ID from whoami
  try {
    const whoami = await (
      client as unknown as {
        doRequest: (method: string, path: string) => Promise<Record<string, unknown>>;
      }
    ).doRequest("GET", "/_matrix/client/v3/account/whoami");
    if (typeof whoami.device_id === "string") {
      return whoami.device_id;
    }
  } catch {
    // Ignore
  }

  throw new Error("Cannot determine device ID");
}
