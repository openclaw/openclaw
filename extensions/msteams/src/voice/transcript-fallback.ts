/**
 * Post-meeting transcript fallback for Teams voice.
 *
 * NOT real-time — processes transcripts after meetings end. This is the
 * TS-only fallback when no Windows media worker is available.
 *
 * Three modes:
 *   A) RSC / app-scoped — private-chat meetings where the app is installed.
 *      Permission: OnlineMeetingTranscript.Read.Chat (RSC)
 *   B) Tenant-wide — all meetings + channel meetings.
 *      Permission: OnlineMeetingTranscript.Read.All + application access policy
 *   C) Ad hoc calls — separate resource path.
 *      Permission: CallTranscripts.Read.All (RSC not available)
 *
 * Product rule: if OpenClaw creates meetings programmatically, use the
 * Create event API (calendar-backed), NOT POST /onlineMeetings. Microsoft's
 * transcript APIs don't support meetings created without a calendar event.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/infra-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

const logger = createSubsystemLogger("msteams/voice/transcript");

const logTranscript = (message: string) => {
  logVerbose(`msteams voice/transcript: ${message}`);
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed transcript entry from VTT content. */
export type TranscriptEntry = {
  /** Speaker display name (from VTT WEBVTT cue). */
  speaker: string;
  /** Transcript text. */
  text: string;
  /** Start time in seconds. */
  startTime: number;
  /** End time in seconds. */
  endTime: number;
};

export type TranscriptFallbackMode = "rsc" | "tenant-wide";

export type TranscriptFetchResult = {
  meetingId: string;
  transcriptId: string;
  entries: TranscriptEntry[];
};

// ---------------------------------------------------------------------------
// Graph API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a meeting transcript by meeting and transcript IDs.
 *
 * @param mode - "rsc" uses app-scoped path; "tenant-wide" uses application path.
 * @param organizerId - AAD user ID of the meeting organizer (for /users/ path).
 * @param meetingId - Online meeting ID.
 * @param transcriptId - Transcript resource ID.
 * @param getToken - Function to acquire a Graph API access token.
 */
export async function fetchMeetingTranscript(params: {
  mode: TranscriptFallbackMode;
  organizerId: string;
  meetingId: string;
  transcriptId: string;
  getToken: () => Promise<string>;
}): Promise<TranscriptFetchResult> {
  const { mode, organizerId, meetingId, transcriptId, getToken } = params;

  // Build the Graph API URL
  // For both RSC and tenant-wide, the path is through /users/{userId}/onlineMeetings/
  const url = `https://graph.microsoft.com/v1.0/users/${organizerId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content`;

  const token = await getToken();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/vtt",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Graph transcript fetch failed: ${response.status} ${response.statusText}. ` +
        `Mode: ${mode}. Body: ${body}`,
    );
  }

  const vttContent = await response.text();
  const entries = parseVTT(vttContent);

  logTranscript(
    `fetched transcript: meetingId=${meetingId} entries=${entries.length} mode=${mode}`,
  );

  return { meetingId, transcriptId, entries };
}

/**
 * Fetch an ad hoc call transcript.
 *
 * Ad hoc calls use a different path: /communications/adhocCalls/{callId}/transcripts/
 * RSC is NOT available for ad hoc calls — requires CallTranscripts.Read.All.
 */
export async function fetchAdHocCallTranscript(params: {
  callId: string;
  transcriptId: string;
  getToken: () => Promise<string>;
}): Promise<TranscriptFetchResult> {
  const { callId, transcriptId, getToken } = params;

  const url = `https://graph.microsoft.com/v1.0/communications/adhocCalls/${callId}/transcripts/${transcriptId}/content`;

  const token = await getToken();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/vtt",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Graph ad-hoc transcript fetch failed: ${response.status} ${response.statusText}. Body: ${body}`,
    );
  }

  const vttContent = await response.text();
  const entries = parseVTT(vttContent);

  logTranscript(`fetched ad-hoc transcript: callId=${callId} entries=${entries.length}`);

  return { meetingId: callId, transcriptId, entries };
}

// ---------------------------------------------------------------------------
// Graph change notification subscription
// ---------------------------------------------------------------------------

/**
 * Create a Graph subscription for transcript availability notifications.
 *
 * @param mode - "rsc" for app-scoped; "tenant-wide" for org-wide.
 * @param notificationUrl - HTTPS webhook URL for change notifications.
 * @param getToken - Function to acquire a Graph API access token.
 * @returns The subscription ID.
 */
export async function createTranscriptSubscription(params: {
  mode: TranscriptFallbackMode;
  notificationUrl: string;
  getToken: () => Promise<string>;
  expirationMinutes?: number;
}): Promise<string> {
  const { mode, notificationUrl, getToken, expirationMinutes = 60 } = params;

  const resource =
    mode === "tenant-wide"
      ? "/communications/onlineMeetings/getAllTranscripts"
      : "/communications/onlineMeetings/getAllTranscripts"; // app-scoped uses same resource with app consent

  const expiration = new Date(Date.now() + expirationMinutes * 60_000).toISOString();

  const token = await getToken();
  const response = await fetch("https://graph.microsoft.com/v1.0/subscriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl,
      resource,
      expirationDateTime: expiration,
      clientState: "openclaw-transcript-sub",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Graph subscription creation failed: ${response.status} ${response.statusText}. Body: ${body}`,
    );
  }

  const data = (await response.json()) as { id: string };
  logTranscript(`subscription created: id=${data.id} mode=${mode} expires=${expiration}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// VTT parser
// ---------------------------------------------------------------------------

/**
 * Parse WebVTT content into structured transcript entries.
 *
 * Teams VTT format:
 * ```
 * WEBVTT
 *
 * 00:00:01.000 --> 00:00:05.000
 * <v Speaker Name>Hello everyone, let's get started.</v>
 * ```
 */
export function parseVTT(vttContent: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const lines = vttContent.split("\n");

  let i = 0;
  // Skip WEBVTT header
  while (i < lines.length && !lines[i].includes("-->")) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for timestamp line: "00:00:01.000 --> 00:00:05.000"
    const timestampMatch = line.match(
      /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/,
    );

    if (timestampMatch) {
      const startTime = parseTimestamp(timestampMatch[1]);
      const endTime = parseTimestamp(timestampMatch[2]);

      // Collect text lines until blank line
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        textLines.push(lines[i].trim());
        i++;
      }

      const rawText = textLines.join(" ");

      // Extract speaker from <v Speaker Name>text</v> format
      const voiceMatch = rawText.match(/<v\s+([^>]+)>(.*?)<\/v>/);
      const speaker = voiceMatch ? voiceMatch[1] : "Unknown";
      const text = voiceMatch ? voiceMatch[2] : rawText;

      if (text.trim()) {
        entries.push({
          speaker,
          text: text.trim(),
          startTime,
          endTime,
        });
      }
    }

    i++;
  }

  return entries;
}

/** Parse a VTT timestamp (HH:MM:SS.mmm) to seconds. */
function parseTimestamp(ts: string): number {
  const parts = ts.split(":");
  const hours = Number.parseInt(parts[0], 10);
  const minutes = Number.parseInt(parts[1], 10);
  const seconds = Number.parseFloat(parts[2]);
  return hours * 3600 + minutes * 60 + seconds;
}
