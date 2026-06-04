import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  OLLAMA_LOCAL_AUTH_MARKER,
  isNonSecretApiKeyMarker,
} from "./model-auth-markers.js";

const LOCAL_AUTH_MARKER_PROVIDER_APIS = new Set([
  "ollama",
  "openai-completions",
  "openai-responses",
]);

export function isLocalApiKeyMarker(apiKey: string): boolean {
  const marker = apiKey.trim();
  return (
    marker === CUSTOM_LOCAL_AUTH_MARKER ||
    (!marker.includes(":") && marker.endsWith("-local") && isNonSecretApiKeyMarker(marker))
  );
}

export function isUsableLocalAuthMarker(params: {
  api?: unknown;
  apiKey: string;
  baseUrl?: unknown;
}): boolean {
  const api = typeof params.api === "string" ? params.api.trim() : "";
  return (
    isLocalApiKeyMarker(params.apiKey) &&
    LOCAL_AUTH_MARKER_PROVIDER_APIS.has(api) &&
    typeof params.baseUrl === "string" &&
    (isLocalBaseUrl(params.baseUrl) ||
      (api === "ollama" &&
        params.apiKey.trim() === OLLAMA_LOCAL_AUTH_MARKER &&
        isOllamaServiceAliasBaseUrl(params.baseUrl)))
  );
}

export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    let host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "::" ||
      host === "::ffff:7f00:1" ||
      host === "::ffff:127.0.0.1" ||
      host === "docker.orb.internal" ||
      host === "host.docker.internal" ||
      host === "host.orb.internal" ||
      host.endsWith(".local") ||
      isPrivateIpv4Host(host) ||
      isLocalIpv6Host(host)
    );
  } catch {
    return false;
  }
}

function isPrivateIpv4Host(host: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return false;
  }
  const octets = host.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isLocalIpv6Host(host: string): boolean {
  return /^fe[89ab][0-9a-f]:/.test(host) || /^f[cd][0-9a-f]{2}:/.test(host);
}

function isOllamaServiceAliasBaseUrl(baseUrl: string): boolean {
  try {
    let host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
    if (host.startsWith("[") && host.endsWith("]")) {
      host = host.slice(1, -1);
    }
    return host === "ollama";
  } catch {
    return false;
  }
}
