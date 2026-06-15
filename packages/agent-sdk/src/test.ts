// @openclaw/agent-sdk/test — Test harness for agent package behavior proofs.

import type { AgentPackageManifest } from "./index.js";

export interface MockModelConfig {
  responses: MockResponse[];
}

export interface MockResponse {
  role: "assistant";
  content: MockContent[];
}

export type MockContent =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; input: Record<string, unknown> };

export interface MockToolConfig {
  allow?: boolean;
  result?: unknown;
}

export interface HarnessConfig {
  manifest: string;
  mockModel: MockModelConfig;
  mockTools: Record<string, MockToolConfig>;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  blocked: boolean;
  result?: unknown;
}

export interface HarnessResult {
  toolCalls: ToolCallRecord[];
  blocked: boolean;
  transcript: string[];
}

// ── TODO: Implement in PR 5 ─────────────────────────────────────────
// - Mock model that returns canned responses.
// - Mock tools that record invocations.
// - Real policy path: sandbox, network, secret-scope enforcement.
// - Three required proof tests.
