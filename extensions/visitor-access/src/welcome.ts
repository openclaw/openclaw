import { randomUUID } from "node:crypto";
import {
  listAgentIds,
  resolveAgentConfig,
  tryResolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-scope-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginLogger, PluginRuntime } from "../api.js";
import { VisitorAccessError } from "./errors.js";
import type { ActiveVisitorInvitation, VisitorOnboarding } from "./grant-record.js";
import { resolveVisitorRole } from "./roles.js";
import type { VisitorAccessService } from "./visitors.js";

export const WELCOME_ENSURE_METHOD = "visitor-access.welcome.ensure";
const RETRY_AFTER_MS = 1_000;

/** Pinned response contract shared with the Control UI. */
export type WelcomeEnsureResult =
  | { status: "not_applicable" }
  | { status: "pending"; retryAfterMs: number }
  | { status: "ready"; sessionKey: string; agentId: string; created: boolean }
  | { status: "failed"; retryable: true; message: string };

type WelcomeGateway = Pick<PluginRuntime["gateway"], "request" | "appendAgentMessage">;
type WelcomeClient = GatewayRequestHandlerOptions["client"];
type GuestProfile = NonNullable<NonNullable<WelcomeClient>["authenticatedUserProfile"]>;

/**
 * Sets up each guest invitation's welcome session once. The pull caller selects nothing:
 * the invitation comes from the grant the Gateway admitted for this connection.
 */
export class VisitorWelcome {
  // One setup per grant in this Gateway; the durable reservation covers restarts.
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly service: VisitorAccessService,
    private readonly gateway: WelcomeGateway,
    private readonly config: () => OpenClawConfig,
    private readonly logger: Pick<PluginLogger, "warn">,
  ) {}

  async ensure(client: WelcomeClient): Promise<WelcomeEnsureResult> {
    const grant = client?.internal?.operatorAccessAuthority?.gatewayAccessGrant;
    const guest = client?.authenticatedUserProfile;
    if (grant?.pluginId !== "visitor-access" || !guest) {
      return { status: "not_applicable" };
    }
    let invitation: ActiveVisitorInvitation | undefined;
    try {
      invitation = this.service.findActiveInvitation(grant.grantId);
      const recorded = invitation?.onboarding;
      if (recorded?.state === "ready" && recorded.welcomeSessionKey) {
        return await this.readyWelcome(recorded.welcomeSessionKey);
      }
    } catch (error) {
      return failed(error);
    }
    if (!invitation) {
      return { status: "not_applicable" };
    }
    if (this.inFlight.has(invitation.grantId)) {
      return { status: "pending", retryAfterMs: RETRY_AFTER_MS };
    }
    this.inFlight.add(invitation.grantId);
    try {
      return await this.setUp(invitation, guest);
    } finally {
      this.inFlight.delete(invitation.grantId);
    }
  }

  /**
   * A welcome session deleted after setup stays deleted: the record keeps its key so setup
   * never recreates it, and the guest is not sent to a session that no longer exists.
   * Before ready, retries deliberately resume the reserved key, even for a removed partial session.
   */
  private async readyWelcome(sessionKey: string): Promise<WelcomeEnsureResult> {
    const agentId = agentFromKey(sessionKey);
    // The guest role holds only session scopes; ask for the session read it implies.
    const { session } = await this.gateway.request<{ session: unknown }>(
      "sessions.describe",
      { key: sessionKey, agentId },
      { scopes: ["operator.sessions.read"] },
    );
    return session
      ? { status: "ready", sessionKey, agentId, created: false }
      : { status: "not_applicable" };
  }

  private async setUp(
    invitation: ActiveVisitorInvitation,
    guest: GuestProfile,
  ): Promise<WelcomeEnsureResult> {
    const { grantId, onboarding: recorded } = invitation;
    const advance = (
      from: VisitorOnboarding | undefined,
      next: Omit<VisitorOnboarding, "updatedAt">,
    ) =>
      this.service.compareAndSetOnboarding({
        grantId,
        expected: from ? { state: from.state, updatedAt: from.updatedAt } : null,
        next,
      });
    let reservation: VisitorOnboarding | undefined;
    try {
      const config = this.config();
      // A key reserved before a crash or failure keeps its agent; otherwise choose now.
      const reservedKey = recorded?.welcomeSessionKey;
      const agentId = reservedKey ? agentFromKey(reservedKey) : chooseGuestAgent(config);
      const sessionKey = reservedKey ?? `agent:${agentId}:dashboard:${randomUUID()}`;
      const reserved = await advance(recorded, { state: "pending", welcomeSessionKey: sessionKey });
      if (!reserved.applied) {
        return reserved.reason === "inactive"
          ? { status: "not_applicable" }
          : { status: "pending", retryAfterMs: RETRY_AFTER_MS };
      }
      reservation = reserved.onboarding;
      const name = guest.displayName?.replace(/\s+/gu, " ").trim() || undefined;
      // Create as the guest: the caller-bound request makes the guest the session owner.
      // A retry adopts the reserved key, so it never creates a second session.
      await this.gateway.request("sessions.create", {
        key: sessionKey,
        agentId,
        displayName: name ? `Welcome, ${name}` : "Welcome",
      });
      const message = welcomeMessage({
        invitation,
        config,
        agentId,
        guestName: name,
        guestProfileId: guest.profileId,
      });
      // The idempotency key replays the same agent message and Inbox entry on retry.
      await this.gateway.appendAgentMessage({
        sessionKey,
        agentId,
        text: message.text,
        ...(message.mentions.length ? { mentions: message.mentions } : {}),
        idempotencyKey: `visitor-welcome:${grantId}`,
      });
      const done = await advance(reservation, { state: "ready", welcomeSessionKey: sessionKey });
      if (done.applied) {
        return { status: "ready", sessionKey, agentId, created: true };
      }
      // Revoked or expired during setup: the grant record is gone, so a re-invite starts over.
      return done.reason === "inactive"
        ? { status: "not_applicable" }
        : { status: "pending", retryAfterMs: RETRY_AFTER_MS };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`visitor-access: welcome setup failed: ${detail}`);
      if (reservation) {
        // Keep the reserved key so the next call resumes against the same session.
        const recordedFailure = await advance(reservation, {
          state: "failed",
          welcomeSessionKey: reservation.welcomeSessionKey,
          error: detail,
        }).catch(() => undefined);
        // Access ending mid-setup refuses the Gateway writes; there is nothing left to retry.
        if (recordedFailure && !recordedFailure.applied && recordedFailure.reason === "inactive") {
          return { status: "not_applicable" };
        }
      }
      return failed(error);
    }
  }
}

