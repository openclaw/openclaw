import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { WorkboardCard } from "../types.ts";

type RequestHandler = (method: string, params: unknown) => unknown;
type RequestResponses = Record<string, unknown> | RequestHandler;

export type WorkboardTestClient = GatewayBrowserClient & {
  request: ReturnType<typeof vi.fn<RequestHandler>>;
};

export function createWorkboardTestClient(responses: RequestResponses): WorkboardTestClient {
  const request = vi.fn(async (method: string, params: unknown) =>
    typeof responses === "function" ? responses(method, params) : responses[method],
  );
  return { request } as unknown as WorkboardTestClient;
}

export function createWorkboardCard(overrides: Partial<WorkboardCard> = {}): WorkboardCard {
  const title = overrides.title ?? "Build board";
  return {
    id: "card-1",
    title,
    status: "todo",
    priority: "normal",
    labels: [],
    position: 1000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function createWorkboardExecution(
  overrides: Partial<NonNullable<WorkboardCard["execution"]>> = {},
): NonNullable<WorkboardCard["execution"]> {
  return {
    id: "exec-1",
    kind: "agent-session",
    engine: "codex",
    mode: "autonomous",
    status: "running",
    model: "openai/gpt-5.5",
    sessionKey: "agent:main:dashboard:1",
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function createGatewaySession(
  overrides: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key: "agent:main:dashboard:1",
    kind: "direct",
    updatedAt: Date.now(),
    displayName: "Dashboard session",
    hasActiveRun: true,
    status: "running",
    ...overrides,
  };
}
