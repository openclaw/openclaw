import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import postgres from "postgres";
import {
  createPgClient,
  ensureUserSchema,
  findUserByChannelPeer,
  findUserByExternalId,
  createUser,
  linkChannelToUser,
  linkExternalId,
  updateUserName,
  listUserChannels,
  type ResolvedIdentity,
} from "./db.js";
import {
  verifyToken,
  verifyViaPasscode,
  lookupUserByName,
  type AuthConfig,
  type UserLookupResult,
} from "./jwt.js";

// ---------------------------------------------------------------------------
// Session key parsing — reuses persist-postgres convention
// ---------------------------------------------------------------------------

function deriveChannel(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts[2];
  }
  return "unknown";
}

/**
 * Extract the peer-specific portion of a session key.
 *
 * Session key formats:
 *   agent:{agentId}:direct:{peerId}
 *   agent:{agentId}:{channel}:direct:{peerId}
 *   agent:{agentId}:{channel}:{peerId...}
 *   agent:{agentId}:main  (shared — no peer)
 */
function derivePeerId(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts.length < 3 || parts[0] !== "agent") {
    return sessionKey;
  }
  const rest = parts.slice(2);
  const directIdx = rest.indexOf("direct");
  if (directIdx >= 0 && directIdx < rest.length - 1) {
    return rest.slice(directIdx + 1).join(":");
  }
  if (rest.length >= 2) {
    return rest.slice(1).join(":");
  }
  return rest[0] ?? sessionKey;
}

// ---------------------------------------------------------------------------
// Identity context formatting — the contract downstream plugins read
// ---------------------------------------------------------------------------

/**
 * Format the identity block injected into prependContext.
 *
 * DOWNSTREAM CONTRACT: Other plugins (memory-gate, graphiti, etc.) can parse
 * this block from the system prompt to extract the canonical user_id.
 *
 * Format:
 *   [USER_IDENTITY]
 *   user_id: <uuid>
 *   external_id: <string|none>
 *   name: <first last>
 *   channel: <channel>
 *   channel_peer_id: <id>
 *   verified: <true|false>
 *   status: <verified|registered|new_session>
 *   [/USER_IDENTITY]
 */
function formatIdentityContext(
  identity: ResolvedIdentity,
  status: "verified" | "registered" | "new_session",
): string {
  const name =
    identity.first_name || identity.last_name
      ? `${identity.first_name ?? ""} ${identity.last_name ?? ""}`.trim()
      : "unknown";
  return [
    "[USER_IDENTITY]",
    `user_id: ${identity.id}`,
    `external_id: ${identity.external_id ?? "none"}`,
    `name: ${name}`,
    `channel: ${identity.channel}`,
    `channel_peer_id: ${identity.channel_peer_id}`,
    `verified: ${identity.verified}`,
    `status: ${status}`,
    "[/USER_IDENTITY]",
  ].join("\n");
}

