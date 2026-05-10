import { describe, expect, it, vi } from "vitest";
import {
  HA_SERVICE_CALL_METHOD,
  HA_STATE_EVENT,
  HA_SUBSCRIBE_METHOD,
  attachHomeAssistantBridge,
  type BridgeGatewayApi,
  type BridgeGatewayHandlerArgs,
  type ServiceCallClient,
} from "./gateway-bridge.js";
import { HomeAssistantStateStore, type EntityState } from "./state-store.js";

type RegisteredMethod = {
  method: string;
  handler: (args: BridgeGatewayHandlerArgs) => Promise<void> | void;
  scope?: string;
};

class FakeApi implements BridgeGatewayApi {
  registered: RegisteredMethod[] = [];
  registerGatewayMethod = (
    method: string,
    handler: (args: BridgeGatewayHandlerArgs) => Promise<void> | void,
    opts?: { scope?: string },
  ): void => {
    this.registered.push({ method, handler, scope: opts?.scope });
  };
  byName(method: string): RegisteredMethod {
    const found = this.registered.find((r) => r.method === method);
    if (!found) {
      throw new Error(`method not registered: ${method}`);
    }
    return found;
  }
}

type Captured = { event: string; payload: unknown };

function makeContext(): {
  broadcast: (event: string, payload: unknown) => void;
  events: Captured[];
} {
  const events: Captured[] = [];
  return {
    broadcast: (event, payload) => events.push({ event, payload }),
    events,
  };
}

function makeRespond(): {
  respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void;
  calls: Array<{ ok: boolean; payload?: unknown; error?: { code: string; message: string } }>;
} {
  const calls: Array<{
    ok: boolean;
    payload?: unknown;
    error?: { code: string; message: string };
  }> = [];
  return {
    respond: (ok, payload, error) => calls.push({ ok, payload, error }),
    calls,
  };
}

class FakeServiceCallClient implements ServiceCallClient {
  calls: Array<{
    domain: string;
    service: string;
    target: string;
    serviceData?: Record<string, unknown>;
  }> = [];
  shouldThrow: Error | null = null;
  callService(args: {
    domain: string;
    service: string;
    target: string;
    serviceData?: Record<string, unknown>;
  }): void {
    if (this.shouldThrow) {
      const err = this.shouldThrow;
      this.shouldThrow = null;
      throw err;
    }
    this.calls.push({ ...args });
  }
}

const CONFIG = {
  allowList: ["sensor.battery_soc", "switch.gate_main", "switch.geyser", "cover.left_blind"],
  denyServiceList: ["lock.unlock", "alarm_control_panel.alarm_disarm", "cover.open_cover"],
} as const;

function makeState(entity_id: string, state: string): EntityState {
  return { entity_id, state, attributes: {} };
}

