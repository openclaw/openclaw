import type { CampfireWebhookPayload } from "../types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseCampfirePayload(value: unknown): CampfireWebhookPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const user = value.user;
  const room = value.room;
  const message = value.message;

  if (!isRecord(user) || !isRecord(room) || !isRecord(message)) {
    return null;
  }

  const body = message.body;
  if (!isRecord(body)) {
    return null;
  }

  if (
    typeof user.id !== "number" ||
    typeof user.name !== "string" ||
    typeof room.id !== "number" ||
    typeof room.name !== "string" ||
    typeof room.path !== "string" ||
    typeof message.id !== "number" ||
    typeof message.path !== "string" ||
    typeof body.plain !== "string"
  ) {
    return null;
  }

  if (body.html !== undefined && typeof body.html !== "string") {
    return null;
  }

  return {
    user: {
      id: user.id,
      name: user.name,
    },
    room: {
      id: room.id,
      name: room.name,
      path: room.path,
    },
    message: {
      id: message.id,
      body: {
        plain: body.plain,
        ...(body.html !== undefined ? { html: body.html } : {}),
      },
      path: message.path,
    },
  };
}
