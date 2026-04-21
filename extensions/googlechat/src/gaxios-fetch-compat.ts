import { createRequire } from "node:module";
import type { ConnectionOptions } from "node:tls";
import { pathToFileURL } from "node:url";
import type { Dispatcher } from "undici";

type ProxyRule = RegExp | URL | string;
type TlsCert = ConnectionOptions["cert"];
type TlsKey = ConnectionOptions["key"];
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type GaxiosFetchRequestInit = RequestInit & {
  agent?: unknown;
  cert?: TlsCert;
  dispatcher?: Dispatcher;
  fetchImplementation?: FetchLike;
  key?: TlsKey;
  noProxy?: ProxyRule[];
  proxy?: string | URL;
};

type ProxyAgentLike = {
  connectOpts?: { cert?: TlsCert; key?: TlsKey };
  proxy: URL;
};

type TlsAgentLike = {
  options?: { cert?: TlsCert; key?: TlsKey };
};

type GaxiosPrototype = {
  _defaultAdapter: (this: unknown, config: GaxiosFetchRequestInit) => Promise<unknown>;
};

type GaxiosConstructor = {
  prototype: GaxiosPrototype;
};

const TEST_GAXIOS_CONSTRUCTOR_OVERRIDE = "__OPENCLAW_TEST_GAXIOS_CONSTRUCTOR__";

let installState: "not-installed" | "installing" | "shimmed" | "installed" = "not-installed";

type UndiciRuntimeDeps = {
  UndiciAgent: typeof import("undici").Agent;
  ProxyAgent: typeof import("undici").ProxyAgent;
};

function asNullableObjectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function hasDispatcher(value: unknown): value is Dispatcher {
  const record = asNullableObjectRecord(value);
  return record !== null && typeof record.dispatch === "function";
}

function hasProxyAgentShape(value: unknown): value is ProxyAgentLike {
  const record = asNullableObjectRecord(value);
  return record !== null && record.proxy instanceof URL;
}

function hasTlsAgentShape(value: unknown): value is TlsAgentLike {
  const record = asNullableObjectRecord(value);
  return record !== null && asNullableObjectRecord(record.options) !== null;
}

function resolveTlsOptions(
  init: GaxiosFetchRequestInit,
  url: URL,
): { cert?: TlsCert; key?: TlsKey } {
  const explicit = {
    cert: init.cert,
    key: init.key,
  };
  if (explicit.cert !== undefined || explicit.key !== undefined) {
    return explicit;
  }

  const agent = typeof init.agent === "function" ? init.agent(url) : init.agent;
  if (hasProxyAgentShape(agent)) {
    return {
      cert: agent.connectOpts?.cert,
      key: agent.connectOpts?.key,
    };
  }
  if (hasTlsAgentShape(agent)) {
    return {
      cert: agent.options?.cert,
      key: agent.options?.key,
    };
  }
  return {};
}

function urlMayUseProxy(url: URL, noProxy: ProxyRule[] = []): boolean {
  const rules = [...noProxy];
  const envRules = (process.env.NO_PROXY ?? process.env.no_proxy)?.split(",") ?? [];
  for (const rule of envRules) {
    const trimmed = rule.trim();
    if (trimmed.length > 0) {
      rules.push(trimmed);
    }
  }

  for (const rule of rules) {
    if (rule instanceof RegExp) {
      if (rule.test(url.toString())) {
        return false;
      }
      continue;
    }
    if (rule instanceof URL) {
      if (rule.origin === url.origin) {
        return false;
      }
      continue;
    }
    if (rule.startsWith("*.") || rule.startsWith(".")) {
      const cleanedRule = rule.replace(/^\*\./, ".");
      if (url.hostname.endsWith(cleanedRule)) {
        return false;
      }
      continue;
    }
    if (rule === url.origin || rule === url.hostname || rule === url.href) {
      return false;
    }
  }

  return true;
}

function resolveProxyUri(init: GaxiosFetchRequestInit, url: URL): string | undefined {
  if (init.proxy) {
    const proxyUri = String(init.proxy);
    return urlMayUseProxy(url, init.noProxy) ? proxyUri : undefined;
  }

  const envProxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!envProxy) {
    return undefined;
  }

  return urlMayUseProxy(url, init.noProxy) ? envProxy : undefined;
}

function loadUndiciRuntimeDeps(): UndiciRuntimeDeps {
  const require = createRequire(import.meta.url);
  const undici = require("undici") as typeof import("undici");
  return {
    ProxyAgent: undici.ProxyAgent,
    UndiciAgent: undici.Agent,
  };
}

function buildDispatcher(init: GaxiosFetchRequestInit, url: URL): Dispatcher | undefined {
  if (init.dispatcher) {
    return init.dispatcher;
  }

  const agent = typeof init.agent === "function" ? init.agent(url) : init.agent;
  if (hasDispatcher(agent)) {
    return agent;
  }

  const { cert, key } = resolveTlsOptions(init, url);
  const proxyUri =
    resolveProxyUri(init, url) ?? (hasProxyAgentShape(agent) ? String(agent.proxy) : undefined);
  if (proxyUri) {
    const { ProxyAgent } = loadUndiciRuntimeDeps();
    return new ProxyAgent({
      requestTls: cert !== undefined || key !== undefined ? { cert, key } : undefined,
      uri: proxyUri,
    });
  }

  if (cert !== undefined || key !== undefined) {
    const { UndiciAgent } = loadUndiciRuntimeDeps();
    return new UndiciAgent({
      connect: { cert, key },
    });
  }

  return undefined;
}

