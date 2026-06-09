// Whatsapp plugin module implements agent tools group management behavior.
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { jsonResult } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelAgentTool } from "openclaw/plugin-sdk/channel-contract";
import { Type } from "typebox";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function resolveAccountId(raw: unknown): string {
  return readOptionalString(raw) ?? DEFAULT_ACCOUNT_ID;
}

async function fetchImageBuffer(pictureUrl: string): Promise<Buffer> {
  if (pictureUrl.startsWith("file://")) {
    const filePath = pictureUrl.slice("file://".length);
    return readFile(filePath);
  }
  if (pictureUrl.startsWith("/") || pictureUrl.startsWith("./") || pictureUrl.startsWith("../")) {
    return readFile(pictureUrl);
  }
  // HTTP/HTTPS URL
  const response = await fetch(pictureUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch picture: HTTP ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export function createWhatsAppGroupTool(): ChannelAgentTool {
  return {
    label: "WhatsApp Group",
    name: "whatsapp_group",
    description:
      "Create or manage WhatsApp groups. Supports: create (new group with participants), " +
      "update (change name, description, picture, or announcement mode), " +
      "info (get group metadata), leave (leave a group).",
    parameters: Type.Object({
      action: Type.Unsafe<"create" | "update" | "info" | "leave">({
        type: "string",
        enum: ["create", "update", "info", "leave"],
      }),
      accountId: Type.Optional(Type.String()),
      // create params
      name: Type.Optional(Type.String({ description: "Group name (required for create)" })),
      participants: Type.Optional(
        Type.Array(Type.String(), {
          description: "E.164 phone numbers or JIDs of participants (required for create)",
        }),
      ),
      // update / info / leave params
      groupJid: Type.Optional(
        Type.String({ description: "Group JID (e.g. 1234567890-1234567890@g.us)" }),
      ),
      // update-only params
      description: Type.Optional(Type.String()),
      pictureUrl: Type.Optional(
        Type.String({
          description:
            "URL or local file path for the group profile picture. " +
            "Accepts http/https URLs or absolute/relative filesystem paths.",
        }),
      ),
      announcement: Type.Optional(
        Type.Boolean({
          description: "true = only admins can send messages; false = all members can",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const a = args as Record<string, unknown>;
      const action = String(a.action ?? "");
      const accountId = resolveAccountId(a.accountId);

      const controller = getRegisteredWhatsAppConnectionController(accountId);
      if (!controller) {
        return jsonResult({
          ok: false,
          error: `No WhatsApp connection found for account '${accountId}'. Is the channel connected?`,
        });
      }

      const sock = controller.getSocket();
      if (!sock) {
        return jsonResult({
          ok: false,
          error: `WhatsApp socket is not open for account '${accountId}'. The connection may be starting up or disconnected.`,
        });
      }

      try {
        // ── CREATE ──────────────────────────────────────────────────────────
        if (action === "create") {
          const name = readOptionalString(a.name);
          if (!name) {
            return jsonResult({ ok: false, error: "Missing required parameter: name" });
          }
          const rawParticipants = Array.isArray(a.participants) ? a.participants : [];
          if (rawParticipants.length === 0) {
            return jsonResult({
              ok: false,
              error: "Missing required parameter: participants (must be a non-empty array)",
            });
          }
          // Normalise participants to Baileys JID format (strip + prefix)
          const participants = rawParticipants.map((p: unknown) => {
            const s = String(p).trim().replace(/^\+/, "");
            return s.includes("@") ? s : `${s}@s.whatsapp.net`;
          });

          const meta = await sock.groupCreate(name, participants);
          const groupJid = meta.id;

          if (a.pictureUrl) {
            try {
              const buf = await fetchImageBuffer(String(a.pictureUrl));
              await sock.updateProfilePicture(groupJid, buf);
            } catch (picErr) {
              return jsonResult({
                ok: true,
                groupJid,
                name: meta.subject,
                warning: `Group created but picture update failed: ${String(picErr)}`,
              });
            }
          }

          if (typeof a.announcement === "boolean") {
            await sock.groupSettingUpdate(groupJid, a.announcement ? "announcement" : "not_announcement");
          }

          return jsonResult({ ok: true, groupJid, name: meta.subject });
        }

        // ── UPDATE ──────────────────────────────────────────────────────────
        if (action === "update") {
          const groupJid = readOptionalString(a.groupJid);
          if (!groupJid) {
            return jsonResult({ ok: false, error: "Missing required parameter: groupJid" });
          }

          const updates: string[] = [];
          const errors: string[] = [];

          if (readOptionalString(a.name)) {
            await sock.groupUpdateSubject(groupJid, String(a.name));
            updates.push("name");
          }

          if (typeof a.description === "string") {
            await sock.groupUpdateDescription(groupJid, a.description || undefined);
            updates.push("description");
          }

          if (typeof a.announcement === "boolean") {
            await sock.groupSettingUpdate(groupJid, a.announcement ? "announcement" : "not_announcement");
            updates.push("announcement");
          }

          if (a.pictureUrl) {
            try {
              const buf = await fetchImageBuffer(String(a.pictureUrl));
              await sock.updateProfilePicture(groupJid, buf);
              updates.push("pictureUrl");
            } catch (picErr) {
              errors.push(`pictureUrl: ${String(picErr)}`);
            }
          }

          return jsonResult({ ok: errors.length === 0, updated: updates, errors });
        }

        // ── INFO ────────────────────────────────────────────────────────────
        if (action === "info") {
          const groupJid = readOptionalString(a.groupJid);
          if (!groupJid) {
            return jsonResult({ ok: false, error: "Missing required parameter: groupJid" });
          }

          const meta = await sock.groupMetadata(groupJid);
          return jsonResult({
            groupJid: meta.id,
            name: meta.subject,
            description: meta.desc ?? null,
            announce: meta.announce ?? false,
            creation: meta.creation ?? null,
            owner: meta.owner ?? null,
            participants: meta.participants.map((p) => ({
              jid: p.id,
              isAdmin: p.isAdmin ?? false,
              isSuperAdmin: p.isSuperAdmin ?? false,
            })),
          });
        }

        // ── LEAVE ────────────────────────────────────────────────────────────
        if (action === "leave") {
          const groupJid = readOptionalString(a.groupJid);
          if (!groupJid) {
            return jsonResult({ ok: false, error: "Missing required parameter: groupJid" });
          }
          await sock.groupLeave(groupJid);
          return jsonResult({ ok: true });
        }

        return jsonResult({
          ok: false,
          error: `Unknown action '${action}'. Valid actions: create, update, info, leave`,
        });
      } catch (err) {
        return jsonResult({
          ok: false,
          error: `WhatsApp group operation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  };
}
