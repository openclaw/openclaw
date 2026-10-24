import { expect, it } from "vitest";
import {
  parseMembership,
  effectiveBinding,
  storesRevision,
  readStoresSection,
  parsePolicy,
} from "./stores-config.js";

it("membership: unassigned agents use isolated defaults; assigned agents use their named store", () => {
  const m = parseMembership({ personal: { agents: ["main", "research"] } });
  expect(effectiveBinding(m, "main")).toBe("named:personal");
  expect(effectiveBinding(m, "ops")).toBe("agent:ops");
  expect(m.issues).toStrictEqual([]);
});

it("membership: duplicate assignment is invalid, never first-match-wins", () => {
  const m = parseMembership({ a: { agents: ["main"] }, b: { agents: ["main", "ops"] } });
  expect(effectiveBinding(m, "main")).toBe(undefined);
  expect(effectiveBinding(m, "ops")).toBe("named:b");
  expect(m.issues[0]).toMatch(/both "a" and "b"/);
});

it("membership: a malformed section makes listed agents unavailable instead of isolated", () => {
  const m = parseMembership({ "Bad Key": { agents: ["main"] } });
  expect(effectiveBinding(m, "main")).toBe(undefined);
  expect(effectiveBinding(m, "ops")).toBe("agent:ops");
});

it("revision covers only the stores section and ignores key order", () => {
  const a = {
    plugins: {
      entries: { knowledge: { config: { stores: { x: { label: "X", agents: ["main"] } } } } },
    },
    gateway: { port: 1 },
  };
  const b = {
    gateway: { port: 2 },
    plugins: {
      entries: { knowledge: { config: { stores: { x: { agents: ["main"], label: "X" } } } } },
    },
  };
  expect(storesRevision(readStoresSection(a))).toBe(storesRevision(readStoresSection(b)));
  expect(storesRevision(readStoresSection({}))).toBe(storesRevision({}));
});

it("policy gates default on and reject retired config shapes", () => {
  const maintenance = {
    enabled: true,
    schedule: "30 3 * * *",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  expect(parsePolicy(undefined)).toStrictEqual({
    operatorRead: true,
    writesEnabled: true,
    maintenance,
  });
  expect(parsePolicy({ writesEnabled: false })).toStrictEqual({
    operatorRead: true,
    writesEnabled: false,
    maintenance,
  });
  expect(
    parsePolicy({ maintenance: { schedule: "*/5 * * * *", timezone: "UTC" } }).maintenance,
  ).toStrictEqual({ enabled: true, schedule: "*/5 * * * *", timezone: "UTC" });
  expect(() => parsePolicy({ vault: {} })).toThrow(/invalid/);
});
