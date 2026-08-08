// Discord tests cover network config plugin behavior.
import type * as dns from "node:dns";
import { afterEach, describe, expect, it, vi } from "vitest";

const dnsMocks = vi.hoisted(() => ({
  lookup: vi.fn(),
}));
const ssrfMocks = vi.hoisted(() => ({
  resolvePinnedHostname: vi.fn(),
}));

vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    lookup: dnsMocks.lookup,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostname: ssrfMocks.resolvePinnedHostname,
}));

import { createDiscordDnsLookup, createDiscordProviderDnsLookup } from "./network-config.js";

describe("createDiscordDnsLookup", () => {
  afterEach(() => {
    dnsMocks.lookup.mockReset();
    ssrfMocks.resolvePinnedHostname.mockReset();
  });

  it("returns reordered address arrays when the caller requests all addresses", async () => {
    dnsMocks.lookup.mockImplementation((_hostname: string, options: unknown, callback: unknown) => {
      expect(options).toEqual({ all: true });
      (callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(
        null,
        [
          { address: "2606:4700::6810:1234", family: 6 },
          { address: "162.159.135.232", family: 4 },
        ],
      );
    });

    const lookup = createDiscordDnsLookup();
    const addresses = await new Promise<dns.LookupAddress[]>((resolve, reject) => {
      lookup("discord.com", { all: true }, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result as dns.LookupAddress[]);
      });
    });

    expect(addresses).toEqual([
      { address: "162.159.135.232", family: 4 },
      { address: "2606:4700::6810:1234", family: 6 },
    ]);
  });

  it("returns the first reordered IPv4 address for scalar lookups", async () => {
    dnsMocks.lookup.mockImplementation(
      (_hostname: string, _options: unknown, callback: unknown) => {
        (callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(
          null,
          [
            { address: "2606:4700::6810:1234", family: 6 },
            { address: "162.159.135.232", family: 4 },
          ],
        );
      },
    );

    const lookup = createDiscordDnsLookup();
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("gateway.discord.gg", {}, (err, address, family) => {
        if (err) {
          reject(err);
          return;
        }
        if (typeof address !== "string" || typeof family !== "number") {
          reject(new Error("Expected scalar lookup result"));
          return;
        }
        resolve({ address, family });
      });
    });

    expect(result).toEqual({ address: "162.159.135.232", family: 4 });
  });

  it("delegates non-Discord hostnames unchanged", () => {
    const callback = vi.fn();
    const options = { all: true };
    const lookup = createDiscordDnsLookup();

    lookup("example.com", options, callback);

    expect(dnsMocks.lookup).toHaveBeenCalledWith("example.com", options, callback);
  });

  it("resolves and delegates provider lookups only through the pinned hostname", async () => {
    const options = { all: true };
    const pinnedLookup = vi.fn(
      (
        _hostname: string,
        _options: unknown,
        callback: (error: null, addresses: unknown[]) => void,
      ) => callback(null, [{ address: "93.184.216.34", family: 4 }]),
    );
    ssrfMocks.resolvePinnedHostname.mockResolvedValue({
      hostname: "provider.example",
      addresses: ["93.184.216.34"],
      lookup: pinnedLookup,
    });
    const lookup = createDiscordProviderDnsLookup();

    const addresses = await new Promise<unknown>((resolve, reject) => {
      lookup("Provider.Example", options, (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });

    expect(ssrfMocks.resolvePinnedHostname).toHaveBeenCalledWith("Provider.Example");
    expect(pinnedLookup).toHaveBeenCalledWith("provider.example", options, expect.any(Function));
    expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(dnsMocks.lookup).not.toHaveBeenCalled();
  });

  it("reports blocked provider resolutions through the lookup callback", async () => {
    ssrfMocks.resolvePinnedHostname.mockRejectedValue(
      "Blocked: resolves to private/internal address",
    );
    const lookup = createDiscordProviderDnsLookup();

    const result = await new Promise<{ error: Error | null; address: unknown; family?: number }>(
      (resolve) => {
        lookup("provider.example", {}, (error, address, family) => {
          resolve({ error, address, family });
        });
      },
    );

    expect(result.address).toBe("");
    expect(result.family).toBe(4);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe("Blocked: resolves to private/internal address");
    expect(dnsMocks.lookup).not.toHaveBeenCalled();
  });

  it("resolves provider hostnames afresh for every connection lookup", async () => {
    const createPinned = (address: string) => ({
      hostname: "provider.example",
      addresses: [address],
      lookup: vi.fn(
        (_hostname: string, _options: unknown, callback: (error: null, value: string) => void) =>
          callback(null, address),
      ),
    });
    const first = createPinned("93.184.216.34");
    const second = createPinned("93.184.216.35");
    ssrfMocks.resolvePinnedHostname.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const lookup = createDiscordProviderDnsLookup();
    const runLookup = () =>
      new Promise<string>((resolve, reject) => {
        lookup("provider.example", {}, (error, address) => {
          if (error) {
            reject(error);
            return;
          }
          if (typeof address !== "string") {
            reject(new Error("expected scalar provider lookup address"));
            return;
          }
          resolve(address);
        });
      });

    await expect(runLookup()).resolves.toBe("93.184.216.34");
    await expect(runLookup()).resolves.toBe("93.184.216.35");

    expect(ssrfMocks.resolvePinnedHostname).toHaveBeenCalledTimes(2);
    expect(first.lookup).toHaveBeenCalledOnce();
    expect(second.lookup).toHaveBeenCalledOnce();
    expect(dnsMocks.lookup).not.toHaveBeenCalled();
  });
});
