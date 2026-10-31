import type { ModelRequestHeaders } from "../llm/types.js";

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
  headers?: ModelRequestHeaders;
  auth?: ProviderRequestAuthOverride;
  proxy?: ProviderRequestProxyOverride;
  tls?: ProviderRequestTlsOverride;
};

export type ModelProviderRequestTransportOverrides = ProviderRequestTransportOverrides & {
  allowPrivateNetwork?: boolean;
};
