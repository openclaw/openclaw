// Completes partial gateway fixtures into the full MESSAGE_CREATE shape the stale
// policy validates, so a test's verdict comes from its policy inputs and not from
// a missing field. A key the fixture sets, even to undefined or a malformed value,
// is kept as given, so malformed-row tests stay malformed.
import { MessageType } from "discord-api-types/v10";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withDefaults(
  value: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const completed = { ...value };
  for (const [key, fallback] of Object.entries(defaults)) {
    if (!(key in completed)) {
      completed[key] = fallback;
    }
  }
  return completed;
}

/** A gateway user; the username defaults to the id, as the preflight test builder does. */
export function gatewayUser(value: unknown): unknown {
  if (!isPlainRecord(value)) {
    return value;
  }
  return withDefaults(value, {
    username: typeof value.id === "string" ? value.id : "user",
    discriminator: "0",
    global_name: null,
    avatar: null,
  });
}

function gatewayAttachment(value: unknown): unknown {
  if (!isPlainRecord(value)) {
    return value;
  }
  const url = typeof value.url === "string" ? value.url : "https://cdn.example/file.bin";
  return withDefaults(value, { size: 1, url, proxy_url: url });
}

/** A stored MESSAGE_CREATE frame with every field APIMessage requires. */
export function completeGatewayFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const completed = withDefaults(frame, {
    edited_timestamp: null,
    tts: false,
    pinned: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    type: MessageType.Default,
  });
  if ("author" in completed) {
    completed.author = gatewayUser(completed.author);
  }
  if (Array.isArray(completed.mentions)) {
    completed.mentions = completed.mentions.map(gatewayUser);
  }
  if (Array.isArray(completed.attachments)) {
    completed.attachments = completed.attachments.map(gatewayAttachment);
  }
  if (isPlainRecord(completed.referenced_message)) {
    completed.referenced_message = completeGatewayFrame(completed.referenced_message);
  }
  return completed;
}
