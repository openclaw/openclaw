import * as dns from "node:dns";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { resolveFetch } from "../../../src/infra/fetch.js";
import { hasEnvHttpProxyConfigured } from "../../../src/infra/net/proxy-env.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import {
  resolveTelegramAutoSelectFamilyDecision,
  resolveTelegramDnsResultOrderDecision
} from "./network-config.js";
import { getProxyUrlFromFetch } from "./proxy.js";
const log = createSubsystemLogger("telegram/network");
const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
const TELEGRAM_API_HOSTNAME = "api.telegram.org";
const FALLBACK_RETRY_ERROR_CODES = [
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
];
const IPV4_FALLBACK_RULES = [
  {
    name: "fetch-failed-envelope",
    matches: ({ message }) => message.includes("fetch failed")
  },
  {
    name: "known-network-code",
    matches: ({ codes }) => FALLBACK_RETRY_ERROR_CODES.some((code) => codes.has(code))
  }
];
function normalizeDnsResultOrder(value) {
  if (value === "ipv4first" || value === "verbatim") {
    return value;
  }
  return null;
}
function createDnsResultOrderLookup(order) {
  if (!order) {
    return void 0;
  }
  const lookup = dns.lookup;
  return (hostname, options, callback) => {
    const baseOptions = typeof options === "number" ? { family: options } : options ? { ...options } : {};
    const lookupOptions = {
      ...baseOptions,
      order,
      // Keep `verbatim` for compatibility with Node runtimes that ignore `order`.
      verbatim: order === "verbatim"
    };
    lookup(hostname, lookupOptions, callback);
  };
}
function buildTelegramConnectOptions(params) {
  const connect = {};
  if (params.forceIpv4) {
    connect.family = 4;
    connect.autoSelectFamily = false;
  } else if (typeof params.autoSelectFamily === "boolean") {
    connect.autoSelectFamily = params.autoSelectFamily;
    connect.autoSelectFamilyAttemptTimeout = TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS;
  }
  const lookup = createDnsResultOrderLookup(params.dnsResultOrder);
  if (lookup) {
    connect.lookup = lookup;
  }
  return Object.keys(connect).length > 0 ? connect : null;
}
function shouldBypassEnvProxyForTelegramApi(env = process.env) {
  const noProxyValue = env.no_proxy ?? env.NO_PROXY ?? "";
  if (!noProxyValue) {
    return false;
  }
  if (noProxyValue === "*") {
    return true;
  }
  const targetHostname = TELEGRAM_API_HOSTNAME.toLowerCase();
  const targetPort = 443;
  const noProxyEntries = noProxyValue.split(/[,\s]/);
  for (let i = 0; i < noProxyEntries.length; i++) {
    const entry = noProxyEntries[i];
    if (!entry) {
      continue;
    }
    const parsed = entry.match(/^(.+):(\d+)$/);
    const entryHostname = (parsed ? parsed[1] : entry).replace(/^\*?\./, "").toLowerCase();
    const entryPort = parsed ? Number.parseInt(parsed[2], 10) : 0;
    if (entryPort && entryPort !== targetPort) {
      continue;
    }
    if (targetHostname === entryHostname || targetHostname.slice(-(entryHostname.length + 1)) === `.${entryHostname}`) {
      return true;
    }
  }
  return false;
}
function hasEnvHttpProxyForTelegramApi(env = process.env) {
  return hasEnvHttpProxyConfigured("https", env);
}
function resolveTelegramDispatcherPolicy(params) {
  const connect = buildTelegramConnectOptions({
    autoSelectFamily: params.autoSelectFamily,
    dnsResultOrder: params.dnsResultOrder,
    forceIpv4: params.forceIpv4
  });
  const explicitProxyUrl = params.proxyUrl?.trim();
  if (explicitProxyUrl) {
    return {
      policy: connect ? {
        mode: "explicit-proxy",
        proxyUrl: explicitProxyUrl,
        proxyTls: { ...connect }
      } : {
        mode: "explicit-proxy",
        proxyUrl: explicitProxyUrl
      },
      mode: "explicit-proxy"
    };
  }
  if (params.useEnvProxy) {
    return {
      policy: {
        mode: "env-proxy",
        ...connect ? { connect: { ...connect }, proxyTls: { ...connect } } : {}
      },
      mode: "env-proxy"
    };
  }
  return {
    policy: {
      mode: "direct",
      ...connect ? { connect: { ...connect } } : {}
    },
    mode: "direct"
  };
}
function createTelegramDispatcher(policy) {
  if (policy.mode === "explicit-proxy") {
    const proxyOptions = policy.proxyTls ? {
      uri: policy.proxyUrl,
      proxyTls: { ...policy.proxyTls }
    } : policy.proxyUrl;
    try {
      return {
        dispatcher: new ProxyAgent(proxyOptions),
        mode: "explicit-proxy",
        effectivePolicy: policy
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`explicit proxy dispatcher init failed: ${reason}`, { cause: err });
    }
  }
  if (policy.mode === "env-proxy") {
    const proxyOptions = policy.connect || policy.proxyTls ? {
      ...policy.connect ? { connect: { ...policy.connect } } : {},
      // undici's EnvHttpProxyAgent passes `connect` only to the no-proxy Agent.
      // Real proxied HTTPS traffic reads transport settings from ProxyAgent.proxyTls.
      ...policy.proxyTls ? { proxyTls: { ...policy.proxyTls } } : {}
    } : void 0;
    try {
      return {
        dispatcher: new EnvHttpProxyAgent(proxyOptions),
        mode: "env-proxy",
        effectivePolicy: policy
      };
    } catch (err) {
      log.warn(
        `env proxy dispatcher init failed; falling back to direct dispatcher: ${err instanceof Error ? err.message : String(err)}`
      );
      const directPolicy = {
        mode: "direct",
        ...policy.connect ? { connect: { ...policy.connect } } : {}
      };
      return {
        dispatcher: new Agent(
          directPolicy.connect ? {
            connect: { ...directPolicy.connect }
          } : void 0
        ),
        mode: "direct",
        effectivePolicy: directPolicy
      };
    }
  }
  return {
    dispatcher: new Agent(
      policy.connect ? {
        connect: { ...policy.connect }
      } : void 0
    ),
    mode: "direct",
    effectivePolicy: policy
  };
}
function withDispatcherIfMissing(init, dispatcher) {
  const withDispatcher = init;
  if (withDispatcher?.dispatcher) {
    return init ?? {};
  }
  return init ? { ...init, dispatcher } : { dispatcher };
}
function resolveWrappedFetch(fetchImpl) {
  return resolveFetch(fetchImpl) ?? fetchImpl;
}
function logResolverNetworkDecisions(params) {
  if (params.autoSelectDecision.value !== null) {
    const sourceLabel = params.autoSelectDecision.source ? ` (${params.autoSelectDecision.source})` : "";
    log.info(`autoSelectFamily=${params.autoSelectDecision.value}${sourceLabel}`);
  }
  if (params.dnsDecision.value !== null) {
    const sourceLabel = params.dnsDecision.source ? ` (${params.dnsDecision.source})` : "";
    log.info(`dnsResultOrder=${params.dnsDecision.value}${sourceLabel}`);
  }
}
function collectErrorCodes(err) {
  const codes = /* @__PURE__ */ new Set();
  const queue = [err];
  const seen = /* @__PURE__ */ new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (typeof current === "object") {
      const code = current.code;
      if (typeof code === "string" && code.trim()) {
        codes.add(code.trim().toUpperCase());
      }
      const cause = current.cause;
      if (cause && !seen.has(cause)) {
        queue.push(cause);
      }
      const errors = current.errors;
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          if (nested && !seen.has(nested)) {
            queue.push(nested);
          }
        }
      }
    }
  }
  return codes;
}
function formatErrorCodes(err) {
  const codes = [...collectErrorCodes(err)];
  return codes.length > 0 ? codes.join(",") : "none";
}
function shouldRetryWithIpv4Fallback(err) {
  const ctx = {
    message: err && typeof err === "object" && "message" in err ? String(err.message).toLowerCase() : "",
    codes: collectErrorCodes(err)
  };
  for (const rule of IPV4_FALLBACK_RULES) {
    if (!rule.matches(ctx)) {
      return false;
    }
  }
  return true;
}
function shouldRetryTelegramIpv4Fallback(err) {
  return shouldRetryWithIpv4Fallback(err);
}
function resolveTelegramTransport(proxyFetch, options) {
  const autoSelectDecision = resolveTelegramAutoSelectFamilyDecision({
    network: options?.network
  });
  const dnsDecision = resolveTelegramDnsResultOrderDecision({
    network: options?.network
  });
  logResolverNetworkDecisions({
    autoSelectDecision,
    dnsDecision
  });
  const explicitProxyUrl = proxyFetch ? getProxyUrlFromFetch(proxyFetch) : void 0;
  const undiciSourceFetch = resolveWrappedFetch(undiciFetch);
  const sourceFetch = explicitProxyUrl ? undiciSourceFetch : proxyFetch ? resolveWrappedFetch(proxyFetch) : undiciSourceFetch;
  const dnsResultOrder = normalizeDnsResultOrder(dnsDecision.value);
  if (proxyFetch && !explicitProxyUrl) {
    return { fetch: sourceFetch, sourceFetch };
  }
  const useEnvProxy = !explicitProxyUrl && hasEnvHttpProxyForTelegramApi();
  const defaultDispatcherResolution = resolveTelegramDispatcherPolicy({
    autoSelectFamily: autoSelectDecision.value,
    dnsResultOrder,
    useEnvProxy,
    forceIpv4: false,
    proxyUrl: explicitProxyUrl
  });
  const defaultDispatcher = createTelegramDispatcher(defaultDispatcherResolution.policy);
  const shouldBypassEnvProxy = shouldBypassEnvProxyForTelegramApi();
  const allowStickyIpv4Fallback = defaultDispatcher.mode === "direct" || defaultDispatcher.mode === "env-proxy" && shouldBypassEnvProxy;
  const stickyShouldUseEnvProxy = defaultDispatcher.mode === "env-proxy";
  const fallbackPinnedDispatcherPolicy = allowStickyIpv4Fallback ? resolveTelegramDispatcherPolicy({
    autoSelectFamily: false,
    dnsResultOrder: "ipv4first",
    useEnvProxy: stickyShouldUseEnvProxy,
    forceIpv4: true,
    proxyUrl: explicitProxyUrl
  }).policy : void 0;
  let stickyIpv4FallbackEnabled = false;
  let stickyIpv4Dispatcher = null;
  const resolveStickyIpv4Dispatcher = () => {
    if (!stickyIpv4Dispatcher) {
      if (!fallbackPinnedDispatcherPolicy) {
        return defaultDispatcher.dispatcher;
      }
      stickyIpv4Dispatcher = createTelegramDispatcher(fallbackPinnedDispatcherPolicy).dispatcher;
    }
    return stickyIpv4Dispatcher;
  };
  const resolvedFetch = (async (input, init) => {
    const callerProvidedDispatcher = Boolean(
      init?.dispatcher
    );
    const initialInit = withDispatcherIfMissing(
      init,
      stickyIpv4FallbackEnabled ? resolveStickyIpv4Dispatcher() : defaultDispatcher.dispatcher
    );
    try {
      return await sourceFetch(input, initialInit);
    } catch (err) {
      if (shouldRetryWithIpv4Fallback(err)) {
        if (callerProvidedDispatcher) {
          return sourceFetch(input, init ?? {});
        }
        if (!allowStickyIpv4Fallback) {
          throw err;
        }
        if (!stickyIpv4FallbackEnabled) {
          stickyIpv4FallbackEnabled = true;
          log.warn(
            `fetch fallback: enabling sticky IPv4-only dispatcher (codes=${formatErrorCodes(err)})`
          );
        }
        return sourceFetch(input, withDispatcherIfMissing(init, resolveStickyIpv4Dispatcher()));
      }
      throw err;
    }
  });
  return {
    fetch: resolvedFetch,
    sourceFetch,
    pinnedDispatcherPolicy: defaultDispatcher.effectivePolicy,
    fallbackPinnedDispatcherPolicy
  };
}
function resolveTelegramFetch(proxyFetch, options) {
  return resolveTelegramTransport(proxyFetch, options).fetch;
}
export {
  resolveTelegramFetch,
  resolveTelegramTransport,
  shouldRetryTelegramIpv4Fallback
};
