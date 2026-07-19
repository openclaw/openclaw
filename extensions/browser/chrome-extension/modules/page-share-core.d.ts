export const PAGE_SHARE_MAX_CONTENT_CHARS: 120000;
export const PAGE_SHARE_MAX_NOTE_CHARS: 2000;
export const PAGE_SHARE_MAX_TITLE_CHARS: 500;
export const PAGE_SHARE_MAX_URL_CHARS: 2000;

export type PageSharePayload = {
  url: string;
  title: string;
  content: string;
  selection?: string;
  note?: string;
};

export type PageCapture = {
  url: string;
  title: string;
  selection: string;
  content: string;
};

export function googleDocIdFromUrl(url: unknown): string | null;
export function truncateShareText(text: unknown, maxChars: number): string;
export function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<boolean>;
export function buildPageSharePayload(params: {
  url: string;
  title: string;
  content: string;
  selection?: string;
  note?: string;
}): PageSharePayload;
export function capturePageContent(): PageCapture;
export function fetchGoogleDocExportInTab(
  docId: string,
): Promise<{ text: string; error?: never } | { error: string; text?: never }>;