function formatUnknownUserContext(channel: string, peerId: string): string {
  return [
    "[USER_IDENTITY]",
    "user_id: none",
    "external_id: none",
    "name: unknown",
    `channel: ${channel}`,
    `channel_peer_id: ${peerId}`,
    "verified: false",
    "status: unregistered",
    "gate_eligible: true",
    "[/USER_IDENTITY]",
    "",
    "This user is not registered. Ask for their first and last name.",
    "They can type: !identify <first_name> <last_name> to find their account,",
    "then verify with a 6-digit passcode from the Syntropy Journals app.",
    "Alternatively: !register <first_name> <last_name> for a basic account.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const persistUserIdentityPlugin = {
  id: "persist-user-identity",
  name: "User Identity (PostgreSQL)",
  description:
    "Cross-channel user identity persistence with optional token verification. " +
    "Extends persist-postgres with lp_users and lp_user_channels tables.",

  register(api: OpenClawPluginApi) {
    const databaseUrl =
      (api.pluginConfig?.databaseUrl as string | undefined) ?? process.env.DATABASE_URL ?? "";
    if (!databaseUrl) {
      api.logger.warn("persist-user-identity: no databaseUrl or DATABASE_URL env, plugin disabled");
      return;
    }

    const authConfig = api.pluginConfig?.auth as AuthConfig | undefined;

    // Track pending !identify results so !verify can use the email as user_identifier
    const pendingIdentify = new Map<string, { email: string; userId: string; expiresAt: number }>();

    api.logger.info("persist-user-identity: connecting to PostgreSQL");
    const sql = createPgClient(databaseUrl);
    let schemaReady = false;
    let initError: unknown = null;

    async function ensureReady() {
      if (schemaReady) {
        return;
      }
      if (initError) {
        throw initError;
      }
      try {
        await sql`SELECT 1`;
        await ensureUserSchema(sql);
        schemaReady = true;
        api.logger.info("persist-user-identity: schema ready");
      } catch (err) {
        initError = err;
        api.logger.error(`persist-user-identity: init failed: ${err}`);
        throw err;
      }
    }

    // -------------------------------------------------------------------
    // Hook: before_agent_start — resolve identity and inject context
    // Priority 60 — runs before persist-postgres (50) so that downstream
    // hooks can access the identity context.
    // -------------------------------------------------------------------

    api.on(
      "before_agent_start",
      async (_event, ctx) => {
        try {
          await ensureReady();
          const sessionKey = ctx?.sessionKey ?? "";
          const channel = ctx?.messageProvider ?? deriveChannel(sessionKey);
          const peerId = derivePeerId(sessionKey);

          if (!peerId || peerId === "main" || peerId === "unknown") {
            return {};
          }

          const identity = await findUserByChannelPeer(sql, channel, peerId);
          if (identity) {
            return { prependContext: formatIdentityContext(identity, "new_session") };
          }

          return { prependContext: formatUnknownUserContext(channel, peerId) };
        } catch (err) {
          api.logger.error(`persist-user-identity: before_agent_start error: ${err}`);
          return {};
        }
      },
      { priority: 60 },
    );

    // -------------------------------------------------------------------
    // Command: /verify <token>
    // Validates an external auth token (JWT or endpoint) and links the
    // current channel identity to the verified user.
    // -------------------------------------------------------------------

    api.registerCommand({
      name: "verify",
      description: "Verify your identity with an authorization token from the app",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const token = ctx.args?.trim();
        if (!token) {
          return { text: "Usage: !verify <token_or_passcode>" };
        }
        if (!authConfig) {
          return {
            text: "Token verification is not configured on this agent. Please contact the administrator.",
          };
        }

        try {
          await ensureReady();
        } catch {
          return { text: "Identity service is temporarily unavailable." };
        }

        const channel = ctx.channel ?? "unknown";
        const peerId = ctx.senderId ?? ctx.from ?? "unknown";
        const peerKey = `${channel}:${peerId}`;

        // Passcode path: 6-digit numeric code in passcode-endpoint mode
        const isPasscode = /^\d{4,10}$/.test(token);
        let verified: Awaited<ReturnType<typeof verifyToken>> = null;

        if (authConfig.mode === "passcode-endpoint" && isPasscode) {
          // Use email from prior !identify if available
          const pending = pendingIdentify.get(peerKey);
          if (pending && pending.expiresAt > Date.now()) {
            verified = await verifyViaPasscode(token, pending.email, authConfig);
          } else {
            verified = await verifyViaPasscode(token, undefined, authConfig);
          }
          if (verified) {
            pendingIdentify.delete(peerKey);
          }
        } else {
          verified = await verifyToken(token, authConfig);
        }

        if (!verified) {
          if (isPasscode) {
            return {
              text: "Invalid or expired passcode. Please generate a new 6-digit code from the Syntropy Journals app (Settings → Pair Device) and try again.",
            };
          }
          return { text: "Token verification failed. Please check your token and try again." };
        }

        // Check if this channel identity is already linked to a user
        const existingLink = await findUserByChannelPeer(sql, channel, peerId);
        if (existingLink?.external_id === verified.externalId) {
          return {
            text: `You're already verified as ${existingLink.first_name ?? ""} ${existingLink.last_name ?? ""}. No changes made.`.trim(),
          };
        }

        // Find or create the verified user
        let user = await findUserByExternalId(sql, verified.externalId);
        if (!user) {
          user = await createUser(sql, {
            externalId: verified.externalId,
            firstName: verified.firstName,
            lastName: verified.lastName,
          });
        }

        // Link this channel identity to the user
        await linkChannelToUser(sql, user.id, channel, peerId);

        // If existing unverified user was linked here, merge
        if (existingLink && !existingLink.external_id) {
          await linkExternalId(sql, existingLink.id, verified.externalId, channel, peerId);
        }

        const channels = await listUserChannels(sql, user.id);
        const channelList = channels.map((c) => `${c.channel}:${c.channel_peer_id}`).join(", ");
        const name =
          `${user.first_name ?? verified.firstName ?? ""} ${user.last_name ?? verified.lastName ?? ""}`.trim();

        api.logger.info(
          `persist-user-identity: verified ${channel}:${peerId} → user ${user.id} (${verified.externalId})`,
        );

        return {
          text:
            `Identity verified! Welcome${name ? `, ${name}` : ""}.\n` +
            `Your user ID: ${user.id}\n` +
            `Linked channels: ${channelList}`,
        };
      },
    });

    // -------------------------------------------------------------------
    // Command: /identify <first_name> <last_name>
    // Fuzzy name lookup via Syntropy Journals API, then prompts for passcode.
    // -------------------------------------------------------------------

    api.registerCommand({
      name: "identify",
      description: "Find your account by name, then verify with a 6-digit passcode",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const name = ctx.args?.trim();
        if (!name) {
          return {
            text:
              "Please tell me your first and last name as registered in the Syntropy Journals app.\n" +
              "Usage: !identify <first_name> <last_name>",
          };
        }
        if (!authConfig || authConfig.mode !== "passcode-endpoint") {
          return { text: "Name-based identification is not configured on this agent." };
        }

        try {
          await ensureReady();
        } catch {
          return { text: "Identity service is temporarily unavailable." };
        }

        const channel = ctx.channel ?? "unknown";
        const peerId = ctx.senderId ?? ctx.from ?? "unknown";
        const peerKey = `${channel}:${peerId}`;

        const results = await lookupUserByName(name, authConfig);

        if (results.length === 0) {
          return {
            text:
              "I couldn't find that name in our system. Please use the exact first and last name " +
              "registered in your Syntropy Journals account.\n\n" +
              "Note: Make sure to use the same name you registered with " +
              '(e.g., if you registered as "Mohamed", use that instead of "Mo").',
          };
        }

        // Store the first match for the upcoming !verify passcode call
        const match = results[0] as UserLookupResult;
        pendingIdentify.set(peerKey, {
          email: match.email,
          userId: match.userId,
          expiresAt: Date.now() + 15 * 60_000,
        });

        if (results.length === 1) {
          return {
            text:
              `I found your account, ${match.firstName}! ` +
              "Please open the Syntropy Journals app → Settings → Pair Device, " +
              "and enter the 6-digit code here.\n\n" +
              "Type: !verify <6-digit-code>",
          };
        }

        const list = results.map((r, i) => `${i + 1}. ${r.firstName} ${r.lastName}`).join("\n");
        return {
          text:
            `I found a few possible matches:\n${list}\n\n` +
            "Please open the Syntropy Journals app → Settings → Pair Device, " +
            "and enter the 6-digit code here to confirm your identity.\n\n" +
            "Type: !verify <6-digit-code>",
        };
      },
    });

    // -------------------------------------------------------------------
    // Command: /register <first_name> <last_name>
    // Creates a channel-only (unverified) user identity. The user can
    // later upgrade to verified via /verify.
    // -------------------------------------------------------------------

    api.registerCommand({
      name: "register",
      description: "Register your name (optional — creates a channel-only identity)",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const args = ctx.args?.trim();
        if (!args) {
          return { text: "Usage: !register <first_name> <last_name>" };
        }

        const parts = args.split(/\s+/);
        const firstName = parts[0] ?? "";
        const lastName = parts.slice(1).join(" ") || "";

        if (!firstName) {
          return {
            text: "Please provide at least a first name: !register <first_name> <last_name>",
          };
        }

        try {
          await ensureReady();
        } catch {
          return { text: "Identity service is temporarily unavailable." };
        }

        const channel = ctx.channel ?? "unknown";
        const peerId = ctx.senderId ?? ctx.from ?? "unknown";

        // Check if already registered
        const existing = await findUserByChannelPeer(sql, channel, peerId);
        if (existing) {
          // Update name on existing user
          await updateUserName(sql, existing.id, firstName, lastName);
          return {
            text:
              `Updated your name to ${firstName} ${lastName}.` +
              (existing.external_id
                ? ""
                : "\nTip: Use !verify <token> to link your app account for cross-channel access."),
          };
        }

        // Create new user with channel-only identity
        const user = await createUser(sql, { firstName, lastName });
        await linkChannelToUser(sql, user.id, channel, peerId);

        api.logger.info(
          `persist-user-identity: registered ${channel}:${peerId} → user ${user.id} (channel-only)`,
        );

        return {
          text:
            `Registered as ${firstName} ${lastName}.\n` +
            `Your user ID: ${user.id}\n` +
            "Tip: Use !verify <token> to link your app account for cross-channel access.",
        };
      },
    });

    // -------------------------------------------------------------------
    // Command: /whoami — show current identity status
    // -------------------------------------------------------------------

    api.registerCommand({
      name: "whoami",
      description: "Show your current identity and linked channels",
      acceptsArgs: false,
      requireAuth: false,
      handler: async (ctx) => {
        try {
          await ensureReady();
        } catch {
          return { text: "Identity service is temporarily unavailable." };
        }

        const channel = ctx.channel ?? "unknown";
        const peerId = ctx.senderId ?? ctx.from ?? "unknown";
        const identity = await findUserByChannelPeer(sql, channel, peerId);

        if (!identity) {
          return {
            text:
              `You are not registered.\n` +
              `Current channel: ${channel}\n` +
              `Channel ID: ${peerId}\n\n` +
              "Use !register <first_name> <last_name> or !verify <token> to set up your identity.",
          };
        }

        const channels = await listUserChannels(sql, identity.id);
        const channelList = channels
          .map((c) => `  - ${c.channel}: ${c.channel_peer_id}`)
          .join("\n");
        const name = `${identity.first_name ?? ""} ${identity.last_name ?? ""}`.trim();

        return {
          text:
            `User ID: ${identity.id}\n` +
            (name ? `Name: ${name}\n` : "") +
            `Verified: ${identity.verified ? "yes" : "no"}\n` +
            (identity.external_id ? `External ID: ${identity.external_id}\n` : "") +
            `Linked channels:\n${channelList}`,
        };
      },
    });

    // -------------------------------------------------------------------
    // Shutdown: close DB pool
    // -------------------------------------------------------------------

    api.on(
      "gateway_stop",
      async () => {
        try {
          await sql.end({ timeout: 5 });
          api.logger.info("persist-user-identity: database connections closed");
        } catch (err) {
          api.logger.error(`persist-user-identity: error closing connections: ${err}`);
        }
      },
      { priority: 90 },
    );
  },
};

export default persistUserIdentityPlugin;
