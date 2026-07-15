// Types for the side panel's pure-logic module (the runtime is plain ESM JS so
// it can load unbundled in Chrome). Kept in sync with panel-core.js.

export function deriveTabSessionKey(
  mainSessionKey: unknown,
  tabId: unknown,
  generation?: number,
): string | null;

/** Cumulative-snapshot render state for one assistant run. */
export type ChatStream = { runId: string | null; full: string; segStart: number };

export function createChatStream(): ChatStream;

export function resetChatStream(stream: ChatStream): void;

export function applyChatDelta(
  stream: ChatStream,
  payload: unknown,
): { segmentText: string; newBubble: boolean } | null;

export function applyToolBoundary(stream: ChatStream): void;

export function renderMarkdownLite(text: unknown): string;

export function friendlyToolName(name: unknown): string;

export function isLoopbackUrl(url: unknown): boolean;

export function gatewayUrlFromRelayUrl(relayUrl: unknown): string | null;

export function buildTabPreamble(url: unknown, title?: unknown): string;