function failed(error: unknown): WelcomeEnsureResult {
  // Visitor errors are written for people; anything else may carry internal detail.
  const message =
    error instanceof VisitorAccessError
      ? error.message
      : "Your welcome session could not be set up yet. Reload to try again.";
  return { status: "failed", retryable: true, message };
}

function agentFromKey(sessionKey: string): string {
  const agentId = /^agent:([^:]+):/u.exec(sessionKey)?.[1];
  if (!agentId) {
    throw new VisitorAccessError("The reserved welcome session key is invalid.");
  }
  return agentId;
}

function guestRole(config: OpenClawConfig) {
  const roles = config.gateway?.roles;
  const role = roles?.definitions[resolveVisitorRole(config)];
  if (!role) {
    throw new VisitorAccessError("The guest role is not configured.");
  }
  return role;
}

/** The default agent when the guest role permits it, otherwise the role's first agent. */
function chooseGuestAgent(config: OpenClawConfig): string {
  const { agents } = guestRole(config);
  const permitted = agents === "*" ? listAgentIds(config) : agents;
  const preferred = tryResolveDefaultAgentId(config);
  const agentId = preferred && permitted.includes(preferred) ? preferred : permitted[0];
  if (!agentId) {
    throw new VisitorAccessError("No agent is available to guests. Ask a maintainer to add one.");
  }
  return agentId;
}

function agentName(config: OpenClawConfig, agentId: string): string {
  const agent = resolveAgentConfig(config, agentId);
  return agent?.identity?.name?.trim() || agent?.name?.trim() || agentId;
}

function utcMinute(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Guest capabilities stated from the live guest role, never from fixed claims. */
function guestCapabilities(config: OpenClawConfig, agentId: string): string[] {
  const role = guestRole(config);
  const agents = role.agents === "*" ? undefined : role.agents.map((id) => agentName(config, id));
  const lines = [
    agents
      ? `start your own sessions with ${agents.join(" or ")}`
      : "start your own sessions with any agent on this Gateway",
  ];
  if (role.sandbox === "required") {
    lines.push(`have ${agentName(config, agentId)} work in a private sandbox`);
  }
  if (role.sessions.others === "view") {
    lines.push("read other people's sessions");
  } else if (role.sessions.others === "write") {
    lines.push("read and reply in other people's sessions");
  }
  return lines;
}

/** Plain, short welcome text; the inviter is a structured mention when recorded. */
function welcomeMessage({
  invitation,
  config,
  agentId,
  guestName,
  guestProfileId,
}: {
  invitation: ActiveVisitorInvitation;
  config: OpenClawConfig;
  agentId: string;
  guestName?: string;
  guestProfileId: string;
}): { text: string; mentions: Array<{ profileId: string; start: number; end: number }> } {
  // Legacy grants have no inviter; nobody can mention themselves.
  const inviter =
    invitation.invitedBy?.profileId === guestProfileId ? undefined : invitation.invitedBy;
  const label = inviter?.label?.replace(/\s+/gu, " ").trim() || undefined;
  const greeting = guestName ? `Welcome to OpenClaw, ${guestName}.` : "Welcome to OpenClaw.";
  const access =
    invitation.expiresAt === null
      ? "Your guest access does not expire."
      : `Your guest access runs through ${utcMinute(invitation.expiresAt)}.`;
  const mentionText = `@${label ?? "inviter"}`;
  const invited = inviter
    ? `${mentionText} invited you. ${access}`
    : `You were invited as a guest. ${access}`;
  const note = invitation.note?.trim();
  const capabilities = guestCapabilities(config, agentId).map((line) => `- ${line}`);
  const text = [
    greeting,
    "",
    invited,
    ...(note ? ["", `Note from ${label ?? "your inviter"}:`, note] : []),
    "",
    `This is your own session with ${agentName(config, agentId)}. As a guest you can:`,
    ...capabilities,
  ].join("\n");
  const start = greeting.length + 2;
  return {
    text,
    mentions: inviter
      ? [{ profileId: inviter.profileId, start, end: start + mentionText.length }]
      : [],
  };
}
