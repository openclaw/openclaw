import type {
  ControlUiSettingsContext,
  DoctorMemoryStatusPayload,
} from "openclaw/plugin-sdk/control-ui";
import { describe, expect, it, vi } from "vitest";
import { createMemoryOverviewController } from "./controller.ts";
import { deferred, snapshot, type MutableSnapshot } from "./memory.test-support.ts";
function fixture(props = snapshot()) {
  const abort = new AbortController();
  const pending: ReturnType<typeof deferred<DoctorMemoryStatusPayload>>[] = [];
  const request = vi.fn(() => {
    const next = deferred<DoctorMemoryStatusPayload>();
    pending.push(next);
    return next.promise;
  });
  const refreshAgents = vi.fn();
  const context = {
    props,
    signal: abort.signal,
    request,
    refreshAgents,
    formatError: String,
  } as unknown as ControlUiSettingsContext;
  const controller = createMemoryOverviewController(context, vi.fn(), () => "offline");
  return { controller, pending, request, refreshAgents, abort };
}
const payload = (agentId: string): DoctorMemoryStatusPayload => ({
  agentId,
  embedding: { ok: true },
});
async function settle(f: ReturnType<typeof fixture>, index: number, agentId: string) {
  f.pending[index]!.resolve(payload(agentId));
  await Promise.resolve();
}
function expectState(
  f: ReturnType<typeof fixture>,
  status: ReturnType<typeof f.controller.read>["status"],
) {
  const { status: actual, probingEmbeddings } = f.controller.read();
  expect([actual, probingEmbeddings]).toEqual([status, false]);
}

describe("Memory overview request ownership", () => {
  it("deduplicates ordinary reads and probes only on explicit action", async () => {
    const f = fixture();
    const read = f.controller.load();
    await f.controller.load();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenLastCalledWith("doctor.memory.status", { agentId: "main" });
    await settle(f, 0, "main");
    await read;
    f.controller.probe();
    expect(f.request).toHaveBeenLastCalledWith("doctor.memory.status", {
      agentId: "main",
      probe: true,
    });
    expect(f.controller.read().probingEmbeddings).toBe(true);
    await settle(f, 1, "probed");
    expectState(f, { kind: "ready", payload: payload("probed") });
  });
  it.each<[string, Partial<MutableSnapshot>]>([
    ["agent", { agentId: "writer" }],
    ["engine", { engine: { kind: "pinned", id: "custom-memory", availability: "unknown" } }],
    ["epoch", { connectionEpoch: 2 }],
    ["route", { routeIntent: "overview?agent=writer" }],
  ])("retires an old probe when %s authority changes", async (_kind, patch) => {
    const f = fixture();
    f.controller.probe();
    f.controller.update(snapshot(patch));
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.controller.read().probingEmbeddings).toBe(false);
    await settle(f, 0, "stale");
    expectState(f, { kind: "loading" });
    await settle(f, 1, "fresh");
    expectState(f, { kind: "ready", payload: payload("fresh") });
  });
  it.each<[string, Partial<MutableSnapshot>]>([
    ["off", { engine: { kind: "off", id: null, availability: "unknown" } }],
    ["offline", { connected: false }],
    ["no-agent", { agentId: null }],
  ])("clears pending status and probe when %s", async (kind, patch) => {
    const f = fixture();
    f.controller.probe();
    f.controller.update(snapshot(patch));
    expect(f.controller.read().probingEmbeddings).toBe(false);
    expect(f.request).toHaveBeenCalledTimes(1);
    await settle(f, 0, "stale");
    expectState(f, kind === "offline" ? { kind: "error", message: "offline" } : { kind: "idle" });
  });
  it("does not cache a roster error when no agent is selected", async () => {
    const props = snapshot({ agentId: null, agentsError: "roster failed" });
    const f = fixture(props);
    await f.controller.load();
    expect(f.controller.read().status).toEqual({ kind: "idle" });
    f.controller.update({ ...props, agentsError: null, agentsLoading: true });
    expect(f.controller.read().snapshot.agentsError).toBeNull();
    f.controller.update({ ...props, agentsError: null, agentsLoading: false });
    expect(f.controller.read().status).toEqual({ kind: "idle" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("retains disabled-engine reads and makes retired callbacks harmless", async () => {
    const f = fixture(snapshot({ engine: { ...snapshot().engine, availability: "disabled" } }));
    const read = f.controller.load();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.abort.abort();
    f.controller.dispose();
    f.controller.refresh();
    f.controller.probe();
    await f.controller.load();
    await settle(f, 0, "stale");
    await read;
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.controller.read().status).toEqual({ kind: "idle" });
    const retired = fixture(snapshot({ agentId: null }));
    retired.controller.dispose();
    retired.controller.refresh();
    expect(retired.refreshAgents).not.toHaveBeenCalled();
  });
});
