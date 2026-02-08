import type { ResolvedCampfireAccount } from "./accounts.js";

/**
 * Send a text message to a Campfire room.
 *
 * Campfire's bot API expects:
 * - POST to /rooms/{room_id}/{bot_key}/messages
 * - Body: plain text (Content-Type: text/plain or text/html)
 * - Response: 201 Created with Location header
 *
 * For text replies, the response body is returned as a message.
 */
export async function sendCampfireMessage(params: {
  account: ResolvedCampfireAccount;
  roomPath: string;
  text: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { account, roomPath, text } = params;

  if (!account.baseUrl) {
    return { ok: false, error: "Campfire baseUrl not configured" };
  }
  if (!account.botKey) {
    return { ok: false, error: "Campfire botKey not configured" };
  }

  const url = new URL(roomPath, account.baseUrl);

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: text,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Campfire API ${res.status}: ${errorText || res.statusText}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Send an attachment to a Campfire room.
 *
 * Campfire's bot API expects:
 * - POST to /rooms/{room_id}/{bot_key}/messages
 * - Body: multipart/form-data with "attachment" field
 * - Response: 201 Created
 */
export async function sendCampfireAttachment(params: {
  account: ResolvedCampfireAccount;
  roomPath: string;
  buffer: Buffer;
  filename: string;
  contentType?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { account, roomPath, buffer, filename, contentType } = params;

  if (!account.baseUrl) {
    return { ok: false, error: "Campfire baseUrl not configured" };
  }
  if (!account.botKey) {
    return { ok: false, error: "Campfire botKey not configured" };
  }

  const url = new URL(roomPath, account.baseUrl);

  try {
    // Build multipart form data manually
    const boundary = `openclaw-campfire-${Date.now()}`;
    const mimeType = contentType ?? "application/octet-stream";

    const header = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="attachment"; filename="${filename}"`,
      `Content-Type: ${mimeType}`,
      "",
      "",
    ].join("\r\n");

    const footer = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([Buffer.from(header, "utf8"), buffer, Buffer.from(footer, "utf8")]);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Campfire API ${res.status}: ${errorText || res.statusText}`,
      };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe Campfire connectivity by attempting to access the base URL.
 *
 * Note: Campfire doesn't have a public health endpoint, so we just check
 * if the base URL is reachable.
 */
export async function probeCampfire(account: ResolvedCampfireAccount): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  if (!account.baseUrl) {
    return { ok: false, error: "Campfire baseUrl not configured" };
  }

  try {
    const res = await fetch(account.baseUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });

    // Any response (including redirects to login) indicates the server is reachable
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build the room messages path from webhook payload.
 */
export function buildRoomMessagesPath(roomId: number, botKey: string): string {
  return `/rooms/${roomId}/${botKey}/messages`;
}
