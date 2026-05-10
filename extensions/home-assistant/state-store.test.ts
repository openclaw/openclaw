import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomeAssistantStateStore, type EntityState, type StateDiff } from "./state-store.js";

function makeState(entity_id: string, state: string, extra?: Partial<EntityState>): EntityState {
  return {
    entity_id,
    state,
    attributes: {},
    last_changed: "2026-05-10T19:00:00+00:00",
    last_updated: "2026-05-10T19:00:00+00:00",
    ...extra,
  };
}

describe("HomeAssistantStateStore", () => {
  let store: HomeAssistantStateStore;

  beforeEach(() => {
    store = new HomeAssistantStateStore({
      allowList: ["sensor.battery_soc", "switch.gate_main"],
    });
  });

  describe("happy path: ingest + diff", () => {
    it("stores a new state and emits a diff with prev=null on first observation", () => {
      const seen: StateDiff[] = [];
      store.subscribeAll((diff) => seen.push(diff));

      const next = makeState("sensor.battery_soc", "97");
      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: next,
      });

      expect(seen).toHaveLength(1);
      expect(seen[0].entity_id).toBe("sensor.battery_soc");
      expect(seen[0].prev).toBeNull();
      expect(seen[0].next).toEqual(next);
      expect(store.get("sensor.battery_soc")).toEqual(next);
    });

    it("emits a diff with both prev and next populated on update", () => {
      const seen: StateDiff[] = [];
      store.subscribeAll((diff) => seen.push(diff));

      const first = makeState("sensor.battery_soc", "97");
      const second = makeState("sensor.battery_soc", "60", {
        last_updated: "2026-05-10T19:05:00+00:00",
      });

      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: first,
      });
      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: first,
        new_state: second,
      });

      expect(seen).toHaveLength(2);
      expect(seen[1].prev).toEqual(first);
      expect(seen[1].next).toEqual(second);
      expect(store.get("sensor.battery_soc")).toEqual(second);
    });

    it("emits a diff with next=null when entity is removed (new_state null)", () => {
      const initial = makeState("sensor.battery_soc", "97");
      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: initial,
      });

      const seen: StateDiff[] = [];
      store.subscribeAll((diff) => seen.push(diff));

      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: initial,
        new_state: null,
      });

      expect(seen).toHaveLength(1);
      expect(seen[0].prev).toEqual(initial);
      expect(seen[0].next).toBeNull();
      expect(store.get("sensor.battery_soc")).toBeUndefined();
    });
  });

  describe("allow-list filtering", () => {
    it("drops state for an entity outside allowList without emitting", () => {
      const seen: StateDiff[] = [];
      store.subscribeAll((diff) => seen.push(diff));

      store.applyStateChanged({
        entity_id: "sensor.not_allowed",
        old_state: null,
        new_state: makeState("sensor.not_allowed", "42"),
      });

      expect(seen).toHaveLength(0);
      expect(store.get("sensor.not_allowed")).toBeUndefined();
    });

    it("treats an empty allowList as fail-closed (drops everything)", () => {
      const closedStore = new HomeAssistantStateStore({ allowList: [] });
      const seen: StateDiff[] = [];
      closedStore.subscribeAll((diff) => seen.push(diff));

      closedStore.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });

      expect(seen).toHaveLength(0);
      expect(closedStore.get("sensor.battery_soc")).toBeUndefined();
    });
  });

  describe("per-entity subscription", () => {
    it("delivers diffs only for the subscribed entity", () => {
      const battery: StateDiff[] = [];
      const gate: StateDiff[] = [];
      store.subscribe("sensor.battery_soc", (diff) => battery.push(diff));
      store.subscribe("switch.gate_main", (diff) => gate.push(diff));

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

      expect(battery).toHaveLength(1);
      expect(battery[0].entity_id).toBe("sensor.battery_soc");
      expect(gate).toHaveLength(1);
      expect(gate[0].entity_id).toBe("switch.gate_main");
    });

    it("returns an unsubscribe function that stops further notifications", () => {
      const seen: StateDiff[] = [];
      const unsubscribe = store.subscribe("sensor.battery_soc", (diff) => seen.push(diff));

      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });
      unsubscribe();
      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: makeState("sensor.battery_soc", "97"),
        new_state: makeState("sensor.battery_soc", "50"),
      });

      expect(seen).toHaveLength(1);
    });
  });

  describe("listener resilience", () => {
    it("does not let a listener throwing break other listeners", () => {
      const calls: string[] = [];
      store.subscribeAll(() => {
        calls.push("a");
        throw new Error("bang");
      });
      store.subscribeAll(() => {
        calls.push("b");
      });

      const errors = vi.fn();
      store.onListenerError(errors);

      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });

      expect(calls).toEqual(["a", "b"]);
      expect(errors).toHaveBeenCalledTimes(1);
    });
  });

  describe("reset", () => {
    it("clears stored state and emits prev=lastKnown, next=null for each entity", () => {
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

      const seen: StateDiff[] = [];
      store.subscribeAll((diff) => seen.push(diff));

      store.reset();

      expect(seen.map((d) => d.entity_id).sort()).toEqual([
        "sensor.battery_soc",
        "switch.gate_main",
      ]);
      expect(seen.every((d) => d.next === null)).toBe(true);
      expect(store.get("sensor.battery_soc")).toBeUndefined();
      expect(store.get("switch.gate_main")).toBeUndefined();
    });
  });

  describe("integration: per-entity vs subscribeAll fan-out", () => {
    it("delivers each diff once per registered listener for that entity, plus once to subscribeAll", () => {
      const all: StateDiff[] = [];
      const battery: StateDiff[] = [];
      const gate: StateDiff[] = [];

      store.subscribeAll((diff) => all.push(diff));
      store.subscribe("sensor.battery_soc", (diff) => battery.push(diff));
      store.subscribe("switch.gate_main", (diff) => gate.push(diff));

      store.applyStateChanged({
        entity_id: "sensor.battery_soc",
        old_state: null,
        new_state: makeState("sensor.battery_soc", "97"),
      });

      expect(all).toHaveLength(1);
      expect(battery).toHaveLength(1);
      expect(gate).toHaveLength(0);
    });
  });
});
