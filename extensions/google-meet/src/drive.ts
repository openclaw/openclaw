import { readProviderTextResponse } from "openclaw/plugin-sdk/provider-http";
import { requestGoogleApi } from "./google-api.js";

const GOOGLE_DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_API_HOST = "www.googleapis.com";
const GOOGLE_DRIVE_MEET_SCOPE = "https://www.googleapis.com/auth/drive.meet.readonly";
const TEXT_PLAIN_MIME = "text/plain";

export function extractGoogleDriveDocumentId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return URL.parse(trimmed)?.pathname.match(/\/document\/d\/([^/]+)/)?.[1];
  }
  const segments = trimmed.split("/").filter(Boolean);
  return segments.at(-1);
}

export async function exportGoogleDriveDocumentText(params: {
  accessToken: string;
  documentId: string;
}): Promise<string> {
  return requestGoogleApi(
    {
      url: `${GOOGLE_DRIVE_API_BASE_URL}/files/${encodeURIComponent(params.documentId)}/export`,
      query: { mimeType: TEXT_PLAIN_MIME },
      accessToken: params.accessToken,
      allowedHostname: GOOGLE_DRIVE_API_HOST,
      auditContext: "google-meet.drive.files.export",
      prefix: "Google Drive files.export",
      scopes: [GOOGLE_DRIVE_MEET_SCOPE],
      accept: TEXT_PLAIN_MIME,
    },
    (response) => readProviderTextResponse(response, "Google Drive files.export"),
  );
}
