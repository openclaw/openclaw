// Private QA runtime support for the Microsoft Teams live transport adapter.
import type { ClientOptions, RequestContext } from "@microsoft/teams.common";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { prepareMSTeamsConnectorRequest } from "../send-handoff.js";

const PRIVATE_QA_BUILD_ENV = "OPENCLAW_BUILD_PRIVATE_QA";
const PRIVATE_QA_NONCE_HEADER = "x-openclaw-msteams-qa-nonce";
const PRIVATE_QA_RUNTIME_SYMBOL = Symbol.for("openclaw.msteams.privateQaRuntime");

type PrivateQaEnv = Partial<Record<typeof PRIVATE_QA_BUILD_ENV, string>>;

type PrivateQaBootstrap = {
  connectorUrl?: string;
  nonce?: string;
  botToken?: string;
};

function createPrivateQaClientOptions(connectorUrl: string, nonce: string): ClientOptions {
  const request = async (config: RequestContext["config"]) => {
    const sourceUrl = new URL(config.url ?? "", "https://smba.trafficmanager.net");
    const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, connectorUrl);
    const headers = new Headers();
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      if (value != null) {
        headers.set(key, String(value));
      }
    }
    headers.set(PRIVATE_QA_NONCE_HEADER, nonce);
    const method = String(config.method ?? "GET").toUpperCase();
    const assertCurrent = await prepareMSTeamsConnectorRequest();
    const { response, release } = await fetchWithSsrFGuard({
      url: targetUrl.toString(),
      init: {
        method,
        headers,
        body:
          method === "GET" || method === "HEAD" || config.data == null
            ? undefined
            : typeof config.data === "string"
              ? config.data
              : JSON.stringify(config.data),
      },
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(targetUrl.toString()),
      maxRedirects: 0,
      auditContext: "msteams-private-qa-connector",
      beforeRequest: assertCurrent,
    });
    try {
      const text = await response.text();
      const data: unknown = text ? JSON.parse(text) : undefined;
      if (!response.ok) {
        throw Object.assign(
          new Error(`Microsoft Teams private QA connector returned HTTP ${response.status}`),
          { statusCode: response.status },
        );
      }
      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        config,
      };
    } finally {
      await release();
    }
  };
  return {
    interceptors: [
      {
        request: ({ config }) => {
          // The SDK owns token resolution, middleware and clones; only the transport is private QA.
          config.adapter = request;
          return config;
        },
      },
    ],
  };
}

type MSTeamsPrivateQaRuntime = {
  client: ClientOptions;
  listenHost: "127.0.0.1";
  skipAuth: true;
  token: () => Promise<string>;
};

export function resolveMSTeamsPrivateQaRuntime(
  env: PrivateQaEnv = process.env,
  bootstrap: PrivateQaBootstrap | undefined = (
    globalThis as typeof globalThis & {
      [PRIVATE_QA_RUNTIME_SYMBOL]?: PrivateQaBootstrap;
    }
  )[PRIVATE_QA_RUNTIME_SYMBOL],
): MSTeamsPrivateQaRuntime | undefined {
  if (!bootstrap) {
    return undefined;
  }
  if (env[PRIVATE_QA_BUILD_ENV] !== "1") {
    throw new Error("Microsoft Teams private QA runtime requires OPENCLAW_BUILD_PRIVATE_QA=1");
  }
  const connectorUrl = bootstrap.connectorUrl?.trim();
  const nonce = bootstrap.nonce?.trim();
  const botToken = bootstrap.botToken?.trim();
  if (!connectorUrl || !nonce || !botToken) {
    throw new Error(
      "Microsoft Teams private QA bootstrap requires connector URL, nonce, and bot token",
    );
  }
  const parsedConnectorUrl = new URL(connectorUrl);
  if (
    parsedConnectorUrl.protocol !== "http:" ||
    (parsedConnectorUrl.hostname !== "127.0.0.1" && parsedConnectorUrl.hostname !== "localhost")
  ) {
    throw new Error("Microsoft Teams private QA connector must use loopback HTTP");
  }
  const client = createPrivateQaClientOptions(parsedConnectorUrl.toString(), nonce);
  return {
    client,
    listenHost: "127.0.0.1",
    skipAuth: true,
    token: async () => botToken,
  };
}
