/** Shared fixture for the Scribes tab tests: a fake page host whose Gateway answers from a world. */
import { vi } from "vitest";
import type { Page } from "./page-context.js";
import { scribeSetup } from "./scribes-catalog.js";
import { scribes } from "./scribes-view.js";

type Call = [string, Record<string, unknown> | undefined];
export const reviewJob = {
  id: "job-review",
  declarationKey: "knowledge:scribe:claim-consolidation",
  enabled: true,
  configRevision: "rev-7",
  sessionTarget: "session:s-review",
  schedule: { kind: "cron", expr: "45 3 * * 0" },
  failureAlert: { after: 2 },
  state: { lastRunStatus: "ok", lastRunAtMs: 1_793_000_000_000, nextRunAtMs: 1_793_090_000_000 },
};

let gateways = 0;
// A fake page host: Gateway reads answer from `world`; writes are recorded.
export function fixture(world: {
  sessions?: Record<
    string,
    { key: string; sessionId?: string; displayName: string; archived?: boolean; status?: string }
  >;
  jobs?: unknown[];
  history?: Record<string, unknown[]>;
  runs?: unknown[];
  canWrite?: boolean;
  /** plugins.inspect answer for the Granola plugin; absent reads as not installed. */
  granola?: { installed: boolean; enabled: boolean; authorized?: boolean };
}) {
  // HTMLDialogElement is incomplete in jsdom.
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
    },
  });
  const calls: Call[] = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push([method, params]);
    switch (method) {
      case "cron.list":
        return { jobs: world.jobs ?? [], hasMore: false, nextOffset: null };
      case "sessions.list": {
        if (typeof params?.search === "string") {
          const row = world.sessions?.[params.search];
          return { sessions: row ? [row] : [] };
        }
        return { sessions: [], count: 1, totalCount: params?.archived ? 1204 : 148 };
      }
      case "sessions.describe":
        return {
          session:
            Object.values(world.sessions ?? {}).find((row) => row.key === params?.key) ?? null,
        };
      case "chat.history":
        return {
          messages:
            typeof params?.sessionKey === "string"
              ? (world.history?.[params.sessionKey] ?? [])
              : [],
        };
      case "cron.runs":
        return {
          entries: world.runs ?? [
            {
              ts: 1_793_000_000_000,
              status: "ok",
              summary: "Filed claims.\nScribe status: on — 9 filed · 2 pages created",
              model: "anthropic/claude",
            },
          ],
        };
      case "agents.files.list":
        return { files: [{ name: "MEMORY.md", missing: false, size: 8192 }] };
      case "cron.run":
        return { ok: true, enqueued: true, runId: "run-1" };
      case "plugins.inspect": {
        const plugin = world.granola ?? { installed: false, enabled: false };
        return {
          plugin,
          ...(plugin.installed && plugin.enabled
            ? {
                mcpAuth: [
                  {
                    serverName: "granola",
                    state: plugin.authorized ? "authorized" : "requires-authorization",
                  },
                ],
              }
            : {}),
        };
      }
      default:
        return { ok: true };
    }
  });
  const create = vi.fn(async () => "agent:main:dock:new");
  const open = vi.fn();
  const connection = { connected: true, canRead: true, canWrite: world.canWrite ?? true };
  // Gateway events the page listens to, by name.
  const events = new Map<string, () => void>();
  const onEvent = vi.fn((name: string, listener: () => void) => {
    events.set(name, listener);
    return () => events.delete(name);
  });
  // Update state is kept per Gateway, by base path: each fixture is its own Gateway.
  const basePath = `/gateway-${++gateways}`;
  const host = { request, connection, sessions: { create, open }, basePath, onEvent };
  const load = vi.fn(async () => true);
  const scribesTab = document.createElement("button");
  const ui = {
    s: { context: { host }, scribe: "", storesSnapshot: undefined, tab: "scribes" },
    live: () => true,
    viewedAgent: () => "main",
    displayName: (id: string) => (id === "main" ? "Main" : id),
    announce: vi.fn(),
    errorText: (error: unknown) => String(error),
    load,
    scribesTab,
  } as unknown as Page;
  const page = document.createElement("section");
  page.className = "knowledge-page";
  document.body.append(page);
  const render = async () => {
    const target = document.createElement("div");
    await scribes(ui, 1, target);
    page.replaceChildren(target);
    return target;
  };
  return { ui, calls, request, create, open, load, render, page, scribesTab, events };
}
export const reviewSetup = scribeSetup(
  "claim-consolidation",
  "ongoing",
  { schedule: "45 3 * * 0" },
  "America/Los_Angeles",
);
export const reviewSession = {
  "Scribe · Knowledge Consolidation": {
    key: "s-review",
    displayName: "Scribe · Knowledge Consolidation",
  },
};
export const buttonNamed = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text)!;
export const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
