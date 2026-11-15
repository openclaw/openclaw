import { expect, it } from "vitest";
import {
  coveringGrant,
  parseMembership,
  effectiveBinding,
  storesRevision,
  readStoresSection,
  parsePolicy,
} from "./stores-config.js";

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
    hubPercentile: 90,
    maintenance,
  });
  expect(parsePolicy({ writesEnabled: false })).toStrictEqual({
    operatorRead: true,
    writesEnabled: false,
    hubPercentile: 90,
    maintenance,
  });
  expect(parsePolicy({ pageBudgets: { hubPercentile: 95 } }).hubPercentile).toBe(95);
  expect(() => parsePolicy({ pageBudgets: { hubPercentile: 20 } })).toThrow(/invalid/);
  expect(
    parsePolicy({ maintenance: { schedule: "*/5 * * * *", timezone: "UTC" } }).maintenance,
  ).toStrictEqual({ enabled: true, schedule: "*/5 * * * *", timezone: "UTC" });
  expect(() => parsePolicy({ vault: {} })).toThrow(/invalid/);
});

it("a conversation grant covers its key-denoted children; the most specific grant wins", () => {
  const grants = {
    "agent:main:telegram:group:-100": "read",
    "agent:main:telegram:group:-100:topic:7": "read-write",
  } as const;
  expect(coveringGrant(grants, "agent:main:telegram:group:-100:thread:9")).toBe("read");
  expect(coveringGrant(grants, "agent:main:telegram:group:-100:topic:7:thread:1")).toBe(
    "read-write",
  );
  expect(coveringGrant(grants, "agent:main:telegram:group:-1000")).toBe(undefined);
  expect(coveringGrant(grants, "agent:other:telegram:group:-100")).toBe(undefined);
});
