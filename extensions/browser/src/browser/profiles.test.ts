// Browser tests cover profiles plugin behavior.
import { describe, expect, it } from "vitest";
import { allocateCdpPort, getUsedPorts } from "./profiles.js";

const CDP_PORT_RANGE_START = 18800;
const CDP_PORT_RANGE_END = 18899;

describe("port allocation", () => {
  it("returns null when all ports are exhausted", () => {
    const usedPorts = new Set<number>();
    for (let port = CDP_PORT_RANGE_START; port <= CDP_PORT_RANGE_END; port++) {
      usedPorts.add(port);
    }
    expect(allocateCdpPort(usedPorts)).toBeNull();
  });

  it("rejects fractional or out-of-range allocation ranges", () => {
    expect(allocateCdpPort(new Set(), { start: 20000.5, end: 20002 })).toBeNull();
    expect(allocateCdpPort(new Set(), { start: 20000, end: 65536 })).toBeNull();
  });
});

describe("getUsedPorts", () => {
  it("returns empty set for undefined profiles", () => {
    expect(getUsedPorts(undefined)).toEqual(new Set());
  });

  it("ignores invalid cdpUrl values", () => {
    const profiles = {
      bad: { cdpUrl: "notaurl" },
      portZero: { cdpUrl: "http://127.0.0.1:0" },
    };
    const used = getUsedPorts(profiles);
    expect(used.size).toBe(0);
  });
});
