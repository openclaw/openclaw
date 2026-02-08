/**
 * Authorization Forwarder
 *
 * Sends external-access authorization requests to the operator via messaging
 * channels (WhatsApp, Signal, Discord, etc.) and listens for responses.
 *
 * This module uses dependency injection for the messaging layer — the actual
 * send/receive is provided by the integration layer in the main app.
 */

import type {
  ConductorAuthConfig,
  ConductorAuthorization,
  ConductorDecision,
  ConductorForwarder,
  ConductorInjection,
  ExternalAccessRequest,
} from "./types.js";

type AuthorizationCallback = (auth: ConductorAuthorization) => void;

type PendingRequest = {
  request: ExternalAccessRequest;
  timer: ReturnType<typeof setTimeout>;
};

export function createConductorForwarder(deps: {
  config: ConductorAuthConfig;
  sendMessage: (params: {
    channel: string;
    to: string;
    message: string;
    accountId?: string;
    threadId?: string | number;
  }) => Promise<void>;
  onInboundMessage?: (
    callback: (msg: { channel: string; from: string; text: string }) => void,
  ) => () => void;
}): ConductorForwarder {
  const { config } = deps;
  const pending = new Map<string, PendingRequest>();
  const callbacks = new Set<AuthorizationCallback>();
  let inboundCleanup: (() => void) | null = null;

  // Listen for inbound messages that resolve pending requests
  if (deps.onInboundMessage) {
    inboundCleanup = deps.onInboundMessage((msg) => {
      const text = msg.text.trim().toLowerCase();
      // Try to match a response to a pending request
      for (const [requestId, entry] of pending.entries()) {
        // Simple matching: "yes", "approve", "deny", "no" + optional request ID
        const matchesId = text.includes(requestId.slice(0, 8));
        const isApproval =
          text === "yes" ||
          text === "approve" ||
          text === "go" ||
          text === "y" ||
          text.startsWith("yes ");
        const isDenial = text === "no" || text === "deny" || text === "n" || text.startsWith("no ");
        const hasInstructions = text.startsWith("yes ") || text.startsWith("approve ");

        if (matchesId || (pending.size === 1 && (isApproval || isDenial))) {
          let decision: ConductorDecision = "deny";
          let instructions: string | undefined;

          if (isApproval || (matchesId && !isDenial)) {
            decision = hasInstructions ? "approve-with-instructions" : "approve";
            if (hasInstructions) {
              instructions = text.replace(/^(?:yes|approve)\s+/i, "").trim();
            }
          }

          const auth: ConductorAuthorization = {
            requestId,
            decision,
            instructions,
            resolvedBy: `${msg.channel}:${msg.from}`,
            resolvedAtMs: Date.now(),
          };

          clearTimeout(entry.timer);
          pending.delete(requestId);
          for (const cb of callbacks) {
            cb(auth);
          }
          break;
        }
      }
    });
  }

  return {
    async requestAuthorization(request: ExternalAccessRequest): Promise<void> {
      const targets = config.targets ?? [];
      if (targets.length === 0) {
        return;
      }

      const message = formatAuthorizationRequest(request);

      // Send to all configured targets
      const sends = targets.map((target) =>
        deps
          .sendMessage({
            channel: target.channel,
            to: target.to,
            message,
            accountId: target.accountId,
            threadId: target.threadId,
          })
          .catch((err) => {
            // Log but don't throw — best-effort delivery
            console.error(
              `[conductor] Failed to forward to ${target.channel}:${target.to}: ${err}`,
            );
          }),
      );

      await Promise.allSettled(sends);

      // Track as pending with timeout
      const timeoutMs = config.timeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        if (pending.has(request.id)) {
          pending.delete(request.id);
          const auth: ConductorAuthorization = {
            requestId: request.id,
            decision: "deny",
            resolvedBy: "timeout",
            resolvedAtMs: Date.now(),
          };
          for (const cb of callbacks) {
            cb(auth);
          }
        }
      }, timeoutMs);

      pending.set(request.id, { request, timer });
    },

    async notifyResult(
      request: ExternalAccessRequest,
      injection: ConductorInjection,
    ): Promise<void> {
      const targets = config.targets ?? [];
      if (targets.length === 0) {
        return;
      }

      const message = formatResultNotification(request, injection);

      const sends = targets.map((target) =>
        deps
          .sendMessage({
            channel: target.channel,
            to: target.to,
            message,
            accountId: target.accountId,
            threadId: target.threadId,
          })
          .catch(() => {
            // best-effort
          }),
      );

      await Promise.allSettled(sends);
    },

    onAuthorization(callback: (auth: ConductorAuthorization) => void): () => void {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },

    stop(): void {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
      }
      pending.clear();
      callbacks.clear();
      if (inboundCleanup) {
        inboundCleanup();
        inboundCleanup = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function formatAuthorizationRequest(request: ExternalAccessRequest): string {
  const shortId = request.id.slice(0, 8);
  const expiresIn = Math.round((request.expiresAtMs - Date.now()) / 1000);
  const lines = [
    `AETHER CONDUCTOR — Authorization Request [${shortId}]`,
    "",
    `Claude needs external access:`,
    `  Kind: ${request.kind}`,
    `  Summary: ${request.summary}`,
  ];
  if (request.url) {
    lines.push(`  URL: ${request.url}`);
  }
  if (request.service) {
    lines.push(`  Service: ${request.service}`);
  }
  if (request.dataNeeded) {
    lines.push(`  Data needed: ${request.dataNeeded}`);
  }
  lines.push("");
  lines.push(`Reply "YES" to approve, "NO" to deny.`);
  lines.push(`Reply "YES <instructions>" to approve with extra guidance.`);
  lines.push(`Expires in ${expiresIn}s.`);
  return lines.join("\n");
}

function formatResultNotification(
  request: ExternalAccessRequest,
  injection: ConductorInjection,
): string {
  const shortId = request.id.slice(0, 8);
  const status = injection.success ? "SUCCESS" : "FAILED";
  const lines = [
    `AETHER CONDUCTOR — Result [${shortId}] ${status}`,
    "",
    `Request: ${request.summary}`,
    `Data injected into Claude: ${injection.payload.length > 200 ? `${injection.payload.slice(0, 200)}...` : injection.payload}`,
  ];
  return lines.join("\n");
}
