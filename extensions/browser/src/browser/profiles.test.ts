// Browser tests cover profiles plugin behavior.
import net from "node:net";
import { describe, expect, it } from "vitest";
import { allocateFreeCdpPort, getUsedPorts } from "./profiles.js";

const CDP_PORT_RANGE_START = 18800;
const CDP_PORT_RANGE_END = 18899;

describe("port allocation", () => {
  it("returns null when all ports are exhausted", async () => {
    const usedPorts = new Set<number>();
    for (let port = CDP_PORT_RANGE_START; port <= CDP_PORT_RANGE_END; port++) {
      usedPorts.add(port);
    }
    expect(await allocateFreeCdpPort(usedPorts, undefined, async () => true)).toBeNull();
  });

  it("rejects fractional or out-of-range allocation ranges", async () => {
    const probed: number[] = [];
    const probe = async (candidate: number) => {
      probed.push(candidate);
      return true;
    };
    expect(await allocateFreeCdpPort(new Set(), { start: 20000.5, end: 20002 }, probe)).toBeNull();
    expect(await allocateFreeCdpPort(new Set(), { start: 20000, end: 65536 }, probe)).toBeNull();
    expect(probed).toEqual([]);
  });
});

describe("free port allocation", () => {
  it("skips configured ports and live listeners", async () => {
    const probed: number[] = [];
    const port = await allocateFreeCdpPort(
      new Set([CDP_PORT_RANGE_START]),
      undefined,
      async (candidate) => {
        probed.push(candidate);
        return candidate !== CDP_PORT_RANGE_START + 1;
      },
    );
    expect(port).toBe(CDP_PORT_RANGE_START + 2);
    expect(probed).toEqual([CDP_PORT_RANGE_START + 1, CDP_PORT_RANGE_START + 2]);
  });

  it("skips a live listener even though no profile claims the port", async () => {
    const blocker = net.createServer().listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      blocker.once("listening", resolve);
      blocker.once("error", reject);
    });
    const blockerPort = (blocker.address() as net.AddressInfo).port;
    try {
      const port = await allocateFreeCdpPort(new Set(), {
        start: blockerPort,
        end: Math.min(blockerPort + 5, 65_535),
      });
      // The assigned port must differ from the live listener; the exact first
      // free candidate is racy near the ephemeral range on shared runners.
      expect(port).not.toBeNull();
      expect(port).not.toBe(blockerPort);
    } finally {
      await new Promise<void>((resolve) => {
        blocker.close(() => {
          resolve();
        });
      });
    }
  });

  it("returns null when every candidate is in use", async () => {
    const port = await allocateFreeCdpPort(new Set(), undefined, async () => false);
    expect(port).toBeNull();
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
