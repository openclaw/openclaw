import type {
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
  DoctorMemoryStatusPayload,
} from "openclaw/plugin-sdk/control-ui";
import { describe, expect, it, vi } from "vitest";
import { createMemoryOverviewController } from "./controller.ts";

type MutableSnapshot = {
  -readonly [K in keyof ControlUiSettingsSnapshot]: ControlUiSettingsSnapshot[K];
};
const snapshot = (): MutableSnapshot => ({
  agentId: "main",
  agentsLoading: false,
  agentsError: null,
  engine: { kind: "default", id: "memory-core", availability: "enabled" },
  connected: true,
  connectionEpoch: 1,
  routeIntent: "overview",
  locale: "en",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(props = snapshot()) {
  const abort = new AbortController();
  const pending: ReturnType<typeof deferred<DoctorMemoryStatusPayload>>[] = [];
  const request = vi.fn(() => {
    const next = deferred<DoctorMemoryStatusPayload>();
    pending.push(next);
    return next.promise;
  });
  const refreshAgents = vi.fn();
  const changed = vi.fn();
  const context = {
    props,
    signal: abort.signal,
    request,
    refreshAgents,
    formatError: String,
  } as unknown as ControlUiSettingsContext;
  const controller = createMemoryOverviewController(context, changed, () => "offline");
  return { controller, pending, request, refreshAgents, abort };
}
const payload = (agentId: string): DoctorMemoryStatusPayload => ({
  agentId,
  embedding: { ok: true },
});

describe("Memory overview request ownership", () => {
  it("deduplicates ordinary reads and probes only on explicit action", async () => {
    const f = fixture();
    const read = f.controller.load();
    await f.controller.load();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenLastCalledWith("doctor.memory.status", { agentId: "main" });
    f.pending[0]!.resolve(payload("main"));
    await read;
    f.controller.probe();
    expect(f.request).toHaveBeenLastCalledWith("doctor.memory.status", {
      agentId: "main",
      probe: true,
    });
    expect(f.controller.read().probingEmbeddings).toBe(true);
    f.pending[1]!.resolve(payload("probed"));
    await Promise.resolve();
    expect(f.controller.read().status).toEqual({ kind: "ready", payload: payload("probed") });
    expect(f.controller.read().probingEmbeddings).toBe(false);
  });
  it.each(["agent", "engine", "epoch", "route"])(
    "retires an old probe when %s authority changes",
    async (kind) => {
      const f = fixture();
      f.controller.probe();
      const next = snapshot();
      if (kind === "agent") {
        next.agentId = "writer";
      }
      if (kind === "engine") {
        next.engine = { kind: "pinned", id: "custom-memory", availability: "unknown" };
      }
      if (kind === "epoch") {
        next.connectionEpoch = 2;
      }
      if (kind === "route") {
        next.routeIntent = "overview?agent=writer";
      }
      f.controller.update(next);
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.controller.read().probingEmbeddings).toBe(false);
      f.pending[0]!.resolve(payload("stale"));
      await Promise.resolve();
      expect(f.controller.read().status).toEqual({ kind: "loading" });
      f.pending[1]!.resolve(payload("fresh"));
      await Promise.resolve();
      expect(f.controller.read().status).toEqual({ kind: "ready", payload: payload("fresh") });
    },
  );
  it.each(["off", "offline", "no-agent"])(
    "clears pending status and probe when %s",
    async (kind) => {
      const f = fixture();
      f.controller.probe();
      const next = snapshot();
      if (kind === "off") {
        next.engine = { kind: "off", id: null, availability: "unknown" };
      }
      if (kind === "offline") {
        next.connected = false;
      }
      if (kind === "no-agent") {
        next.agentId = null;
      }
      f.controller.update(next);
      expect(f.controller.read().probingEmbeddings).toBe(false);
      expect(f.request).toHaveBeenCalledTimes(1);
      f.pending[0]!.resolve(payload("stale"));
      await Promise.resolve();
      expect(f.controller.read().status).toEqual(
        kind === "offline" ? { kind: "error", message: "offline" } : { kind: "idle" },
      );
    },
  );
  it("does not cache a roster error when no agent is selected", async () => {
    const props = snapshot();
    props.agentId = null;
    props.agentsError = "roster failed";
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
    const props = snapshot();
    props.engine = { ...props.engine, availability: "disabled" };
    const f = fixture(props);
    const read = f.controller.load();
    expect(f.request).toHaveBeenCalledTimes(1);
    f.abort.abort();
    f.controller.refresh();
    f.controller.probe();
    await f.controller.load();
    f.pending[0]!.resolve(payload("stale"));
    await read;
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.controller.read().status).toEqual({ kind: "idle" });
    const noAgent = snapshot();
    noAgent.agentId = null;
    const retired = fixture(noAgent);
    retired.controller.dispose();
    retired.controller.refresh();
    expect(retired.refreshAgents).not.toHaveBeenCalled();
  });
});