describe("home-assistant gateway bridge", () => {
  describe("registration", () => {
    it("registers home-assistant.subscribe with read scope and home-assistant.serviceCall with write scope", () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      attachHomeAssistantBridge({
        api,
        store,
        client: new FakeServiceCallClient(),
        config: CONFIG,
      });

      expect(api.byName(HA_SUBSCRIBE_METHOD).scope).toBe("operator.read");
      expect(api.byName(HA_SERVICE_CALL_METHOD).scope).toBe("operator.write");
    });
  });

  describe("subscribe + state push", () => {
    it("captures broadcast on subscribe and returns the current snapshot of allow-listed entities", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      attachHomeAssistantBridge({
        api,
        store,
        client: new FakeServiceCallClient(),
        config: CONFIG,
      });

      // Seed some state before the kiosk subscribes.
      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });
      store.applyStateChanged({
        entity_id: "switch.gate_main",
        old_state: null,
        new_state: makeState("switch.gate_main", "off"),
      });

      const ctx = makeContext();
      const r = makeRespond();
      await api.byName(HA_SUBSCRIBE_METHOD).handler({
        params: {},
        respond: r.respond,
        context: ctx,
      });

      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].ok).toBe(true);
      expect(r.calls[0].payload).toMatchObject({
        snapshot: expect.arrayContaining([
          { entity_id: "sensor.battery_soc", state: expect.any(Object) },
          { entity_id: "switch.gate_main", state: expect.any(Object) },
        ]),
      });
    });

    it("after subscribe, every state-store diff broadcasts as plugin.home-assistant.state", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      attachHomeAssistantBridge({
        api,
        store,
        client: new FakeServiceCallClient(),
        config: CONFIG,
      });

      const ctx = makeContext();
      await api.byName(HA_SUBSCRIBE_METHOD).handler({
        params: {},
        respond: makeRespond().respond,
        context: ctx,
      });

      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });

      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0].event).toBe(HA_STATE_EVENT);
      expect(ctx.events[0].payload).toMatchObject({
        entity_id: "sensor.battery_soc",
        prev: null,
        next: { entity_id: "sensor.battery_soc", state: "97" },
      });
    });

    it("does NOT broadcast state diffs before subscribe is called", () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const ctx = makeContext();
      attachHomeAssistantBridge({
        api,
        store,
        client: new FakeServiceCallClient(),
        config: CONFIG,
      });

      // Even though the state store would emit a diff, no broadcast
      // function has been captured yet -- there's no client to push to.
      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });

      expect(ctx.events).toHaveLength(0);
    });

    it("does NOT broadcast diffs for entities outside allowList (defense in depth)", async () => {
      const api = new FakeApi();
      // Store has the entity allow-listed, but bridge config is narrower.
      const store = new HomeAssistantStateStore({
        allowList: ["sensor.battery_soc", "sensor.uninvited"],
      });
      const ctx = makeContext();
      attachHomeAssistantBridge({
        api,
        store,
        client: new FakeServiceCallClient(),
        config: { ...CONFIG, allowList: ["sensor.battery_soc"] },
      });

      await api.byName(HA_SUBSCRIBE_METHOD).handler({
        params: {},
        respond: makeRespond().respond,
        context: ctx,
      });

      store.applyStateChanged({
        entity_id: "sensor.uninvited",
        old_state: null,
        new_state: makeState("sensor.uninvited", "1"),
      });
      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });

      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0].payload).toMatchObject({ entity_id: "sensor.battery_soc" });
    });
  });

  describe("home-assistant.serviceCall", () => {
    it("happy path: dispatches an allow-listed switch.toggle to the WS client", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const client = new FakeServiceCallClient();
      attachHomeAssistantBridge({ api, store, client, config: CONFIG });

      const r = makeRespond();
      await api.byName(HA_SERVICE_CALL_METHOD).handler({
        params: { domain: "switch", service: "toggle", target: "switch.gate_main" },
        respond: r.respond,
        context: makeContext(),
      });

      expect(client.calls).toEqual([
        { domain: "switch", service: "toggle", target: "switch.gate_main" },
      ]);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].ok).toBe(true);
      expect(r.calls[0].payload).toMatchObject({ dispatched: true });
    });

    it("forwards optional service_data (e.g. cover position)", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const client = new FakeServiceCallClient();
      attachHomeAssistantBridge({ api, store, client, config: CONFIG });

      await api.byName(HA_SERVICE_CALL_METHOD).handler({
        params: {
          domain: "cover",
          service: "set_cover_position",
          target: "cover.left_blind",
          serviceData: { position: 50 },
        },
        respond: makeRespond().respond,
        context: makeContext(),
      });

      expect(client.calls).toEqual([
        {
          domain: "cover",
          service: "set_cover_position",
          target: "cover.left_blind",
          serviceData: { position: 50 },
        },
      ]);
    });

    it("denies a deny-listed service with structured service-denied error and never calls the WS client", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const client = new FakeServiceCallClient();
      attachHomeAssistantBridge({ api, store, client, config: CONFIG });

      const r = makeRespond();
      await api.byName(HA_SERVICE_CALL_METHOD).handler({
        params: { domain: "lock", service: "unlock", target: "lock.front_door" },
        respond: r.respond,
        context: makeContext(),
      });

      expect(client.calls).toHaveLength(0);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].ok).toBe(false);
      expect(r.calls[0].error?.code).toBe("service-denied");
    });

    it("denies a target entity that is not in allowList", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const client = new FakeServiceCallClient();
      attachHomeAssistantBridge({ api, store, client, config: CONFIG });

      const r = makeRespond();
      await api.byName(HA_SERVICE_CALL_METHOD).handler({
        params: { domain: "switch", service: "toggle", target: "switch.not_allow_listed" },
        respond: r.respond,
        context: makeContext(),
      });

      expect(client.calls).toHaveLength(0);
      expect(r.calls[0].ok).toBe(false);
      expect(r.calls[0].error?.code).toBe("entity-denied");
    });

    it("rejects payloads missing target with invalid_params before any allow-list check", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const client = new FakeServiceCallClient();
      attachHomeAssistantBridge({ api, store, client, config: CONFIG });

      const r = makeRespond();
      await api.byName(HA_SERVICE_CALL_METHOD).handler({
        params: { domain: "switch", service: "toggle" },
        respond: r.respond,
        context: makeContext(),
      });

      expect(client.calls).toHaveLength(0);
      expect(r.calls[0].ok).toBe(false);
      expect(r.calls[0].error?.code).toBe("invalid_params");
      expect(r.calls[0].error?.message).toMatch(/target/i);
    });

    it("rejects payloads missing domain or service", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const client = new FakeServiceCallClient();
      attachHomeAssistantBridge({ api, store, client, config: CONFIG });

      const r = makeRespond();
      await api.byName(HA_SERVICE_CALL_METHOD).handler({
        params: { service: "toggle", target: "switch.gate_main" },
        respond: r.respond,
        context: makeContext(),
      });

      expect(r.calls[0].ok).toBe(false);
      expect(r.calls[0].error?.code).toMatch(/invalid_params|service-denied/);
    });

    it("surfaces ws-client failure as ha_call_failed without crashing the handler", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const client = new FakeServiceCallClient();
      client.shouldThrow = new Error("not subscribed");
      attachHomeAssistantBridge({ api, store, client, config: CONFIG });

      const r = makeRespond();
      await api.byName(HA_SERVICE_CALL_METHOD).handler({
        params: { domain: "switch", service: "toggle", target: "switch.gate_main" },
        respond: r.respond,
        context: makeContext(),
      });

      expect(r.calls[0].ok).toBe(false);
      expect(r.calls[0].error?.code).toBe("ha_call_failed");
      expect(r.calls[0].error?.message).toMatch(/not subscribed/);
    });
  });

  describe("detach", () => {
    it("stops broadcasting after detach", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const ctx = makeContext();
      const handle = attachHomeAssistantBridge({
        api,
        store,
        client: new FakeServiceCallClient(),
        config: CONFIG,
      });

      await api.byName(HA_SUBSCRIBE_METHOD).handler({
        params: {},
        respond: makeRespond().respond,
        context: ctx,
      });

      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });
      expect(ctx.events).toHaveLength(1);

      handle.detach();

      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: makeState("sensor.battery_soc", "97"),
        new_state: makeState("sensor.battery_soc", "60"),
      });
      expect(ctx.events).toHaveLength(1); // unchanged
    });
  });

  describe("integration: full round-trip tile-tap -> service call -> state echo -> push", () => {
    it("dispatches the call, then later state echo flows back as a plugin.home-assistant.state event", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const client = new FakeServiceCallClient();
      const ctx = makeContext();
      attachHomeAssistantBridge({ api, store, client, config: CONFIG });

      // 1. UI subscribes.
      await api.byName(HA_SUBSCRIBE_METHOD).handler({
        params: {},
        respond: makeRespond().respond,
        context: ctx,
      });

      // 2. UI taps a tile -> service call dispatched.
      const r = makeRespond();
      await api.byName(HA_SERVICE_CALL_METHOD).handler({
        params: { domain: "switch", service: "toggle", target: "switch.geyser" },
        respond: r.respond,
        context: ctx,
      });
      expect(r.calls[0].ok).toBe(true);
      expect(client.calls).toHaveLength(1);

      // 3. HA emits state_changed for the toggled entity (simulated by
      // applying it to the store directly, which is what ws-client does
      // when the real HA event arrives).
      store.applyStateChanged({
        entity_id: "switch.geyser",
        old_state: null,
        new_state: makeState("switch.geyser", "on"),
      });

      // 4. UI receives a plugin.home-assistant.state push reflecting the
      // toggled state.
      expect(ctx.events).toHaveLength(1);
      expect(ctx.events[0]).toEqual({
        event: HA_STATE_EVENT,
        payload: {
          entity_id: "switch.geyser",
          prev: null,
          next: makeState("switch.geyser", "on"),
        },
      });
    });
  });

  describe("logger", () => {
    it("invokes the optional logger on broadcast errors without breaking other listeners", async () => {
      const api = new FakeApi();
      const store = new HomeAssistantStateStore({ allowList: [...CONFIG.allowList] });
      const logger = vi.fn();
      const ctx = {
        broadcast: (_event: string, _payload: unknown) => {
          throw new Error("transport down");
        },
      };
      attachHomeAssistantBridge({
        api,
        store,
        client: new FakeServiceCallClient(),
        config: CONFIG,
        logger,
      });

      await api.byName(HA_SUBSCRIBE_METHOD).handler({
        params: {},
        respond: makeRespond().respond,
        context: ctx,
      });

      // Emit a diff -- broadcast will throw inside the listener.
      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });

      expect(logger).toHaveBeenCalled();
      const errorEntry = logger.mock.calls.find(([entry]) => entry?.level === "warn");
      expect(errorEntry).toBeTruthy();
    });
  });
});
