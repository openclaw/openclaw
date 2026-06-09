// WhatsApp Group Management Plugin
// Accesses the Baileys socket via the WhatsApp plugin's global connection controller registry.

import { readFile } from "node:fs/promises";

const REGISTRY_KEY = Symbol.for("openclaw.whatsapp.connectionControllerRegistry");

function getWhatsAppSocket(accountId = "default") {
  const registry = globalThis[REGISTRY_KEY];
  if (!registry) {
    throw new Error("WhatsApp connection registry not found. Is the WhatsApp plugin loaded?");
  }
  const controller = registry.controllers.get(accountId);
  if (!controller) {
    throw new Error(
      `No WhatsApp connection controller for account "${accountId}". Available: [${[...registry.controllers.keys()].join(", ")}]`
    );
  }
  // getSocket() was added to the controller class
  const sock = typeof controller.getSocket === "function" ? controller.getSocket() : null;
  if (!sock) {
    throw new Error(
      `WhatsApp socket not connected for account "${accountId}". Is WhatsApp linked and online?`
    );
  }
  return sock;
}

async function fetchImageBuffer(pictureUrl) {
  if (!pictureUrl) return null;
  // Local file path
  if (
    pictureUrl.startsWith("/") ||
    pictureUrl.startsWith("./") ||
    pictureUrl.startsWith("../") ||
    pictureUrl.startsWith("file://")
  ) {
    const filePath = pictureUrl.startsWith("file://")
      ? pictureUrl.slice("file://".length)
      : pictureUrl;
    return readFile(filePath);
  }
  // URL
  const response = await fetch(pictureUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch picture: HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function toJid(phone) {
  // Convert E.164 to WhatsApp JID if needed
  if (phone.includes("@")) return phone;
  const digits = phone.replace(/[^0-9]/g, "");
  return `${digits}@s.whatsapp.net`;
}

async function handleCreate(args) {
  const sock = getWhatsAppSocket(args.accountId);
  const name = args.name;
  if (!name) throw new Error("name is required for create action");
  const participants = (args.participants ?? []).map(toJid);
  if (participants.length === 0) throw new Error("participants[] is required for create action");

  // Create the group
  const meta = await sock.groupCreate(name, participants);
  const groupJid = meta.id;

  // Set picture if provided
  if (args.pictureUrl) {
    try {
      const imgBuffer = await fetchImageBuffer(args.pictureUrl);
      if (imgBuffer) {
        await sock.updateProfilePicture(groupJid, imgBuffer);
      }
    } catch (err) {
      // Don't fail the whole create if picture fails
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              groupJid,
              name: meta.subject ?? name,
              pictureError: String(err?.message ?? err),
            }),
          },
        ],
      };
    }
  }

  // Set announcement mode if requested (only admins can send)
  if (args.announcement) {
    try {
      await sock.groupSettingUpdate(groupJid, "announcement");
    } catch (err) {
      // Non-fatal
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          groupJid,
          name: meta.subject ?? name,
        }),
      },
    ],
  };
}

async function handleUpdate(args) {
  const sock = getWhatsAppSocket(args.accountId);
  const groupJid = args.groupJid;
  if (!groupJid) throw new Error("groupJid is required for update action");

  const results = {};

  if (args.name) {
    await sock.groupUpdateSubject(groupJid, args.name);
    results.name = args.name;
  }

  if (args.description !== undefined) {
    await sock.groupUpdateDescription(groupJid, args.description || undefined);
    results.description = true;
  }

  if (args.pictureUrl) {
    const imgBuffer = await fetchImageBuffer(args.pictureUrl);
    if (imgBuffer) {
      await sock.updateProfilePicture(groupJid, imgBuffer);
      results.picture = true;
    }
  }

  if (args.announcement !== undefined) {
    await sock.groupSettingUpdate(
      groupJid,
      args.announcement ? "announcement" : "not_announcement"
    );
    results.announcement = args.announcement;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true, ...results }),
      },
    ],
  };
}

async function handleInfo(args) {
  const sock = getWhatsAppSocket(args.accountId);
  const groupJid = args.groupJid;
  if (!groupJid) throw new Error("groupJid is required for info action");

  const meta = await sock.groupMetadata(groupJid);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          groupJid: meta.id,
          name: meta.subject,
          description: meta.desc ?? null,
          announce: meta.announce ?? false,
          participants: (meta.participants ?? []).map((p) => ({
            id: p.id,
            admin: p.admin ?? null,
          })),
          size: meta.size ?? meta.participants?.length ?? 0,
          creation: meta.creation,
          owner: meta.owner ?? null,
        }),
      },
    ],
  };
}

async function handleLeave(args) {
  const sock = getWhatsAppSocket(args.accountId);
  const groupJid = args.groupJid;
  if (!groupJid) throw new Error("groupJid is required for leave action");

  await sock.groupLeave(groupJid);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true, groupJid }),
      },
    ],
  };
}

async function handleSend(args) {
  const sock = getWhatsAppSocket(args.accountId);
  const groupJid = args.groupJid;
  if (!groupJid) throw new Error("groupJid is required for send action");
  const text = args.text;
  if (!text) throw new Error("text is required for send action");

  const result = await sock.sendMessage(groupJid, { text });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: true, groupJid, messageId: result?.key?.id }),
      },
    ],
  };
}

export default {
  id: "whatsapp-group",
  name: "WhatsApp Group Management",
  description: "Create and manage WhatsApp groups via the live Baileys socket",
  register(api) {
    api.registerTool({
      name: "whatsapp_group",
      description:
        'Create or manage WhatsApp groups. Actions: "create" (new group with participants and optional picture), ' +
        '"update" (change name, description, picture, or announcement mode), ' +
        '"info" (get group metadata and participants), ' +
        '"leave" (leave a group), ' +
        '"send" (send a text message to a group). ' +
        "For pictureUrl, pass a local file path or HTTP URL to an image (JPEG/PNG).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "update", "info", "leave", "send"],
            description: "The group management action to perform",
          },
          text: {
            type: "string",
            description: "Message text (required for send action)",
          },
          accountId: {
            type: "string",
            description: "WhatsApp account ID (default: 'default')",
          },
          name: {
            type: "string",
            description: "Group name (required for create, optional for update)",
          },
          participants: {
            type: "array",
            items: { type: "string" },
            description: "E.164 phone numbers to add as participants (required for create)",
          },
          groupJid: {
            type: "string",
            description: "Group JID (required for update/info/leave)",
          },
          description: {
            type: "string",
            description: "Group description (for update)",
          },
          pictureUrl: {
            type: "string",
            description: "URL or local path to group picture image (JPEG/PNG)",
          },
          announcement: {
            type: "boolean",
            description: "If true, only admins can send messages",
          },
        },
        required: ["action"],
      },
      async execute(_toolCallId, args) {
        const parsed = typeof args === "string" ? JSON.parse(args) : args;
        switch (parsed.action) {
          case "create":
            return handleCreate(parsed);
          case "update":
            return handleUpdate(parsed);
          case "info":
            return handleInfo(parsed);
          case "leave":
            return handleLeave(parsed);
          case "send":
            return handleSend(parsed);
          default:
            throw new Error(
              `Unknown action "${parsed.action}". Use: create, update, info, leave, send`
            );
        }
      },
    });
  },
};
