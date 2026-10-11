import { asNonArrayRecord, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { ocPathSegment } from "./policy-state-helpers.js";
import type { PolicyGatewayExposureEvidence } from "./policy-state-types.js";

export function scanPolicyGatewayExposure(
  cfg: Record<string, unknown>,
): readonly PolicyGatewayExposureEvidence[] {
  const gateway = asNonArrayRecord(cfg.gateway);
  const entries: PolicyGatewayExposureEvidence[] = [];
  const bind = typeof gateway.bind === "string" ? gateway.bind : undefined;
  const customBindHost =
    typeof gateway.customBindHost === "string" ? gateway.customBindHost : undefined;
  const hasCustomBindHost = customBindHost !== undefined && customBindHost.trim() !== "";
  const tailscale = asNonArrayRecord(gateway.tailscale);
  const tailscaleForcesLoopback = tailscale.mode === "serve" || tailscale.mode === "funnel";
  entries.push({
    id: bind === undefined ? "gateway-bind-default" : "gateway-bind",
    kind: "bind",
    source: "oc://openclaw.config/gateway/bind",
    value: bind ?? (tailscaleForcesLoopback ? "loopback" : "runtime-default"),
    nonLoopback:
      bind === undefined
        ? !tailscaleForcesLoopback
        : bind === "custom"
          ? false
          : isGatewayNonLoopbackBind(bind),
    explicit: bind !== undefined,
  });
  if (bind === "custom" && hasCustomBindHost) {
    entries.push({
      id: "gateway-custom-bind-host",
      kind: "bind",
      source: "oc://openclaw.config/gateway/customBindHost",
      value: customBindHost,
      nonLoopback: isRuntimeNonLoopbackCustomBindHost(customBindHost),
    });
  }

  const auth = asNonArrayRecord(gateway.auth);
  entries.push({
    id: "gateway-auth-mode",
    kind: "auth",
    source: "oc://openclaw.config/gateway/auth/mode",
    value: typeof auth.mode === "string" ? auth.mode : "token",
    explicit: typeof auth.mode === "string",
  });
  entries.push({
    id: "gateway-auth-rate-limit",
    kind: "authRateLimit",
    source: "oc://openclaw.config/gateway/auth/rateLimit",
    value: isRecord(auth.rateLimit),
    explicit: isRecord(auth.rateLimit),
  });

  const controlUi = asNonArrayRecord(gateway.controlUi);
  for (const [suffix, value, source] of [
    ["enabled", controlUi.enabled, "oc://openclaw.config/gateway/controlUi/enabled"],
    ["insecure-auth", false, "oc://openclaw.invariant/gateway/controlUi/deviceIdentity"],
    ["device-auth-disabled", false, "oc://openclaw.invariant/gateway/controlUi/deviceIdentity"],
    [
      "host-origin-fallback",
      controlUi.dangerouslyAllowHostHeaderOriginFallback,
      "oc://openclaw.config/gateway/controlUi/dangerouslyAllowHostHeaderOriginFallback",
    ],
  ] as const) {
    if (typeof value === "boolean") {
      entries.push({ id: `gateway-control-ui-${suffix}`, kind: "controlUi", source, value });
    }
  }

  if (typeof tailscale.mode === "string") {
    entries.push({
      id: "gateway-tailscale-mode",
      kind: "tailscale",
      source: "oc://openclaw.config/gateway/tailscale/mode",
      value: tailscale.mode,
    });
  }
  if (tailscale.mode === "serve" && tailscale.preserveFunnel === true) {
    entries.push({
      id: "gateway-tailscale-preserve-funnel",
      kind: "tailscale",
      source: "oc://openclaw.config/gateway/tailscale/preserveFunnel",
      value: "funnel",
    });
  }

  const remote = asNonArrayRecord(gateway.remote);
  if (gateway.mode === "remote") {
    entries.push({
      id: "gateway-mode-remote",
      kind: "remote",
      source: "oc://openclaw.config/gateway/mode",
      value: "remote",
    });
    if (typeof remote.url === "string" && remote.url.trim() !== "") {
      entries.push({
        id: "gateway-remote-url",
        kind: "remote",
        source: "oc://openclaw.config/gateway/remote/url",
        value: true,
      });
    }
  }

  const http = asNonArrayRecord(gateway.http);
  const endpoints = asNonArrayRecord(http.endpoints);
  pushGatewayHttpEndpointEvidence(entries, endpoints, "chatCompletions");
  pushGatewayHttpEndpointEvidence(entries, endpoints, "responses");
  const nodes = asNonArrayRecord(gateway.nodes);
  pushGatewayNodeCommandEvidence(entries, nodes);
  return entries.toSorted((a, b) => a.source.localeCompare(b.source));
}

function pushGatewayHttpEndpointEvidence(
  entries: PolicyGatewayExposureEvidence[],
  endpoints: Record<string, unknown>,
  endpoint: "chatCompletions" | "responses",
): void {
  const config = endpoints[endpoint];
  if (!isRecord(config) || config.enabled !== true) {
    return;
  }
  const source = `oc://openclaw.config/gateway/http/endpoints/${endpoint}`;
  entries.push({
    id: `gateway-http-${endpoint}`,
    kind: "httpEndpoint",
    source: `${source}/enabled`,
    value: true,
    endpoint,
  });
  for (const input of endpoint === "chatCompletions" ? ["images"] : ["files", "images"]) {
    pushGatewayHttpUrlFetchEvidence(entries, source, endpoint, input, config[input]);
  }
}

function pushGatewayHttpUrlFetchEvidence(
  entries: PolicyGatewayExposureEvidence[],
  endpointSource: string,
  endpoint: string,
  input: string,
  value: unknown,
): void {
  const allowUrl = isRecord(value) ? value.allowUrl : undefined;
  if (allowUrl === false || (allowUrl !== true && endpoint !== "responses")) {
    return;
  }
  const allowlist = isRecord(value) ? value.urlAllowlist : undefined;
  const hasEffectiveAllowlist =
    Array.isArray(allowlist) &&
    allowlist.some((entry) => isEffectiveGatewayUrlAllowlistEntry(entry));
  entries.push({
    id: `gateway-http-${endpoint}-${input}-url-fetch`,
    kind: "httpUrlFetch",
    source: `${endpointSource}/${ocPathSegment(input)}/allowUrl`,
    value: true,
    endpoint,
    explicit: allowUrl === true,
    hasAllowlist: hasEffectiveAllowlist,
  });
}

function pushGatewayNodeCommandEvidence(
  entries: PolicyGatewayExposureEvidence[],
  nodes: Record<string, unknown>,
): void {
  const commands = isRecord(nodes.commands) ? nodes.commands : null;
  const deniedCommands = new Set<string>();
  for (const [list, kind, idPrefix] of [
    ["deny", "nodeDenyCommand", "gateway-node-deny-command"],
    ["allow", "nodeCommand", "gateway-node-command"],
  ] as const) {
    const values = commands?.[list];
    if (!Array.isArray(values)) {
      continue;
    }
    values.forEach((command, index) => {
      if (typeof command !== "string") {
        return;
      }
      const normalized = command.trim();
      if (normalized === "" || (list === "allow" && deniedCommands.has(normalized))) {
        return;
      }
      if (list === "deny") {
        deniedCommands.add(normalized);
      }
      entries.push({
        id: `${idPrefix}-${normalized}`,
        kind,
        source: `oc://openclaw.config/gateway/nodes/commands/${list}/#${index}`,
        value: normalized,
        command: normalized,
      });
    });
  }
}

function isEffectiveGatewayUrlAllowlistEntry(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "*" && normalized !== "*.";
}

function isGatewayNonLoopbackBind(value: string): boolean {
  return value === "auto" || value === "lan" || value === "custom" || value === "tailnet";
}

function isRuntimeNonLoopbackCustomBindHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return isCanonicalDottedDecimalIPv4(normalized) && !normalized.startsWith("127.");
}

function isCanonicalDottedDecimalIPv4(value: string): boolean {
  return /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(
    value,
  );
}
