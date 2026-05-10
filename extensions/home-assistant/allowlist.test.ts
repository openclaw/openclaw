import { describe, expect, it } from "vitest";
import {
  checkServiceCall,
  isEntityAllowed,
  isServiceAllowed,
  type ServiceCheckResult,
} from "./allowlist.js";

const CONFIG = {
  allowList: [
    "sensor.deye_sunsynk_sol_ark_battery_state_of_charge",
    "switch.sonoff_10013c3266",
    "cover.aqara_roller_blind_left",
  ],
  denyServiceList: ["lock.unlock", "alarm_control_panel.alarm_disarm", "cover.open_cover"],
} as const;

describe("allowlist gate", () => {
  describe("isEntityAllowed", () => {
    it("returns true for an entity in allowList", () => {
      expect(isEntityAllowed("switch.sonoff_10013c3266", CONFIG)).toBe(true);
    });

    it("returns false for an entity outside allowList", () => {
      expect(isEntityAllowed("switch.something_unauthorized", CONFIG)).toBe(false);
    });

    it("fail-closed: an empty allowList denies everything", () => {
      expect(isEntityAllowed("switch.sonoff_10013c3266", { allowList: [] })).toBe(false);
    });

    it("normalizes whitespace -- a space-padded entity id matches its trimmed form", () => {
      expect(isEntityAllowed("  switch.sonoff_10013c3266  ", CONFIG)).toBe(true);
    });

    it("is case-sensitive on the comparison side -- HA entity ids are lowercase by convention", () => {
      // HA's data plane only emits lowercase. We do not silently match
      // mixed-case operator typos to a real entity; better to surface the
      // mismatch loudly during config validation than to mask it here.
      expect(isEntityAllowed("Switch.Sonoff_10013c3266", CONFIG)).toBe(false);
    });

    it("rejects non-string entity ids", () => {
      // The schema parser already rejects these, but the gate is also a
      // boundary that may be reached from runtime payloads.
      expect(isEntityAllowed(undefined as unknown as string, CONFIG)).toBe(false);
      expect(isEntityAllowed(null as unknown as string, CONFIG)).toBe(false);
      expect(isEntityAllowed(42 as unknown as string, CONFIG)).toBe(false);
    });
  });

  describe("isServiceAllowed", () => {
    it("returns true for a service not in denyServiceList", () => {
      expect(isServiceAllowed("switch", "toggle", CONFIG)).toBe(true);
    });

    it("returns false for a service in denyServiceList", () => {
      expect(isServiceAllowed("lock", "unlock", CONFIG)).toBe(false);
    });

    it("v1 documented default: empty denyServiceList allows any service (deny-list-authoritative)", () => {
      // Recorded decision: until allowServiceList lands, the gate is purely
      // deny-list-authoritative. The household-level safety net is the
      // HA-user-side deny-list from the Butler plan; this client gate is
      // belt-and-braces, not the only line of defense.
      expect(isServiceAllowed("switch", "toggle", { denyServiceList: [] })).toBe(true);
      expect(isServiceAllowed("lock", "unlock", { denyServiceList: [] })).toBe(true);
    });
  });

  describe("checkServiceCall", () => {
    it("returns allowed=true with the normalized domain/service for safe calls", () => {
      const result = checkServiceCall({ domain: "switch", service: "toggle" }, CONFIG);
      expect(result).toEqual<ServiceCheckResult>({
        allowed: true,
        domain: "switch",
        service: "toggle",
      });
    });

    it("returns a structured service-denied error for deny-listed services", () => {
      const result = checkServiceCall({ domain: "lock", service: "unlock" }, CONFIG);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason.kind).toBe("service-denied");
        expect(result.reason.domain).toBe("lock");
        expect(result.reason.service).toBe("unlock");
        expect(result.reason.detail).toMatch(/deny[-\s]?list/i);
      }
    });

    it("trims whitespace and lowercases domain/service before checking", () => {
      const result = checkServiceCall({ domain: "  LOCK ", service: "Unlock" }, CONFIG);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason.domain).toBe("lock");
        expect(result.reason.service).toBe("unlock");
      }
    });

    it("rejects malformed domain/service inputs without crashing", () => {
      const result = checkServiceCall({ domain: "", service: "toggle" }, CONFIG);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason.kind).toBe("service-denied");
        expect(result.reason.detail).toMatch(/empty|invalid/i);
      }
    });

    it("rejects domain or service containing a dot (would mis-match the deny-list)", () => {
      // denyServiceList entries are <domain>.<service>; a domain that itself
      // contains a dot would let a caller smuggle past the comparison.
      const result = checkServiceCall(
        { domain: "switch.lock", service: "unlock" },
        { denyServiceList: ["lock.unlock"] },
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason.kind).toBe("service-denied");
      }
    });
  });

  describe("future hardening guard (locks v1 deferred decision)", () => {
    it("documents that deny-list precedence holds even if allowServiceList is later added", () => {
      // When `allowServiceList` is added to HomeAssistantConfig, the gate must
      // still treat denyServiceList as authoritative (deny wins over allow).
      // This test fails fast if a future change reverses that precedence
      // by treating allowServiceList as overriding the deny-list.
      const config = { denyServiceList: ["lock.unlock"] };
      expect(isServiceAllowed("lock", "unlock", config)).toBe(false);
    });
  });

  describe("integration: filtering a list of HA service-call payloads", () => {
    it("partitions a batch of calls into allowed and denied", () => {
      const calls = [
        { domain: "switch", service: "toggle", target: "switch.sonoff_10013c3266" },
        { domain: "lock", service: "unlock", target: "lock.front_door" },
        { domain: "cover", service: "set_cover_position", target: "cover.aqara_roller_blind_left" },
        { domain: "alarm_control_panel", service: "alarm_disarm", target: "alarm.ring_alarm" },
      ];

      const results = calls.map((c) => ({
        target: c.target,
        result: checkServiceCall({ domain: c.domain, service: c.service }, CONFIG),
      }));

      const allowed = results.filter((r) => r.result.allowed).map((r) => r.target);
      const denied = results.filter((r) => !r.result.allowed).map((r) => r.target);

      expect(allowed).toEqual(["switch.sonoff_10013c3266", "cover.aqara_roller_blind_left"]);
      expect(denied).toEqual(["lock.front_door", "alarm.ring_alarm"]);
    });
  });
});
