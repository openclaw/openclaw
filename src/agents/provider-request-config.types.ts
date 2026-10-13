import type { ConfiguredModelProviderRequest } from "../config/types.provider-request.js";

/** Auth override accepted from sanitized provider/model request config. */
export type ProviderRequestAuthOverride =
  | {
      mode: "provider-default";
    }
  | {
      mode: "authorization-bearer";
      token: string;
    }
  | {
      mode: "header";
      headerName: string;
      value: string;
      prefix?: string;
    };

/** TLS override accepted from sanitized provider/model request config. */
export type ProviderRequestTlsOverride = {
  ca?: string;
  cert?: string;
  key?: string;
  passphrase?: string;
  serverName?: string;
  insecureSkipVerify?: boolean;
};

/** Proxy override accepted from sanitized provider/model request config. */
export type ProviderRequestProxyOverride =
  | {
      mode: "env-proxy";
      tls?: ProviderRequestTlsOverride;
    }
  | {
      mode: "explicit-proxy";
      url: string;
      tls?: ProviderRequestTlsOverride;
    };

export type ProviderRequestTransportOverrides = {
  headers?: Record<string, string>;
  auth?: ProviderRequestAuthOverride;
  proxy?: ProviderRequestProxyOverride;
  tls?: ProviderRequestTlsOverride;
};

/** Rate-limit override accepted from sanitized provider/model request config. */
export type ProviderRequestRateLimitOverride = NonNullable<
  ConfiguredModelProviderRequest["rateLimit"]
>;

export type ModelProviderRequestTransportOverrides = ProviderRequestTransportOverrides & {
  allowPrivateNetwork?: boolean;
  rateLimit?: ProviderRequestRateLimitOverride;
};
