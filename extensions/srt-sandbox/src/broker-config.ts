// Per-broker SRT runtime config for the per-session network broker (S4-P1).
//
// A broker is an independent `srt` process, so — unlike the in-process P0 path
// (srt-runtime-config.ts) — its network policy is a real, enforced allowlist,
// not a posture surface. Two facts about SRT's filter shape drive this config
// (verified against @anthropic-ai/sandbox-runtime@0.0.76):
//
//   1. deniedDomains are checked BEFORE allowedDomains and win outright
//      (sandbox-manager.ts:226-236). So `deniedDomains: ["*"]` — the P0 shape —
//      would deny even an allow-listed host. A WORKING allowlist therefore uses
//      an empty denylist plus `strictAllowlist: true`, which denies every host
//      not in allowedDomains without consulting an ask callback
//      (sandbox-manager.ts:244-249). An empty allowlist under strictAllowlist is
//      a clean fail-closed deny-all.
//   2. `parentProxy` is captured BY VALUE when the proxy servers are created and
//      is NOT hot-swappable via the control fd (sandbox-manager.ts:1979-1982).
//      It is baked into the settings file at spawn; a later change requires a
//      broker re-init, never a live updateConfig (enforced in session-broker.ts).
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

/** Upstream proxy the broker tunnels through. Shape mirrors SRT's parentProxy. */
export type BrokerParentProxy = {
  http?: string;
  https?: string;
  noProxy?: string;
};

/** The per-session network policy a broker enforces. */
export type BrokerNetworkPolicy = {
  /**
   * Hosts this session may reach (domain or `host:port`, SRT pattern syntax).
   * Empty => strict deny-all (fail closed). Everything not listed is denied.
   */
  allowedDomains: string[];
  /** Optional upstream proxy; baked at spawn, not live-swappable (see above). */
  parentProxy?: BrokerParentProxy;
};

export type BuildBrokerRuntimeConfigInput = {
  /** Writable roots for the broker's filesystem allowlist (scope dirs + extras). */
  writableRoots: string[];
  /** The session's network policy. */
  policy: BrokerNetworkPolicy;
};

/** Trim + dedupe an allowlist, preserving declaration order. */
function normalizeAllowedDomains(domains: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of domains) {
    const value = raw.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** Drop empty parentProxy fields; return undefined when nothing is set. */
function normalizeParentProxy(proxy: BrokerParentProxy | undefined): BrokerParentProxy | undefined {
  if (!proxy) {
    return undefined;
  }
  const out: BrokerParentProxy = {};
  if (proxy.http?.trim()) {
    out.http = proxy.http.trim();
  }
  if (proxy.https?.trim()) {
    out.https = proxy.https.trim();
  }
  if (proxy.noProxy?.trim()) {
    out.noProxy = proxy.noProxy.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the SRT runtime config a broker is initialized with. Network is a
 * strict allowlist (empty denylist, `strictAllowlist: true`); writes are
 * confined to `writableRoots`; reads stay open (the "rest read-only" half).
 */
export function buildBrokerRuntimeConfig(
  input: BuildBrokerRuntimeConfigInput,
): SandboxRuntimeConfig {
  const allowedDomains = normalizeAllowedDomains(input.policy.allowedDomains);
  const parentProxy = normalizeParentProxy(input.policy.parentProxy);
  const network: Record<string, unknown> = {
    allowedDomains,
    deniedDomains: [],
    strictAllowlist: true,
  };
  if (parentProxy) {
    network.parentProxy = parentProxy;
  }
  return {
    network,
    filesystem: {
      allowRead: [],
      denyRead: [],
      allowWrite: [...input.writableRoots],
      denyWrite: [],
    },
  } as unknown as SandboxRuntimeConfig;
}

/** Serialize a broker config for the `srt --settings <file>` / control-fd JSON-lines. */
export function serializeBrokerConfig(config: SandboxRuntimeConfig): string {
  return JSON.stringify(config);
}

/**
 * Structural equality for two parentProxy values (after normalization). Used to
 * decide whether a policy change is a live allowlist swap (safe) or an upstream
 * proxy change (needs re-init, not hot-swappable — sandbox-manager.ts:1979-1982).
 */
export function sameParentProxy(
  a: BrokerParentProxy | undefined,
  b: BrokerParentProxy | undefined,
): boolean {
  const na = normalizeParentProxy(a);
  const nb = normalizeParentProxy(b);
  if (na === undefined || nb === undefined) {
    return na === nb;
  }
  return na.http === nb.http && na.https === nb.https && na.noProxy === nb.noProxy;
}
