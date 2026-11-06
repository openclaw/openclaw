// Browser tests cover profiles plugin behavior.
import { once } from "node:events";
import net from "node:net";
import { expect, it } from "vitest";
import { allocateAvailableCdpPort, allocateCdpPort, getUsedPorts } from "./profiles.js";

it("returns null for an exhausted, fractional or out-of-range CDP port range", () => {
  const exhausted = new Set(Array.from({ length: 100 }, (_, index) => 18800 + index));
  expect(allocateCdpPort(exhausted)).toBeNull();
  expect(allocateCdpPort(new Set(), { start: 20000.5, end: 20002 })).toBeNull();
  expect(allocateCdpPort(new Set(), { start: 20000, end: 65536 })).toBeNull();
});

it("skips a CDP port another process is listening on", async () => {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const busy = (server.address() as net.AddressInfo).port;
  const range = { start: busy, end: busy + 1 };
  expect(allocateCdpPort(new Set(), range)).toBe(busy);
  await expect(allocateAvailableCdpPort(new Set(), range)).resolves.toBe(busy + 1);
  await expect(allocateAvailableCdpPort(new Set([busy + 1]), range)).resolves.toBeNull();
  server.close();
});

it("collects no ports from missing profiles or invalid cdpUrl values", () => {
  expect(getUsedPorts(undefined)).toEqual(new Set());
  const profiles = { bad: { cdpUrl: "notaurl" }, portZero: { cdpUrl: "http://127.0.0.1:0" } };
  expect(getUsedPorts(profiles).size).toBe(0);
});
