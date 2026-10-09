import * as dns from "node:dns";
import type { LookupFunction } from "node:net";
import { resolvePinnedHostnameWithPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const DISCORD_DNS_HOSTS = ["discord.com", "discord.gg", "gateway.discord.gg"];

function isDiscordTransportHostname(hostname: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(hostname);
  return DISCORD_DNS_HOSTS.some(
    (target) => normalized === target || normalized.endsWith(`.${target}`),
  );
}

export function createDiscordDnsLookup(): LookupFunction {
  return (hostname, options, callback) => {
    if (!isDiscordTransportHostname(hostname)) {
      return dns.lookup(hostname, options, callback);
    }

    const lookupOptions: dns.LookupOptions =
      typeof options === "number" ? { family: options } : { ...options };

    if (lookupOptions.family === 4 || lookupOptions.family === 6) {
      return dns.lookup(hostname, lookupOptions, callback as never);
    }

    dns.lookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
      if (err) {
        callback(err, "", 4);
        return;
      }
      if (!Array.isArray(addresses)) {
        callback(new Error("Expected all lookup addresses to be an array"), "", 4);
        return;
      }

      const reordered =
        addresses.length < 2
          ? addresses
          : [
              ...addresses.filter((entry) => entry.family === 4),
              ...addresses.filter((entry) => entry.family === 6),
            ];
      if (lookupOptions.all === true) {
        (callback as (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void)(
          null,
          reordered,
        );
        return;
      }

      const first = reordered[0];
      if (!first) {
        callback(new Error("No Discord DNS addresses resolved"), "", 4);
        return;
      }
      callback(null, first.address, first.family);
    });
  };
}

export function createDiscordEndpointDnsLookup(endpointHostname: string): LookupFunction {
  const normalizedEndpointHostname = normalizeLowercaseStringOrEmpty(endpointHostname);
  if (!normalizedEndpointHostname) {
    throw new Error("Discord endpoint Gateway hostname is required");
  }
  const policy = {
    allowedHostnames: [normalizedEndpointHostname],
    hostnameAllowlist: [normalizedEndpointHostname],
  };
  return (hostname, options, callback) => {
    void resolvePinnedHostnameWithPolicy(hostname, { policy }).then(
      (pinned) => pinned.lookup(pinned.hostname, options, callback),
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), "", 4);
      },
    );
  };
}
