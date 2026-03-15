import type { ResolvedCampfireAccount } from "./accounts.js";

/**
 * Send a text message to a Campfire room.
 *
 * Campfire's bot API expects:
 * - POST to /rooms/{room_id}/{bot_key}/messages
 * - Body: message text (Campfire reads the raw body as UTF-8)
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
    const res = await fetch(url, {
      method: "POST",
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
    const mimeType = contentType ?? "application/octet-stream";
    const sanitizedFilename = filename.replace(/[\r\n"]/g, "_");
    const form = new FormData();
    form.append(
      "attachment",
      new Blob([buffer as BlobPart], { type: mimeType }),
      sanitizedFilename,
    );

    const res = await fetch(url, {
      method: "POST",
      body: form,
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