function isModuleNotFoundError(err: unknown): err is NodeJS.ErrnoException {
  const record = asNullableObjectRecord(err);
  return (
    record !== null &&
    (record.code === "ERR_MODULE_NOT_FOUND" || record.code === "MODULE_NOT_FOUND")
  );
}

function hasGaxiosConstructorShape(value: unknown): value is GaxiosConstructor {
  return (
    typeof value === "function" &&
    "prototype" in value &&
    asNullableObjectRecord(value.prototype) !== null &&
    typeof value.prototype._defaultAdapter === "function"
  );
}

function getTestGaxiosConstructorOverride(): GaxiosConstructor | null | undefined {
  const testGlobal = globalThis as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(testGlobal, TEST_GAXIOS_CONSTRUCTOR_OVERRIDE)) {
    return undefined;
  }
  const override = testGlobal[TEST_GAXIOS_CONSTRUCTOR_OVERRIDE];
  if (override === null) {
    return null;
  }
  if (hasGaxiosConstructorShape(override)) {
    return override;
  }
  throw new Error("invalid gaxios test constructor override");
}

function isDirectGaxiosImportMiss(err: unknown): boolean {
  if (!isModuleNotFoundError(err)) {
    return false;
  }
  return (
    typeof err.message === "string" &&
    (err.message.includes("Cannot find package 'gaxios'") ||
      err.message.includes("Cannot find module 'gaxios'"))
  );
}

async function loadGaxiosConstructor(): Promise<GaxiosConstructor | null> {
  const testOverride = getTestGaxiosConstructorOverride();
  if (testOverride !== undefined) {
    return testOverride;
  }

  try {
    const require = createRequire(import.meta.url);
    const resolvedPath = require.resolve("gaxios");
    const mod = await import(pathToFileURL(resolvedPath).href);
    const candidate = asNullableObjectRecord(mod)?.Gaxios;
    if (!hasGaxiosConstructorShape(candidate)) {
      throw new Error("gaxios: missing Gaxios export");
    }
    return candidate;
  } catch (err) {
    if (isDirectGaxiosImportMiss(err)) {
      return null;
    }
    throw err;
  }
}

function installLegacyWindowFetchShim(): void {
  if (
    typeof globalThis.fetch !== "function" ||
    typeof (globalThis as Record<string, unknown>).window !== "undefined"
  ) {
    return;
  }
  (globalThis as Record<string, unknown>).window = { fetch: globalThis.fetch };
}

export function createGaxiosCompatFetch(
  baseFetch: FetchLike = globalThis.fetch.bind(globalThis),
): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const gaxiosInit = (init ?? {}) as GaxiosFetchRequestInit;
    const requestUrl =
      input instanceof Request
        ? new URL(input.url)
        : new URL(typeof input === "string" ? input : input.toString());
    const dispatcher = buildDispatcher(gaxiosInit, requestUrl);

    const nextInit: RequestInit = { ...gaxiosInit };
    delete (nextInit as GaxiosFetchRequestInit).agent;
    delete (nextInit as GaxiosFetchRequestInit).cert;
    delete (nextInit as GaxiosFetchRequestInit).fetchImplementation;
    delete (nextInit as GaxiosFetchRequestInit).key;
    delete (nextInit as GaxiosFetchRequestInit).noProxy;
    delete (nextInit as GaxiosFetchRequestInit).proxy;

    if (dispatcher) {
      (nextInit as RequestInit & { dispatcher: Dispatcher }).dispatcher = dispatcher;
    }

    return baseFetch(input, nextInit);
  };
}

export async function installGoogleAuthGaxiosFetchCompat(): Promise<void> {
  if (installState !== "not-installed" || typeof globalThis.fetch !== "function") {
    return;
  }

  installState = "installing";

  try {
    const Gaxios = await loadGaxiosConstructor();
    if (!Gaxios) {
      installLegacyWindowFetchShim();
      installState = "shimmed";
      return;
    }

    const prototype = Gaxios.prototype;
    const originalDefaultAdapter = prototype._defaultAdapter;
    const compatFetch = createGaxiosCompatFetch();

    prototype._defaultAdapter = function patchedDefaultAdapter(
      this: unknown,
      config: GaxiosFetchRequestInit,
    ): Promise<unknown> {
      if (config.fetchImplementation) {
        return originalDefaultAdapter.call(this, config);
      }
      return originalDefaultAdapter.call(this, {
        ...config,
        fetchImplementation: compatFetch,
      });
    };

    installState = "installed";
  } catch (err) {
    installState = "not-installed";
    throw err;
  }
}

export const __testing = {
  resetGoogleAuthGaxiosFetchCompatForTests(): void {
    installState = "not-installed";
  },
};
