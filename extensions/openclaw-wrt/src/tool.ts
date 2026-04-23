import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { optionalStringEnum, stringEnum } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { ClawWRTBridge, DeviceSnapshot } from "./manager.js";
import {
  PORTAL_TEMPLATE_VALUES,
  renderPortalPageHtml,
  type PortalContent as PortalContentType,
  type PortalTemplate as PortalTemplateType,
} from "./portal-page-renderer.js";

type JsonRecord = Record<string, unknown>;

function asObject(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function getClientsFromResponse(response: JsonRecord): unknown[] {
  if (Array.isArray(response.clients)) {
    return response.clients;
  }
  const data = asObject(response.data);
  return Array.isArray(data?.clients) ? data.clients : [];
}

function redactFrpsConfigContent(configContent: string): string {
  return configContent.replace(/^(auth\.token\s*=\s*).+$/gim, '$1"[REDACTED]"');
}

const DeviceIdField = Type.String({
  minLength: 1,
  description: "Target openclaw-wrt device_id.",
});
const TimeoutField = Type.Optional(
  Type.Integer({
    minimum: 1000,
    maximum: 120_000,
    description: "Request timeout in milliseconds.",
  }),
);

const GenericToolSchema = Type.Object(
  {
    action: stringEnum(["list_devices", "get_device", "call"] as const, {
      description: "Action to perform: list_devices, get_device, or call.",
    }),
    deviceId: Type.Optional(DeviceIdField),
    op: Type.Optional(
      Type.String({ minLength: 1, description: "Exact openclaw-wrt operation name." }),
    ),
    payload: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Additional JSON fields to include with the device request.",
      }),
    ),
    timeoutMs: TimeoutField,
    expectResponse: Type.Optional(
      Type.Boolean({ description: "Override whether the request waits for a response." }),
    ),
  },
  { additionalProperties: false },
);

const DeviceOnlySchema = Type.Object(
  {
    deviceId: DeviceIdField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const ClientInfoSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    clientMac: Type.String({ minLength: 1, description: "Client MAC address." }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const AuthClientSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    clientMac: Type.String({ minLength: 1, description: "Client MAC address to authorize." }),
    clientIp: Type.String({ minLength: 1, description: "Client IP address to authorize." }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const KickoffClientSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    clientMac: Type.String({ minLength: 1, description: "Client MAC address to disconnect." }),
    clientIp: Type.Optional(
      Type.String({ minLength: 1, description: "Client IPv4 address if already known." }),
    ),
    gwId: Type.Optional(Type.String({ minLength: 1, description: "Gateway ID if already known." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const WifiConfigDataField = Type.Object(
  {
    ssid: Type.Optional(
      Type.String({ minLength: 1, description: "Wi-Fi SSID (network name) to set." }),
    ),
    radio: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Radio interface name (e.g., 'radio0', 'radio1').",
      }),
    ),
    interface: Type.Optional(
      Type.String({ minLength: 1, description: "Wireless interface name (e.g., 'wifnet0')." }),
    ),
    encryption: Type.Optional(
      Type.String({ description: "Encryption type (e.g., 'psk2', 'none')." }),
    ),
    key: Type.Optional(Type.String({ description: "Wi-Fi password/key." })),
    hidden: Type.Optional(Type.Boolean({ description: "Whether to hide the SSID." })),
  },
  { additionalProperties: true, description: "Wi-Fi configuration fields to update." },
);

const SetWifiInfoSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    data: WifiConfigDataField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetAuthServerSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    hostname: Type.String({ minLength: 1, description: "Authentication server hostname." }),
    port: Type.Optional(Type.String({ minLength: 1, description: "Authentication server port." })),
    path: Type.Optional(Type.String({ minLength: 1, description: "Authentication server path." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const PortalTemplateField = stringEnum(PORTAL_TEMPLATE_VALUES, {
  description:
    "Portal page template. default:通用弹出页, welcome:品牌承接/品宣, business:企业/办公网络, cafe:餐饮场景, hotel:酒店宾客, terms:条款确认, voucher:券码口令输入, event:活动推广页. 不明确时默认用 default.",
});

const PortalContentSchema = Type.Object(
  {
    brandName: Type.Optional(Type.String({ minLength: 1, description: "Brand or venue name." })),
    networkName: Type.Optional(Type.String({ minLength: 1, description: "Wi-Fi network name." })),
    venueName: Type.Optional(Type.String({ minLength: 1, description: "Venue or location name." })),
    title: Type.Optional(Type.String({ minLength: 1, description: "Primary page title." })),
    body: Type.Optional(Type.String({ minLength: 1, description: "Primary supporting copy." })),
    buttonText: Type.Optional(Type.String({ minLength: 1, description: "Primary action label." })),
    footerText: Type.Optional(Type.String({ minLength: 1, description: "Footer support text." })),
    supportText: Type.Optional(
      Type.String({ minLength: 1, description: "Additional helper copy." }),
    ),
    voucherLabel: Type.Optional(
      Type.String({ minLength: 1, description: "Voucher or code field label." }),
    ),
    voucherHint: Type.Optional(
      Type.String({ minLength: 1, description: "Voucher input hint text." }),
    ),
    rules: Type.Optional(Type.Array(Type.String({ minLength: 1, description: "Rule item." }))),
    accentColor: Type.Optional(Type.String({ minLength: 1, description: "Primary accent color." })),
  },
  { additionalProperties: false },
);

const PublishPortalPageSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    html: Type.Optional(
      Type.String({ minLength: 1, description: "Optional complete portal HTML content." }),
    ),
    template: Type.Optional(PortalTemplateField),
    content: Type.Optional(PortalContentSchema),
    pageName: Type.Optional(
      Type.String({ minLength: 1, description: "Optional HTML file name for the portal page." }),
    ),
    webRoot: Type.Optional(
      Type.String({ minLength: 1, description: "Optional nginx web root override." }),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const GeneratePortalPageSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    template: Type.Optional(PortalTemplateField),
    content: Type.Optional(PortalContentSchema),
    pageName: Type.Optional(
      Type.String({ minLength: 1, description: "Optional HTML file name for the portal page." }),
    ),
    webRoot: Type.Optional(
      Type.String({ minLength: 1, description: "Optional nginx web root override." }),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetMqttServerSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    hostname: Type.Optional(Type.String({ minLength: 1, description: "MQTT server hostname." })),
    port: Type.Optional(Type.String({ minLength: 1, description: "MQTT server port." })),
    username: Type.Optional(Type.String({ minLength: 1, description: "MQTT username." })),
    password: Type.Optional(Type.String({ minLength: 1, description: "MQTT password." })),
    useSsl: Type.Optional(Type.Boolean({ description: "Whether to enable MQTT TLS/SSL." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetWebsocketServerSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    hostname: Type.Optional(
      Type.String({ minLength: 1, description: "WebSocket server hostname." }),
    ),
    port: Type.Optional(Type.String({ minLength: 1, description: "WebSocket server port." })),
    path: Type.Optional(Type.String({ minLength: 1, description: "WebSocket path (e.g., /ws)." })),
    useSsl: Type.Optional(Type.Boolean({ description: "Whether to enable WSS." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const WireguardInterfaceSchema = Type.Object(
  {
    privateKey: Type.Optional(
      Type.String({ minLength: 1, description: "WireGuard private key (maps to private_key)." }),
    ),
    listenPort: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 65535,
        description: "WireGuard listen port (maps to listen_port).",
      }),
    ),
    addresses: Type.Optional(
      Type.Array(
        Type.String({ minLength: 1, description: "Tunnel address CIDR, e.g. 10.0.0.1/24." }),
      ),
    ),
    mtu: Type.Optional(Type.Integer({ minimum: 68, maximum: 9000 })),
    fwmark: Type.Optional(Type.String({ minLength: 1 })),
  },
  {
    additionalProperties: true,
    description: "WireGuard interface settings for wg0.",
  },
);

const WireguardPeerSchema = Type.Object(
  {
    publicKey: Type.Optional(
      Type.String({ minLength: 1, description: "Peer public key (maps to public_key)." }),
    ),
    presharedKey: Type.Optional(
      Type.String({ minLength: 1, description: "Peer PSK (maps to preshared_key)." }),
    ),
    allowedIps: Type.Optional(
      Type.Array(
        Type.String({ minLength: 1, description: "Allowed CIDR list (maps to allowed_ips)." }),
      ),
    ),
    endpointHost: Type.Optional(Type.String({ minLength: 1, description: "Peer endpoint host." })),
    endpointPort: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 65535, description: "Peer endpoint port." }),
    ),
    persistentKeepalive: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 65535,
        description: "Keepalive interval seconds (maps to persistent_keepalive).",
      }),
    ),
    routeAllowedIps: Type.Optional(
      Type.Boolean({
        description:
          "Whether netifd should auto-create kernel routes from AllowedIPs (maps to route_allowed_ips). Set to false when managing routes explicitly via set_vpn_routes.",
      }),
    ),
  },
  {
    additionalProperties: true,
    description: "One WireGuard peer section for wireguard_wg0.",
  },
);

const SetWireguardVpnSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    interface: WireguardInterfaceSchema,
    peers: Type.Optional(Type.Array(WireguardPeerSchema)),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);
const JsonObjectField = Type.Record(Type.String(), Type.Unknown(), {
  description: "Arbitrary JSON object payload.",
});

const StringArrayField = Type.Array(Type.String({ minLength: 1 }));
const BandField = optionalStringEnum(["2g", "5g"] as const, {
  description: "Wi-Fi band to scan: 2g or 5g.",
});
const BpfTableField = stringEnum(["ipv4", "ipv6", "mac"] as const, {
  description: "BPF table to target: ipv4, ipv6, or mac.",
});
const BpfJsonTableField = stringEnum(["ipv4", "ipv6", "mac", "sid", "l7"] as const, {
  description: "BPF JSON table to query: ipv4, ipv6, mac, sid, or l7.",
});

const UpdateDeviceInfoSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    deviceInfo: JsonObjectField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const TmpPassSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    clientMac: Type.String({
      minLength: 1,
      description: "Client MAC address to temporarily allow.",
    }),
    timeout: Type.Optional(
      Type.Integer({ minimum: 1, description: "Temporary allow duration in seconds." }),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const ScanWifiSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    band: BandField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetWifiRelaySchema = Type.Object(
  {
    deviceId: DeviceIdField,
    ssid: Type.String({ minLength: 1 }),
    key: Type.Optional(Type.String()),
    band: BandField,
    encryption: Type.Optional(Type.String()),
    bssid: Type.Optional(Type.String()),
    apply: Type.Optional(Type.Boolean()),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const DomainSyncSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    domains: StringArrayField,
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const TrustedMacSyncSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    macs: StringArrayField,
    values: Type.Optional(StringArrayField),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const FirmwareUpgradeSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    url: Type.String({ minLength: 1, description: "Firmware image URL." }),
    force: Type.Optional(Type.Boolean({ description: "Force upgrade." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const DeleteWifiRelaySchema = Type.Object(
  {
    deviceId: DeviceIdField,
    apply: Type.Optional(Type.Boolean({ description: "Apply changes immediately." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const ShellCommandSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    command: Type.String({ minLength: 1, maxLength: 4096 }),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 120,
        description: "Device-side shell execution timeout in seconds.",
      }),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfAddSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    address: Type.String({
      minLength: 1,
      description: "IPv4, IPv6, or MAC target to add to BPF monitoring.",
    }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfJsonSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfJsonTableField),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfDeleteSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    address: Type.String({
      minLength: 1,
      description: "IPv4, IPv6, or MAC target to remove from BPF monitoring.",
    }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfFlushSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfUpdateSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    target: Type.String({
      minLength: 1,
      description: "IPv4, IPv6, or MAC target whose rate limits will be updated.",
    }),
    downrate: Type.Integer({
      minimum: 1,
      maximum: 10_000_000_000,
      description: "Download rate limit in bps.",
    }),
    uprate: Type.Integer({
      minimum: 1,
      maximum: 10_000_000_000,
      description: "Upload rate limit in bps.",
    }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const BpfUpdateAllSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    table: Type.Optional(BpfTableField),
    downrate: Type.Integer({
      minimum: 1,
      maximum: 10_000_000_000,
      description: "Download rate limit in bps for all entries in the table.",
    }),
    uprate: Type.Integer({
      minimum: 1,
      maximum: 10_000_000_000,
      description: "Upload rate limit in bps for all entries in the table.",
    }),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetXfrpcCommonSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    enabled: Type.Optional(Type.String({ description: "'0' or '1'." })),
    loglevel: Type.Optional(Type.String({ description: "Log level, e.g., '7'." })),
    server_addr: Type.Optional(
      Type.String({
        description:
          "FRPS server public IP or domain. MUST be explicitly provided by the user. Do not guess or use local IP.",
      }),
    ),
    server_port: Type.Optional(Type.String({ description: "FRPS server port." })),
    token: Type.Optional(
      Type.String({
        description: "Authentication token. Ask user, or generate a random string if not provided.",
      }),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const AddXfrpcTcpServiceSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    name: Type.String({ minLength: 1, description: "Unique service name string." }),
    enabled: Type.Optional(Type.String({ description: "'0' or '1'." })),
    local_ip: Type.Optional(Type.String({ description: "Local IP to forward." })),
    local_port: Type.Optional(Type.String({ description: "Local port to forward." })),
    remote_port: Type.Optional(Type.String({ description: "Remote port on FRPS server." })),
    start_time: Type.Optional(Type.String({ description: "Start time, default '0'." })),
    end_time: Type.Optional(Type.String({ description: "End time, default '0'." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const DeployFrpsSchema = Type.Object(
  {
    port: Type.Integer({ minimum: 1, maximum: 65535, description: "FRPS listen port." }),
    token: Type.Optional(
      Type.String({
        description: "Authentication token. Ask user, or generate a random string if not provided.",
      }),
    ),
  },
  { additionalProperties: false },
);

const ResetFrpsSchema = Type.Object({}, { additionalProperties: false });

const SetVpnRoutesSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    mode: stringEnum(["selective", "full_tunnel"] as const, {
      description:
        "Routing mode: selective (individual CIDR routes) or full_tunnel (all traffic through VPN).",
    }),
    routes: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          description: "CIDR destination to route through VPN, e.g. 1.2.3.0/24.",
        }),
      ),
    ),
    excludeIps: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          description:
            "IPs to exclude from full tunnel routing (e.g. VPS public IP to prevent routing loop).",
        }),
      ),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const SetVpnDomainRoutesSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    domains: Type.Array(
      Type.String({
        minLength: 1,
        description: "Domain name to resolve into IPv4 /32 routes through wg0.",
      }),
    ),
    interface: Type.Optional(
      Type.String({ minLength: 1, description: "WireGuard interface name, defaults to wg0." }),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const DeleteVpnRoutesSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    flushAll: Type.Optional(
      Type.Boolean({ description: "Flush all VPN routes at once instead of deleting individual." }),
    ),
    routes: Type.Optional(
      Type.Array(
        Type.String({
          minLength: 1,
          description: "Individual CIDR routes to delete, e.g. 1.2.3.0/24.",
        }),
      ),
    ),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

const DeployWgServerSchema = Type.Object(
  {
    port: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 65535,
        description: "WireGuard UDP listen port. Default 51820.",
      }),
    ),
    tunnelIp: Type.Optional(
      Type.String({ description: "Server tunnel IP with mask. Default 10.0.0.1/24." }),
    ),
  },
  { additionalProperties: false },
);

const AddWgPeerSchema = Type.Object(
  {
    publicKey: Type.String({ minLength: 1, description: "Peer public key." }),
    allowedIps: Type.Array(
      Type.String({
        minLength: 1,
        description: "Allowed IPs for this peer, e.g. ['10.0.0.2/32'].",
      }),
    ),
    endpoint: Type.Optional(Type.String({ description: "Optional peer endpoint." })),
  },
  { additionalProperties: false },
);

const RunSpeedtestSchema = Type.Object(
  {
    deviceId: DeviceIdField,
    serverId: Type.Optional(Type.String({ description: "Optional specific speedtest server ID." })),
    timeoutMs: TimeoutField,
  },
  { additionalProperties: false },
);

type GenericToolParams = Static<typeof GenericToolSchema>;
type DeviceOnlyParams = Static<typeof DeviceOnlySchema>;
type ClientInfoParams = Static<typeof ClientInfoSchema>;
type AuthClientParams = Static<typeof AuthClientSchema>;
type KickoffClientParams = Static<typeof KickoffClientSchema>;
type UpdateDeviceInfoParams = Static<typeof UpdateDeviceInfoSchema>;
type SetAuthServerParams = Static<typeof SetAuthServerSchema>;
type PortalTemplate = PortalTemplateType;
type PortalContentParams = PortalContentType;
type PublishPortalPageParams = Static<typeof PublishPortalPageSchema>;
type GeneratePortalPageParams = Static<typeof GeneratePortalPageSchema>;
type SetMqttServerParams = Static<typeof SetMqttServerSchema>;
type SetWebsocketServerParams = Static<typeof SetWebsocketServerSchema>;
type SetWireguardVpnParams = Static<typeof SetWireguardVpnSchema>;
type TmpPassParams = Static<typeof TmpPassSchema>;
type SetWifiInfoParams = Static<typeof SetWifiInfoSchema>;
type ScanWifiParams = Static<typeof ScanWifiSchema>;
type SetWifiRelayParams = Static<typeof SetWifiRelaySchema>;
type DomainSyncParams = Static<typeof DomainSyncSchema>;
type TrustedMacSyncParams = Static<typeof TrustedMacSyncSchema>;
type ShellCommandParams = Static<typeof ShellCommandSchema>;
type BpfAddParams = Static<typeof BpfAddSchema>;
type BpfJsonParams = Static<typeof BpfJsonSchema>;
type BpfDeleteParams = Static<typeof BpfDeleteSchema>;
type BpfFlushParams = Static<typeof BpfFlushSchema>;
type BpfUpdateParams = Static<typeof BpfUpdateSchema>;
type BpfUpdateAllParams = Static<typeof BpfUpdateAllSchema>;
type SetVpnRoutesParams = Static<typeof SetVpnRoutesSchema>;
type SetVpnDomainRoutesParams = Static<typeof SetVpnDomainRoutesSchema>;
type DeleteVpnRoutesParams = Static<typeof DeleteVpnRoutesSchema>;

type BpfJsonTable = "ipv4" | "ipv6" | "mac" | "sid" | "l7";

const PORTAL_WEB_ROOT_CANDIDATES = [
  "/usr/share/nginx/html",
  "/var/www/html",
  "/www",
  "/srv/http",
  "/usr/local/www/nginx/html",
  "/usr/local/www",
];

function normalizeMac(input: string): string {
  return input.trim().toUpperCase().replace(/-/g, ":");
}

function normalizeBpfAddress(table: "ipv4" | "ipv6" | "mac", address: string): string {
  const trimmed = address.trim();
  if (table === "mac") {
    return normalizeMac(trimmed).toLowerCase();
  }
  return trimmed;
}

function mapWireguardInterfacePayload(input: JsonRecord): JsonRecord {
  const output: JsonRecord = { ...input };

  if (output.private_key === undefined && typeof input.privateKey === "string") {
    output.private_key = input.privateKey;
  }
  if (output.listen_port === undefined && typeof input.listenPort === "number") {
    output.listen_port = input.listenPort;
  }

  delete output.privateKey;
  delete output.listenPort;

  return output;
}

function mapWireguardPeerPayload(input: JsonRecord): JsonRecord {
  const output: JsonRecord = { ...input };

  if (output.public_key === undefined && typeof input.publicKey === "string") {
    output.public_key = input.publicKey;
  }
  if (output.preshared_key === undefined && typeof input.presharedKey === "string") {
    output.preshared_key = input.presharedKey;
  }
  if (output.allowed_ips === undefined) {
    output.allowed_ips = Array.isArray(input.allowedIps) ? input.allowedIps : ["0.0.0.0/0"];
  }
  if (output.endpoint_host === undefined && typeof input.endpointHost === "string") {
    output.endpoint_host = input.endpointHost;
  }
  if (output.endpoint_port === undefined && typeof input.endpointPort === "number") {
    output.endpoint_port = input.endpointPort;
  }
  if (output.persistent_keepalive === undefined && typeof input.persistentKeepalive === "number") {
    output.persistent_keepalive = input.persistentKeepalive;
  }
  if (output.route_allowed_ips === undefined && typeof input.routeAllowedIps === "boolean") {
    output.route_allowed_ips = input.routeAllowedIps ? "1" : "0";
  }

  delete output.publicKey;
  delete output.presharedKey;
  delete output.allowedIps;
  delete output.endpointHost;
  delete output.endpointPort;
  delete output.persistentKeepalive;
  delete output.routeAllowedIps;

  return output;
}

function summarizeBpfJsonResponse(
  response: JsonRecord,
  table: BpfJsonTable,
  deviceId: string,
): string {
  const data = response.data;
  const count = Array.isArray(data)
    ? data.length
    : data && typeof data === "object"
      ? Object.keys(data as JsonRecord).length
      : 0;
  return `Fetched ${table} BPF stats for ${deviceId}${count > 0 ? ` (${count} entries)` : ""}.`;
}

function sanitizePortalHtmlRoot(root: string): string {
  return path.resolve(root.trim());
}

async function resolvePortalWebRoot(explicitRoot?: string): Promise<string> {
  const envRoot =
    process.env.OPENCLAW_WRT_PORTAL_WEB_ROOT?.trim() ?? process.env.OPENCLAW_WRT_WEB_ROOT?.trim();
  const candidates = [explicitRoot?.trim(), envRoot, ...PORTAL_WEB_ROOT_CANDIDATES].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );

  for (const candidate of candidates) {
    const resolved = sanitizePortalHtmlRoot(candidate);
    if (explicitRoot?.trim() === candidate || envRoot === candidate) {
      await fs.mkdir(resolved, { recursive: true });
      return resolved;
    }
    try {
      await fs.access(resolved, fsConstants.W_OK);
      return resolved;
    } catch {
      continue;
    }
  }

  throw new Error(
    `unable to locate a writable nginx web root; set OPENCLAW_WRT_PORTAL_WEB_ROOT or pass webRoot (checked: ${PORTAL_WEB_ROOT_CANDIDATES.join(", ")})`,
  );
}

function sanitizePortalPageName(input: string): string {
  const baseName = path.basename(input.trim());
  const cleaned = baseName.replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned.replace(/^-+|-+$/g, "");
}

function buildPortalPageName(deviceId: string, explicitPageName?: string): string {
  const requested = explicitPageName?.trim();
  if (requested) {
    const cleaned = sanitizePortalPageName(requested);
    if (cleaned) {
      return cleaned.endsWith(".html") ? cleaned : `${cleaned}.html`;
    }
  }

  const deviceSlug = deviceId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!deviceSlug) {
    throw new Error("unable to derive portal page name from deviceId");
  }
  return `portal-${deviceSlug}.html`;
}

function ensureDevice(bridge: ClawWRTBridge, deviceId: string): DeviceSnapshot {
  const device = bridge.getDevice(deviceId);
  if (!device) {
    throw new Error(`device not connected: ${deviceId}`);
  }
  return device;
}

function getSingleGatewayId(device: DeviceSnapshot): string | undefined {
  const gateways = Array.isArray(device.gateway) ? device.gateway : [];
  if (gateways.length !== 1) {
    return undefined;
  }
  const gateway = gateways[0];
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) {
    return undefined;
  }
  const gwId = (gateway as JsonRecord).gw_id;
  return typeof gwId === "string" && gwId.trim() ? gwId.trim() : undefined;
}

async function callDeviceOp(params: {
  bridge: ClawWRTBridge;
  deviceId: string;
  op: string;
  payload?: JsonRecord;
  timeoutMs?: number;
  expectResponse?: boolean;
}) {
  return await params.bridge.callDevice({
    deviceId: params.deviceId,
    op: params.op,
    payload: params.payload,
    timeoutMs: params.timeoutMs,
    expectResponse: params.expectResponse,
  });
}

async function publishPortalPage(params: {
  bridge: ClawWRTBridge;
  deviceId: string;
  html?: string;
  template?: PortalTemplate;
  content?: PortalContentParams;
  pageName?: string;
  webRoot?: string;
  timeoutMs?: number;
}) {
  const pageName = buildPortalPageName(params.deviceId, params.pageName);
  const root = await resolvePortalWebRoot(params.webRoot);
  const filePath = path.join(root, pageName);
  const html =
    params.html?.trim() ||
    renderPortalPageHtml({
      deviceId: params.deviceId,
      template: params.template,
      content: params.content,
    });

  await fs.writeFile(filePath, html, "utf8");

  const response = await callDeviceOp({
    bridge: params.bridge,
    deviceId: params.deviceId,
    op: "set_local_portal",
    payload: { portal: pageName },
    timeoutMs: params.timeoutMs,
    expectResponse: true,
  });

  return { pageName, root, filePath, response };
}

async function lookupClientByMac(params: {
  bridge: ClawWRTBridge;
  deviceId: string;
  clientMac: string;
  timeoutMs?: number;
}): Promise<JsonRecord | null> {
  const response = await callDeviceOp({
    bridge: params.bridge,
    deviceId: params.deviceId,
    op: "get_clients",
    timeoutMs: params.timeoutMs,
  });
  const clients = getClientsFromResponse(response);
  const normalized = normalizeMac(params.clientMac);
  const found = clients.find((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const mac = (entry as JsonRecord).mac;
    return typeof mac === "string" && normalizeMac(mac) === normalized;
  });
  return found && typeof found === "object" && !Array.isArray(found) ? (found as JsonRecord) : null;
}

function buildToolResult(text: string, details: JsonRecord) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function createSimpleOperationTool(params: {
  bridge: ClawWRTBridge;
  name: string;
  label: string;
  description: string;
  op: string;
  parameters?: AnyAgentTool["parameters"];
  expectResponse?: boolean;
  buildPayload?: (rawParams: unknown) => {
    deviceId: string;
    payload?: JsonRecord;
    timeoutMs?: number;
    expectResponse?: boolean;
  };
  summarize?: (response: JsonRecord, rawParams: unknown) => string;
}): AnyAgentTool {
  return {
    name: params.name,
    label: params.label,
    description: params.description,
    parameters: params.parameters ?? DeviceOnlySchema,
    execute: async (_toolCallId, rawParams) => {
      const fallbackArgs = rawParams as DeviceOnlyParams;
      const built = params.buildPayload?.(rawParams) ?? {
        deviceId: fallbackArgs.deviceId ? fallbackArgs.deviceId.trim() : "",
        timeoutMs: fallbackArgs.timeoutMs,
      };
      const response = await callDeviceOp({
        bridge: params.bridge,
        deviceId: built.deviceId,
        op: params.op,
        payload: built.payload,
        timeoutMs: built.timeoutMs,
        expectResponse: built.expectResponse ?? params.expectResponse,
      });
      const summary =
        params.summarize?.(response, rawParams) ??
        `Device ${built.deviceId} responded to ${params.op}.`;
      const responseJson = JSON.stringify(response);
      const text = `${summary}\n\nDevice response data:\n${responseJson}`;
      return buildToolResult(text, { response });
    },
  };
}

function createPublishPortalPageTool(bridge: ClawWRTBridge): AnyAgentTool {
  return {
    name: "clawwrt_publish_portal_page",
    label: "OpenClaw WRT Publish Portal Page",
    description: "Publish a captive portal HTML page to the device-specific portal file.",
    parameters: PublishPortalPageSchema,
    execute: async (_toolCallId, rawParams) => {
      const args = rawParams as PublishPortalPageParams;
      const deviceId = args.deviceId.trim();
      const result = await publishPortalPage({
        bridge,
        deviceId,
        html: args.html,
        template: args.template,
        content: args.content,
        pageName: args.pageName,
        webRoot: args.webRoot,
        timeoutMs: args.timeoutMs,
      });

      return buildToolResult(
        `Published portal page ${result.pageName} for ${deviceId} and updated local portal routing.`,
        {
          deviceId,
          pageName: result.pageName,
          webRoot: result.root,
          filePath: result.filePath,
          template: args.template ?? null,
          response: result.response,
        },
      );
    },
  };
}

function createGeneratePortalPageTool(bridge: ClawWRTBridge): AnyAgentTool {
  return {
    name: "clawwrt_generate_portal_page",
    label: "OpenClaw WRT Generate Portal Page",
    description:
      "Generate a captive portal HTML page and publish it to the device-specific portal file.",
    parameters: GeneratePortalPageSchema,
    execute: async (_toolCallId, rawParams) => {
      const args = rawParams as GeneratePortalPageParams;
      const deviceId = args.deviceId.trim();
      const result = await publishPortalPage({
        bridge,
        deviceId,
        template: args.template,
        content: args.content,
        pageName: args.pageName,
        webRoot: args.webRoot,
        timeoutMs: args.timeoutMs,
      });

      return buildToolResult(
        `Generated and published portal page ${result.pageName} for ${deviceId}.`,
        {
          deviceId,
          pageName: result.pageName,
          webRoot: result.root,
          filePath: result.filePath,
          template: args.template ?? "default",
          response: result.response,
        },
      );
    },
  };
}

function createGenericTool(bridge: ClawWRTBridge): AnyAgentTool {
  return {
    name: "clawwrt",
    label: "OpenClaw WRT",
    description:
      "Low-level fallback tool for openclaw-wrt. Prefer the more specific clawwrt_* tools when they match the user intent.",
    parameters: GenericToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const toolParams = rawParams as GenericToolParams;
      if (toolParams.action === "list_devices") {
        const devices = bridge.listDevices();
        return buildToolResult(`Connected devices: ${devices.length}`, { devices });
      }

      const deviceId = toolParams.deviceId?.trim();
      if (!deviceId) {
        throw new Error("deviceId required");
      }

      if (toolParams.action === "get_device") {
        const device = ensureDevice(bridge, deviceId);
        return buildToolResult(`Device ${deviceId} is connected.`, { device });
      }

      const op = toolParams.op?.trim();
      if (!op) {
        throw new Error("op required for action=call");
      }

      const response = await callDeviceOp({
        bridge,
        deviceId,
        op,
        payload: toolParams.payload,
        timeoutMs: toolParams.timeoutMs,
        expectResponse: toolParams.expectResponse,
      });

      return buildToolResult(`Device ${deviceId} responded to ${op}.`, { response });
    },
  };
}

function createListDevicesTool(bridge: ClawWRTBridge): AnyAgentTool {
  return {
    name: "clawwrt_list_devices",
    label: "OpenClaw WRT Devices",
    description:
      "List all currently connected online routers, wireless routers, or OpenWrt devices managed by openclaw-wrt.",
    parameters: Type.Object(
      {
        dummy_field: Type.Optional(
          Type.String({
            description: "Ignore this field. It exists to prevent empty parameter objects.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async () => {
      const devices = bridge.listDevices();

      const deviceStrings = devices
        .map((d) => `- ${d.alias || "Router"} (ID: ${d.deviceId})`)
        .join("\n");
      const textOutput = `当前 ${devices.length} 台设备在线：\n\n${deviceStrings}`;

      return buildToolResult(textOutput, { devices });
    },
  };
}

function createGetDeviceTool(bridge: ClawWRTBridge): AnyAgentTool {
  return {
    name: "clawwrt_get_device",
    label: "OpenClaw WRT Device",
    description:
      "Get the current connection snapshot for one online router or wireless router. This is a quick connectivity view, not the full runtime detail report.",
    parameters: Type.Object({ deviceId: DeviceIdField }, { additionalProperties: false }),
    execute: async (_toolCallId, rawParams) => {
      const args = rawParams as { deviceId: string };
      const device = ensureDevice(bridge, args.deviceId.trim());
      return buildToolResult(`Device ${device.deviceId} is connected.`, { device });
    },
  };
}

export function createClawWRTTools(params: { bridge: ClawWRTBridge }): AnyAgentTool[] {
  const { bridge } = params;

  return [
    createListDevicesTool(bridge),
    createGetDeviceTool(bridge),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_status",
      label: "OpenClaw WRT Status",
      description:
        "Get detailed runtime status and health information for an online router or wireless router. Prefer this when the user asks for router details or current router status.",
      op: "get_status",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched status for device ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_sys_info",
      label: "OpenClaw WRT System Info",
      description:
        "Get detailed router system information such as model, platform, memory, storage, uptime, and resource usage for an online router.",
      op: "get_sys_info",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched system info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_device_info",
      label: "OpenClaw WRT Device Info",
      description:
        "Get configured router metadata such as site, label, location, and other saved device information for an online router.",
      op: "get_device_info",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched device info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_update_device_info",
      label: "OpenClaw WRT Update Device Info",
      description: "Update device metadata such as site, label, location, or custom fields.",
      op: "update_device_info",
      parameters: UpdateDeviceInfoSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as UpdateDeviceInfoParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { device_info: args.deviceInfo },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as UpdateDeviceInfoParams;
        return `Updated device info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_clients",
      label: "OpenClaw WRT Clients",
      description: "List currently authenticated clients on a router.",
      op: "get_clients",
      summarize: (response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        const count = getClientsFromResponse(response).length;
        return `Fetched ${count} clients from ${args.deviceId}.`;
      },
    }),
    {
      name: "clawwrt_get_client_info",
      label: "OpenClaw WRT Client Info",
      description: "Get detailed information for one authenticated client by MAC address.",
      parameters: ClientInfoSchema,
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams as ClientInfoParams;
        const normalizedMac = normalizeMac(args.clientMac);
        const response = await callDeviceOp({
          bridge,
          deviceId: args.deviceId.trim(),
          op: "get_client_info",
          payload: { mac: normalizedMac },
          timeoutMs: args.timeoutMs,
        });
        return buildToolResult(`Fetched client info for ${normalizedMac} on ${args.deviceId}.`, {
          response,
        });
      },
    },
    {
      name: "clawwrt_auth_client",
      label: "OpenClaw WRT Auth Client",
      description:
        "Authorize one client by MAC and IP through the router-side ClawWRT API. Use this for captive portal login and AI-driven approval.",
      parameters: AuthClientSchema,
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams as AuthClientParams;
        const clientMac = normalizeMac(args.clientMac);
        const clientIp = args.clientIp.trim();
        const response = await callDeviceOp({
          bridge,
          deviceId: args.deviceId.trim(),
          op: "auth_client",
          payload: {
            client_ip: clientIp,
            client_mac: clientMac,
          },
          timeoutMs: args.timeoutMs,
        });
        return buildToolResult(`Authorized client ${clientMac} on ${args.deviceId}.`, {
          response,
          resolved: { clientIp, clientMac },
        });
      },
    },
    {
      name: "clawwrt_kickoff_client",
      label: "OpenClaw WRT Kickoff Client",
      description:
        "Disconnect an authenticated client by MAC address. If client IP is omitted, the tool looks it up from get_clients. If the router has exactly one gateway, gwId is inferred automatically.",
      parameters: KickoffClientSchema,
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams as KickoffClientParams;
        const deviceId = args.deviceId.trim();
        const device = ensureDevice(bridge, deviceId);
        const clientMac = normalizeMac(args.clientMac);
        const explicitClientIp = args.clientIp?.trim();
        const client = explicitClientIp
          ? null
          : await lookupClientByMac({
              bridge,
              deviceId,
              clientMac,
              timeoutMs: args.timeoutMs,
            });
        const resolvedClientMac =
          typeof client?.mac === "string" && client.mac.trim() ? client.mac.trim() : clientMac;
        const clientIp =
          explicitClientIp ||
          (typeof client?.ip === "string" && client.ip.trim() ? client.ip.trim() : undefined);
        if (!clientIp) {
          throw new Error(`client IP not found for ${clientMac}; provide clientIp explicitly`);
        }
        const gwId = args.gwId?.trim() || getSingleGatewayId(device);
        if (!gwId) {
          throw new Error("gwId required when the device has multiple gateways");
        }
        const response = await callDeviceOp({
          bridge,
          deviceId,
          op: "kickoff",
          payload: {
            client_ip: clientIp,
            client_mac: resolvedClientMac,
            gw_id: gwId,
          },
          timeoutMs: args.timeoutMs,
        });
        return buildToolResult(`Kickoff requested for ${clientMac} on ${deviceId}.`, {
          response,
          resolved: { clientIp, gwId, clientMac: resolvedClientMac },
        });
      },
    },
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_tmp_pass_client",
      label: "OpenClaw WRT Temporary Pass Client",
      description: "Temporarily allow one client MAC to bypass captive portal authentication.",
      op: "tmp_pass_client",
      parameters: TmpPassSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as TmpPassParams;
        const payload: JsonRecord = {
          client_mac: normalizeMac(args.clientMac).toLowerCase(),
        };
        if (typeof args.timeout === "number") {
          payload.timeout = args.timeout;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
          expectResponse: true,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as TmpPassParams;
        return `Temporary pass requested for ${normalizeMac(args.clientMac)} on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_wifi_info",
      label: "OpenClaw WRT WiFi Info",
      description: "Get the router's Wi-Fi and radio configuration.",
      op: "get_wifi_info",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched Wi-Fi info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_set_wifi_info",
      label: "OpenClaw WRT Set WiFi Info",
      description:
        "Update Wi-Fi configuration on the router, such as changing SSID (network name), password, encryption type, or hiding the network. Use this tool when the user asks to modify, change, or update Wi-Fi settings including SSID.",
      op: "set_wifi_info",
      parameters: SetWifiInfoSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetWifiInfoParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { data: args.data },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetWifiInfoParams;
        return `Applied Wi-Fi config changes to ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_scan_wifi",
      label: "OpenClaw WRT Scan WiFi",
      description: "Scan nearby Wi-Fi networks, optionally filtered to 2.4 GHz or 5 GHz.",
      op: "scan_wifi",
      parameters: ScanWifiSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as ScanWifiParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: args.band ? { band: args.band } : undefined,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as ScanWifiParams;
        return `Completed Wi-Fi scan for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_set_wifi_relay",
      label: "OpenClaw WRT Set WiFi Relay",
      description: "Configure the router to join an upstream Wi-Fi as relay/STA.",
      op: "set_wifi_relay",
      parameters: SetWifiRelaySchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetWifiRelayParams;
        const payload: JsonRecord = { ssid: args.ssid };
        if (typeof args.key === "string") {
          payload.key = args.key;
        }
        if (typeof args.band === "string") {
          payload.band = args.band;
        }
        if (typeof args.encryption === "string") {
          payload.encryption = args.encryption;
        }
        if (typeof args.bssid === "string") {
          payload.bssid = args.bssid;
        }
        if (typeof args.apply === "boolean") {
          payload.apply = args.apply;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetWifiRelayParams;
        return `Configured Wi-Fi relay for ${args.deviceId} using SSID ${args.ssid}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_bpf_add",
      label: "OpenClaw WRT BPF Add",
      description: "Add an IPv4, IPv6, or MAC target to the device's BPF traffic monitoring table.",
      op: "bpf_add",
      parameters: BpfAddSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfAddParams;
        const table = typeof args.table === "string" ? args.table : "mac";
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table,
            address: normalizeBpfAddress(table, args.address),
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfAddParams;
        const table = typeof args.table === "string" ? args.table : "mac";
        return `Added ${args.address} to the ${table} BPF monitor table on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_bpf_json",
      label: "OpenClaw WRT BPF Stats",
      description:
        "Query BPF traffic monitoring statistics for one table (`ipv4`, `ipv6`, `mac`, `sid`, or `l7`).",
      op: "bpf_json",
      parameters: BpfJsonSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfJsonParams;
        const table = (args.table ?? "mac") as BpfJsonTable;
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table,
          },
          timeoutMs: args.timeoutMs ?? 30_000,
        };
      },
      summarize: (response, rawParams) => {
        const args = rawParams as BpfJsonParams;
        const table = (args.table ?? "mac") as BpfJsonTable;
        return summarizeBpfJsonResponse(response, table, args.deviceId);
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_l7_active_stats",
      label: "OpenClaw WRT L7 Active Stats",
      description:
        "Get active L7 protocol traffic speed and volume statistics (SID view) for the current device.",
      op: "bpf_json",
      parameters: DeviceOnlySchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { table: "sid" },
          timeoutMs: args.timeoutMs ?? 30_000,
        };
      },
      summarize: (response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return summarizeBpfJsonResponse(response, "sid", args.deviceId);
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_l7_protocol_catalog",
      label: "OpenClaw WRT L7 Protocol Catalog",
      description:
        "List the L7 protocol library currently supported by the device, including domain signatures when available.",
      op: "bpf_json",
      parameters: DeviceOnlySchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { table: "l7" },
          timeoutMs: args.timeoutMs ?? 30_000,
        };
      },
      summarize: (response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return summarizeBpfJsonResponse(response, "l7", args.deviceId);
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_bpf_del",
      label: "OpenClaw WRT BPF Delete",
      description:
        "Remove an IPv4, IPv6, or MAC target from the device's BPF traffic monitoring table.",
      op: "bpf_del",
      parameters: BpfDeleteSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfDeleteParams;
        const table = typeof args.table === "string" ? args.table : "mac";
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table,
            address: normalizeBpfAddress(table, args.address),
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfDeleteParams;
        const table = typeof args.table === "string" ? args.table : "mac";
        return `Removed ${args.address} from the ${table} BPF monitor table on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_bpf_flush",
      label: "OpenClaw WRT BPF Flush",
      description: "Clear all entries from one BPF monitoring table.",
      op: "bpf_flush",
      parameters: BpfFlushSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfFlushParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table: args.table ?? "mac",
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfFlushParams;
        const table = typeof args.table === "string" ? args.table : "mac";
        return `Flushed ${table} BPF monitor table on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_bpf_update",
      label: "OpenClaw WRT BPF Update",
      description: "Update downrate/uprate limits for one BPF monitored target.",
      op: "bpf_update",
      parameters: BpfUpdateSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfUpdateParams;
        const table = typeof args.table === "string" ? args.table : "mac";
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table,
            target: normalizeBpfAddress(table, args.target),
            downrate: args.downrate,
            uprate: args.uprate,
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfUpdateParams;
        const table = typeof args.table === "string" ? args.table : "mac";
        return `Updated ${table} BPF rate limits for ${args.target} on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_bpf_update_all",
      label: "OpenClaw WRT BPF Update All",
      description: "Update downrate/uprate limits for all entries in one BPF table.",
      op: "bpf_update_all",
      parameters: BpfUpdateAllSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as BpfUpdateAllParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            table: args.table ?? "mac",
            downrate: args.downrate,
            uprate: args.uprate,
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as BpfUpdateAllParams;
        const table = typeof args.table === "string" ? args.table : "mac";
        return `Updated ${table} BPF rate limits for all monitored entries on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_trusted_domains",
      label: "OpenClaw WRT Trusted Domains",
      description: "Get the trusted domain whitelist for captive portal bypass.",
      op: "get_trusted_domains",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched trusted domains for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_sync_trusted_domains",
      label: "OpenClaw WRT Sync Trusted Domains",
      description: "Replace the trusted domain whitelist with the provided full domain list.",
      op: "sync_trusted_domain",
      parameters: DomainSyncSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DomainSyncParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { domains: args.domains },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as DomainSyncParams;
        return `Synced ${args.domains.length} trusted domains on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_trusted_wildcard_domains",
      label: "OpenClaw WRT Trusted Wildcard Domains",
      description: "Get the trusted wildcard domain whitelist such as *.example.com.",
      op: "get_trusted_wildcard_domains",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched trusted wildcard domains for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_sync_trusted_wildcard_domains",
      label: "OpenClaw WRT Sync Trusted Wildcard Domains",
      description: "Replace the trusted wildcard domain whitelist with the provided full list.",
      op: "sync_trusted_wildcard_domains",
      parameters: DomainSyncSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DomainSyncParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: { domains: args.domains },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as DomainSyncParams;
        return `Synced ${args.domains.length} trusted wildcard domains on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_trusted_mac",
      label: "OpenClaw WRT Trusted MACs",
      description: "Get the trusted MAC whitelist.",
      op: "get_trusted_mac",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched trusted MACs for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_sync_trusted_mac",
      label: "OpenClaw WRT Sync Trusted MACs",
      description: "Replace the trusted MAC whitelist with the provided full MAC list.",
      op: "sync_trusted_mac",
      parameters: TrustedMacSyncSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as TrustedMacSyncParams;
        const macs = args.macs.map((value) => normalizeMac(value).toLowerCase());
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            macs,
            values: args.values ?? Array(macs.length).fill("1"),
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as TrustedMacSyncParams;
        return `Synced ${args.macs.length} trusted MACs on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_auth_serv",
      label: "OpenClaw WRT Get Auth Server",
      description: "Get the current captive portal authentication server configuration.",
      op: "get_auth_serv",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched auth server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_set_auth_serv",
      label: "OpenClaw WRT Set Auth Server",
      description: "Set the captive portal authentication server hostname, port, and path.",
      op: "set_auth_serv",
      parameters: SetAuthServerSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetAuthServerParams;
        const payload: JsonRecord = { hostname: args.hostname };
        if (args.port !== undefined) {
          payload.port = args.port;
        }
        if (typeof args.path === "string") {
          payload.path = args.path;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetAuthServerParams;
        return `Updated auth server for ${args.deviceId} to ${args.hostname}.`;
      },
    }),
    createGeneratePortalPageTool(bridge),
    createPublishPortalPageTool(bridge),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_mqtt_serv",
      label: "OpenClaw WRT Get MQTT Server",
      description: "Get the current MQTT server configuration for the device.",
      op: "get_mqtt_serv",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched MQTT server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_set_mqtt_serv",
      label: "OpenClaw WRT Set MQTT Server",
      description: "Set the MQTT server hostname, port, credentials, and TLS flag.",
      op: "set_mqtt_serv",
      parameters: SetMqttServerSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetMqttServerParams;
        const payload: JsonRecord = {};
        if (typeof args.hostname === "string") {
          payload.hostname = args.hostname;
        }
        if (args.port !== undefined) {
          payload.port = args.port;
        }
        if (typeof args.username === "string") {
          payload.username = args.username;
        }
        if (typeof args.password === "string") {
          payload.password = args.password;
        }
        if (typeof args.useSsl === "boolean") {
          payload.use_ssl = args.useSsl;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetMqttServerParams;
        return `Updated MQTT server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_websocket_serv",
      label: "OpenClaw WRT Get WebSocket Server",
      description: "Get the current WebSocket server configuration for the device.",
      op: "get_websocket_serv",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched WebSocket server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_set_websocket_serv",
      label: "OpenClaw WRT Set WebSocket Server",
      description: "Set the WebSocket server hostname, port, path, and TLS flag.",
      op: "set_websocket_serv",
      parameters: SetWebsocketServerSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetWebsocketServerParams;
        const payload: JsonRecord = {};
        if (typeof args.hostname === "string") {
          payload.hostname = args.hostname;
        }
        if (args.port !== undefined) {
          payload.port = args.port;
        }
        if (typeof args.path === "string") {
          payload.path = args.path;
        }
        if (typeof args.useSsl === "boolean") {
          payload.use_ssl = args.useSsl;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetWebsocketServerParams;
        return `Updated WebSocket server config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_wireguard_vpn",
      label: "OpenClaw WRT Get WireGuard VPN",
      description: "Get WireGuard VPN configuration (single tunnel mode: wg0).",
      op: "get_wireguard_vpn",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched WireGuard VPN config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_set_wireguard_vpn",
      label: "OpenClaw WRT Set WireGuard VPN",
      description:
        "Set WireGuard VPN configuration for a single tunnel (wg0), including interface and peers.",
      op: "set_wireguard_vpn",
      parameters: SetWireguardVpnSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetWireguardVpnParams;
        const interfacePayload = mapWireguardInterfacePayload(asObject(args.interface) ?? {});
        const peersPayload = (args.peers ?? []).map((entry) =>
          mapWireguardPeerPayload(asObject(entry) ?? {}),
        );

        return {
          deviceId: args.deviceId.trim(),
          payload: {
            data: {
              interface: interfacePayload,
              peers: peersPayload,
            },
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetWireguardVpnParams;
        return `Updated WireGuard VPN config for ${args.deviceId}.`;
      },
    }),
    {
      name: "clawwrt_get_wireguard_vpn_status",
      label: "OpenClaw WRT Get WireGuard VPN Status",
      description:
        "Get runtime WireGuard status from both the router (peer handshake/traffic) and the local OpenClaw server (tunnel presence).",
      parameters: DeviceOnlySchema,
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        const deviceId = args.deviceId.trim();

        // 1. Fetch status from router
        let routerStatus: JsonRecord | null = null;
        let routerError: string | null = null;
        try {
          routerStatus = await callDeviceOp({
            bridge,
            deviceId,
            op: "get_wireguard_vpn_status",
            timeoutMs: args.timeoutMs,
          });
        } catch (error) {
          routerError = error instanceof Error ? error.message : String(error);
        }

        // 2. Fetch status from local server (if available/applicable)
        let serverStatus: string = "unavailable";
        let snatMissing = true;
        let ipForwardEnabled = false;
        let probesSuccessful = false;

        try {
          const { execSync } = await import("node:child_process");
          const wgOutput = execSync("wg show 2>&1 || echo 'wg not found/active'", {
            encoding: "utf-8",
            timeout: 5000,
          });
          const iptablesOutput = execSync("iptables -t nat -S POSTROUTING", {
            encoding: "utf-8",
            timeout: 5000,
          });
          snatMissing = !iptablesOutput.includes("-j MASQUERADE");
          const sysctlOutput = execSync("sysctl -n net.ipv4.ip_forward", {
            encoding: "utf-8",
            timeout: 2000,
          });
          ipForwardEnabled = sysctlOutput.trim() === "1";

          serverStatus =
            `--- WireGuard ---\n${wgOutput}\n` +
            `--- NAT Rules ---\n${iptablesOutput}\n` +
            `--- IP Forwarding ---\n${ipForwardEnabled ? "Enabled (1)" : "Disabled (0)"}`;
          probesSuccessful = true;
        } catch (error) {
          serverStatus = `Error fetching server status: ${error instanceof Error ? error.message : String(error)}`;
        }

        const summary = `Fetched WireGuard VPN status for ${deviceId}.`;
        let text =
          `${summary}\n\n` +
          `--- ROUTER SIDE (${deviceId}) ---\n` +
          (routerError ? `Error: ${routerError}` : JSON.stringify(routerStatus, null, 2)) +
          `\n\n--- SERVER SIDE (OpenClaw Server) ---\n` +
          serverStatus;

        if (probesSuccessful) {
          if (snatMissing) {
            text +=
              "\n\nWARNING: SNAT (MASQUERADE) rule might be missing on the server side. Full tunnel traffic may not reach the internet.";
          }
          if (!ipForwardEnabled) {
            text += "\nWARNING: IP forwarding is disabled on the server side.";
          }
        }

        return buildToolResult(text, {
          router: routerStatus ?? { error: routerError },
          server: serverStatus,
          serverChecks: { snatMissing, ipForwardEnabled },
        });
      },
    },
    {
      name: "clawwrt_setup_server_vpn_nat",
      label: "OpenClaw WRT Setup Server VPN NAT",
      description: "Automate server-side SNAT (MASQUERADE) configuration and enable IP forwarding.",
      parameters: Type.Object(
        {
          wanInterface: Type.Optional(
            Type.String({
              description: "Public WAN interface name (e.g., eth0). Auto-detected if omitted.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams as { wanInterface?: string };
        const { execSync } = await import("node:child_process");

        let wan = args.wanInterface;
        if (!wan) {
          wan = execSync("ip route get 1.1.1.1 | awk '{print $5}' | head -1", {
            encoding: "utf-8",
          }).trim();
        }

        if (!wan || !/^[a-zA-Z0-9.\-_@]+$/.test(wan)) {
          throw new Error(`Invalid or missing WAN interface: ${wan ?? "null"}`);
        }

        const setupCommand = [
          `sudo sysctl -w net.ipv4.ip_forward=1`,
          `sudo iptables -t nat -C POSTROUTING -o ${wan} -j MASQUERADE || sudo iptables -t nat -A POSTROUTING -o ${wan} -j MASQUERADE`,
          `sudo iptables -C FORWARD -i wg0 -j ACCEPT || sudo iptables -A FORWARD -i wg0 -j ACCEPT`,
          `sudo iptables -C FORWARD -o wg0 -j ACCEPT || sudo iptables -A FORWARD -o wg0 -j ACCEPT`,
        ].join(" && ");

        const output = execSync(setupCommand, { encoding: "utf-8" });
        return buildToolResult(
          `Server-side VPN NAT configured using interface ${wan}.\n${output}`,
          {
            wanInterface: wan,
            output,
          },
        );
      },
    },
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_generate_wireguard_keys",
      label: "OpenClaw WRT Generate WireGuard Keys",
      description:
        "Generate a WireGuard key pair on the router. The private key is written directly to UCI (network.wg0.private_key) and never leaves the device. Only the public key is returned. Use this BEFORE set_wireguard_vpn to avoid sending private keys over the network.",
      op: "generate_wireguard_keys",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Generated WireGuard keys on ${args.deviceId}. Public key returned; private key stored locally.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_vpn_routes",
      label: "OpenClaw WRT Get VPN Routes",
      description:
        "Get current VPN routing table entries (ip route show dev wg0 proto static). Shows which traffic is being steered through the WireGuard tunnel.",
      op: "get_vpn_routes",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched VPN routes for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_set_vpn_domain_routes",
      label: "OpenClaw WRT Set VPN Domain Routes",
      description:
        "Resolve one or more domain names to IPv4 addresses and add each resolved address as an ip/32 static route through wg0.",
      op: "set_vpn_domain_routes",
      parameters: SetVpnDomainRoutesSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetVpnDomainRoutesParams;
        return {
          deviceId: args.deviceId.trim(),
          payload: {
            data: {
              domains: args.domains,
              interface: args.interface,
            },
          },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetVpnDomainRoutesParams;
        return `Resolved domain routes for ${args.domains.length} domain(s) on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_set_vpn_routes",
      label: "OpenClaw WRT Set VPN Routes",
      description:
        "Set VPN routing rules to steer traffic through the WireGuard tunnel. Selective mode routes specific CIDRs; full_tunnel mode routes all traffic (0.0.0.0/1 + 128.0.0.0/1) with exclude_ips to prevent routing loop for VPS IP.",
      op: "set_vpn_routes",
      parameters: SetVpnRoutesSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as SetVpnRoutesParams;
        const payload: JsonRecord = { mode: args.mode };
        if (Array.isArray(args.routes)) {
          payload.routes = args.routes;
        }
        if (Array.isArray(args.excludeIps)) {
          payload.exclude_ips = args.excludeIps;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload: { data: payload },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as SetVpnRoutesParams;
        return `Set VPN routes (${args.mode} mode) on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_delete_vpn_routes",
      label: "OpenClaw WRT Delete VPN Routes",
      description:
        "Delete VPN routing rules. Use flushAll to remove all routes, or provide specific CIDR routes to remove individually.",
      op: "delete_vpn_routes",
      parameters: DeleteVpnRoutesSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as DeleteVpnRoutesParams;
        const payload: JsonRecord = {};
        if (typeof args.flushAll === "boolean") {
          payload.flush_all = args.flushAll;
        }
        if (Array.isArray(args.routes)) {
          payload.routes = args.routes;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload: { data: payload },
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as DeleteVpnRoutesParams;
        const method = args.flushAll ? "flushed all" : "deleted selected";
        return `Deleted VPN routes (${method}) on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_firmware_info",
      label: "OpenClaw WRT Firmware Info",
      description: "Get the router's firmware/build information.",
      op: "get_firmware_info",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched firmware info for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_network_interfaces",
      label: "OpenClaw WRT Network Interfaces",
      description: "Get network interface inventory and IP details using a native API call.",
      op: "get_network_interfaces",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched network interfaces for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_firmware_upgrade",
      label: "OpenClaw WRT Firmware Upgrade",
      description: "Trigger a firmware upgrade (OTA) on the router using a URL.",
      op: "firmware_upgrade",
      parameters: FirmwareUpgradeSchema,
      summarize: (_response, rawParams) => {
        const args = rawParams as Static<typeof FirmwareUpgradeSchema>;
        return `Firmware upgrade requested for ${args.deviceId} from ${args.url}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_delete_wifi_relay",
      label: "OpenClaw WRT Delete WiFi Relay",
      description: "Remove Wi-Fi relay/STA configuration from the router.",
      op: "delete_wifi_relay",
      parameters: DeleteWifiRelaySchema,
      buildPayload: (rawParams) => {
        const args = rawParams as Static<typeof DeleteWifiRelaySchema>;
        return {
          deviceId: args.deviceId.trim(),
          payload: args.apply !== undefined ? { apply: args.apply } : undefined,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as Static<typeof DeleteWifiRelaySchema>;
        return `Requested Wi-Fi relay deletion on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_execute_shell",
      label: "OpenClaw WRT Execute Shell",
      description:
        "Execute a shell command on the router. Use only when the user explicitly requests shell-level access.",
      op: "shell",
      parameters: ShellCommandSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as ShellCommandParams;
        const payload: JsonRecord = { command: args.command };
        if (typeof args.timeoutSeconds === "number") {
          payload.timeout = args.timeoutSeconds;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as ShellCommandParams;
        return `Executed shell command on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_speedtest_servers",
      label: "OpenClaw WRT Speedtest Servers",
      description: "List available nearby speedtest.net servers for performance testing.",
      op: "get_speedtest_servers",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched speedtest servers for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_speedtest",
      label: "OpenClaw WRT Speedtest",
      description: "Run an internet speed test (ping, download, upload) on the router.",
      op: "speedtest",
      parameters: RunSpeedtestSchema,
      buildPayload: (rawParams) => {
        const args = rawParams as { deviceId: string; serverId?: string; timeoutMs?: number };
        return {
          deviceId: args.deviceId.trim(),
          payload: args.serverId ? { server_id: args.serverId } : undefined,
          timeoutMs: args.timeoutMs ?? 120_000,
        };
      },
      summarize: (_response, rawParams) => {
        const args = rawParams as { deviceId: string };
        return `Completed speedtest on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_reboot_device",
      label: "OpenClaw WRT Reboot Device",
      description:
        "Request a router reboot. The device should respond before rebooting, but it may disconnect immediately.",
      op: "reboot_device",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Reboot request sent to ${args.deviceId}. Treat this as best-effort and expect disconnect.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_get_xfrpc_config",
      label: "OpenClaw WRT XFRPC Config",
      description: "Get current XFRPC (intranet penetration) configuration from the router.",
      op: "get_xfrpc_config",
      summarize: (_response, rawParams) => {
        const args = rawParams as DeviceOnlyParams;
        return `Fetched XFRPC config for ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_set_xfrpc_common",
      label: "OpenClaw WRT Set XFRPC Common",
      description: "Set XFRPC common configuration (server address, port, token) on the router.",
      op: "set_xfrpc_common",
      parameters: SetXfrpcCommonSchema,
      buildPayload: (rawParams) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args = rawParams as any;
        const payload: JsonRecord = {};
        if (args.enabled !== undefined) {
          payload.enabled = args.enabled;
        }
        if (args.loglevel !== undefined) {
          payload.loglevel = args.loglevel;
        }
        if (args.server_addr !== undefined) {
          payload.server_addr = args.server_addr;
        }
        if (args.server_port !== undefined) {
          payload.server_port = args.server_port;
        }
        if (args.token !== undefined) {
          payload.token = args.token;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args = rawParams as any;
        return `Updated XFRPC common config on ${args.deviceId}.`;
      },
    }),
    createSimpleOperationTool({
      bridge,
      name: "clawwrt_add_xfrpc_tcp_service",
      label: "OpenClaw WRT Add XFRPC TCP Service",
      description: "Add a TCP intranet penetration service to the router.",
      op: "add_xfrpc_tcp_service",
      parameters: AddXfrpcTcpServiceSchema,
      buildPayload: (rawParams) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args = rawParams as any;
        const payload: JsonRecord = { name: args.name };
        if (args.enabled !== undefined) {
          payload.enabled = args.enabled;
        }
        if (args.local_ip !== undefined) {
          payload.local_ip = args.local_ip;
        }
        if (args.local_port !== undefined) {
          payload.local_port = args.local_port;
        }
        if (args.remote_port !== undefined) {
          payload.remote_port = args.remote_port;
        }
        if (args.start_time !== undefined) {
          payload.start_time = args.start_time;
        }
        if (args.end_time !== undefined) {
          payload.end_time = args.end_time;
        }
        return {
          deviceId: args.deviceId.trim(),
          payload,
          timeoutMs: args.timeoutMs,
        };
      },
      summarize: (_response, rawParams) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const args = rawParams as any;
        return `Added XFRPC TCP service '${args.name}' on ${args.deviceId}.`;
      },
    }),
    {
      name: "openclaw_deploy_frps",
      label: "OpenClaw Deploy FRPS",
      description:
        "Automatically fetch the latest version from GitHub, install as /usr/bin/nwct-server, and configure a service with systemd autostart on the VPS host.",
      parameters: DeployFrpsSchema,
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams;
        const { execSync } = await import("node:child_process");

        const configDir = "/etc/nwct";
        const configPath = path.join(configDir, "nwct-server.toml");
        const servicePath = "/etc/systemd/system/nwct-server.service";
        let tempDir: string | undefined;

        let toml = `bindPort = ${args.port}\n`;
        if (args.token) {
          toml += `auth.token = ${JSON.stringify(args.token)}\n`;
        }

        let output = "";
        try {
          // 1. Ensure config directory
          execSync(`sudo mkdir -p ${configDir}`, { encoding: "utf-8" });
          tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrt-nwct-"));
          const writeSecureTempFile = async (fileName: string, content: string) => {
            const tempPath = path.join(tempDir as string, fileName);
            await fs.writeFile(tempPath, content, "utf8");
            await fs.chmod(tempPath, 0o600);
            return tempPath;
          };

          const configTempPath = await writeSecureTempFile("nwct-server.toml", toml);
          execSync(`sudo mv ${configTempPath} ${configPath}`, { encoding: "utf-8" });

          // 2. Install binary if missing
          let binPath = "/usr/bin/nwct-server";
          try {
            binPath = execSync("which nwct-server", { encoding: "utf-8" }).trim();
            output += `nwct-server binary already exists at ${binPath}.\n`;
          } catch {
            output += "nwct-server binary not found. Downloading latest version from GitHub...\n";
            try {
              const archMap: Record<string, string> = {
                x64: "amd64",
                arm64: "arm64",
                arm: "arm",
              };
              const arch = archMap[process.arch] || "amd64";

              // Get latest version via GitHub API
              const latestJson = execSync(
                "curl -s --connect-timeout 10 https://api.github.com/repos/fatedier/frp/releases/latest",
                { encoding: "utf-8" },
              );
              const latestInfo = JSON.parse(latestJson);
              const tagName = latestInfo.tag_name;
              if (!tagName) {
                throw new Error("Could not determine latest version from GitHub API.");
              }

              const version = tagName.startsWith("v") ? tagName.substring(1) : tagName;
              const folderName = `frp_${version}_linux_${arch}`;
              const filename = `${folderName}.tar.gz`;
              const downloadUrl = `https://github.com/fatedier/frp/releases/download/${tagName}/${filename}`;

              output += `Target version: ${tagName}, Arch: ${arch}\nDownloading from: ${downloadUrl}\n`;

              execSync(`curl -L -o /tmp/${filename} ${downloadUrl}`, { encoding: "utf-8" });
              execSync(`tar -C /tmp -zxvf /tmp/${filename}`, { encoding: "utf-8" });
              execSync(`sudo mv /tmp/${folderName}/frps /usr/bin/nwct-server`, {
                encoding: "utf-8",
              });
              execSync(`sudo chmod +x /usr/bin/nwct-server`, { encoding: "utf-8" });
              execSync(`rm -rf /tmp/${filename} /tmp/${folderName}`, { encoding: "utf-8" });
              output +=
                "Binary installed successfully to /usr/bin/nwct-server and temporary files removed.\n";
            } catch (dlError) {
              output += `Error during binary download/install: ${dlError instanceof Error ? dlError.message : String(dlError)}\n`;
              output += "Please install the binary manually to /usr/bin/nwct-server.\n";
              throw dlError;
            }
          }

          // 3. Create systemd service
          const serviceContent = `[Unit]
Description=Intranet Penetration Server (NWCT)
After=network.target

[Service]
Type=simple
ExecStart=${binPath} -c ${configPath}
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;
          const serviceTempPath = await writeSecureTempFile("nwct-server.service", serviceContent);
          execSync(`sudo mv ${serviceTempPath} ${servicePath}`, { encoding: "utf-8" });

          // 4. Reload and start
          execSync("sudo systemctl daemon-reload", { encoding: "utf-8" });
          execSync("sudo systemctl enable nwct-server", { encoding: "utf-8" });
          output += execSync("sudo systemctl restart nwct-server", { encoding: "utf-8" });
          output += "\nNWCT service successfully configured and restarted via systemd.";
        } catch (error) {
          return buildToolResult(
            `Deployment failed. Output: ${output}\nError: ${error instanceof Error ? error.message : String(error)}`,
            { status: "error", output },
          );
        } finally {
          if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true });
          }
        }

        return buildToolResult(`Deployment success.\nConfig: ${configPath}\nOutput: ${output}`, {
          status: "success",
          configPath,
          toml,
        });
      },
    },
    {
      name: "openclaw_get_frps_status",
      label: "OpenClaw Get FRPS Status",
      description:
        "Check server status, including systemd state, listening ports, and active configuration.",
      parameters: Type.Object({}),
      execute: async () => {
        const { execSync } = await import("node:child_process");
        const configPath = "/etc/nwct/nwct-server.toml";

        let configExists = false;
        let configContent = "";
        try {
          configContent = execSync(`sudo cat ${configPath}`, { encoding: "utf-8" });
          configExists = true;
        } catch {}
        const redactedConfigContent = redactFrpsConfigContent(configContent);

        let serviceStatus = "Unknown";
        try {
          serviceStatus = execSync("systemctl is-active nwct-server || true", {
            encoding: "utf-8",
          }).trim();
        } catch {}

        let portsInfo = "";
        try {
          portsInfo = execSync("sudo ss -tulpn | grep nwct-server || true", {
            encoding: "utf-8",
          }).trim();
        } catch {}

        const details = `Service State: ${serviceStatus}\nConfig: ${configExists ? "Found" : "Not Found"}\nListening Ports:\n${portsInfo || "None"}\n\nConfig Content:\n${redactedConfigContent}`;

        return buildToolResult(details, {
          serviceStatus,
          configExists,
          configContent: redactedConfigContent,
          portsInfo,
        });
      },
    },
    {
      name: "openclaw_reset_frps",
      label: "OpenClaw Reset FRPS",
      description:
        "Stop and disable nwct-server, remove its binary, config directory, and systemd service file from the VPS.",
      parameters: ResetFrpsSchema,
      execute: async () => {
        const { execSync } = await import("node:child_process");
        let output = "";
        try {
          execSync("sudo systemctl stop nwct-server || true", { encoding: "utf-8" });
          execSync("sudo systemctl disable nwct-server || true", { encoding: "utf-8" });
          output += "Stopped and disabled systemd service.\\n";

          execSync("sudo rm -f /etc/systemd/system/nwct-server.service", { encoding: "utf-8" });
          execSync("sudo systemctl daemon-reload", { encoding: "utf-8" });
          output += "Removed systemd service file.\\n";

          execSync("sudo rm -f /usr/bin/nwct-server", { encoding: "utf-8" });
          execSync("sudo rm -rf /etc/nwct", { encoding: "utf-8" });
          output += "Removed binary and configuration directory.\\n";

          return buildToolResult(output + "FRPS has been successfully reset.", {
            status: "success",
          });
        } catch (error) {
          return buildToolResult(
            `Reset failed. Output: ${output}\\nError: ${error instanceof Error ? error.message : String(error)}`,
            { status: "error" },
          );
        }
      },
    },
    {
      name: "openclaw_deploy_wg_server",
      label: "OpenClaw Deploy WireGuard Server",
      description:
        "Automatically install WireGuard, enable IP forwarding, generate server keys, and configure wg0 with NAT on the VPS host.",
      parameters: DeployWgServerSchema,
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams;
        const { execSync } = await import("node:child_process");
        const port = args.port || 51820;
        const tunnelIp = args.tunnelIp || "10.0.0.1/24";
        if (!/^[\w.:/,\- ]+$/.test(tunnelIp)) {
          return buildToolResult(
            "Invalid tunnelIp format. Only alphanumeric and basic network punctuation allowed.",
            { status: "error" },
          );
        }
        let output = "";

        try {
          // 1. Install WireGuard tools
          output += "Checking/Installing WireGuard tools...\n";
          const installCmd = `
            if ! command -v wg >/dev/null; then
              if command -v apt-get >/dev/null; then
                sudo apt-get update && sudo apt-get install -y wireguard
              elif command -v dnf >/dev/null; then
                sudo dnf install -y epel-release elrepo-release && sudo dnf install -y kmod-wireguard wireguard-tools
              elif command -v pacman >/dev/null; then
                sudo pacman -S --noconfirm wireguard-tools
              else
                echo "Unsupported package manager. Please install wireguard-tools manually."
                exit 1
              fi
            fi
          `;
          execSync(installCmd, { encoding: "utf-8" });

          // 2. Enable IP forwarding
          output += "Enabling IPv4 forwarding...\n";
          execSync("sudo sysctl -w net.ipv4.ip_forward=1", { encoding: "utf-8" });
          execSync("echo 'net.ipv4.ip_forward = 1' | sudo tee /etc/sysctl.d/99-wireguard.conf", {
            encoding: "utf-8",
          });

          // 3. Generate server keys if missing
          const privKeyPath = "/etc/wireguard/server_private.key";
          const pubKeyPath = "/etc/wireguard/server_public.key";
          try {
            execSync(`sudo ls ${privKeyPath}`, { encoding: "utf-8" });
            output += "Server keys already exist.\n";
          } catch {
            output += "Generating server keys...\n";
            execSync(`sudo mkdir -p /etc/wireguard && sudo chmod 700 /etc/wireguard`, {
              encoding: "utf-8",
            });
            execSync(`wg genkey | sudo tee ${privKeyPath} | wg pubkey | sudo tee ${pubKeyPath}`, {
              encoding: "utf-8",
            });
            execSync(`sudo chmod 600 ${privKeyPath}`, { encoding: "utf-8" });
          }
          const serverPrivKey = execSync(`sudo cat ${privKeyPath}`, { encoding: "utf-8" }).trim();
          const serverPubKey = execSync(`sudo cat ${pubKeyPath}`, { encoding: "utf-8" }).trim();

          // 4. Detect egress interface
          const egressIf = execSync("ip route get 1.1.1.1 | awk '{print $5; exit}'", {
            encoding: "utf-8",
          }).trim();
          output += `Egress interface detected: ${egressIf}\n`;

          // 5. Create wg0.conf
          const confPath = "/etc/wireguard/wg0.conf";
          const confContent = `[Interface]
Address = ${tunnelIp}
ListenPort = ${port}
PrivateKey = ${serverPrivKey}
PostUp = iptables -t nat -A POSTROUTING -o ${egressIf} -j MASQUERADE; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o ${egressIf} -j MASQUERADE; iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT
`;
          const crypto = await import("node:crypto");
          const tempFile = `/tmp/wg0-${crypto.randomBytes(8).toString("hex")}.conf`;
          await fs.writeFile(tempFile, confContent, { encoding: "utf8", mode: 0o600 });
          execSync(`sudo mv ${tempFile} ${confPath}`, { encoding: "utf-8" });
          execSync(`sudo chmod 600 ${confPath}`, { encoding: "utf-8" });

          // 6. Open UDP port (best effort)
          output += "Attempting to open UDP port in firewall...\n";
          const fwCmd = `
            if systemctl is-active --quiet firewalld; then
              sudo firewall-cmd --permanent --add-port=${port}/udp
              sudo firewall-cmd --permanent --add-masquerade
              sudo firewall-cmd --reload
            elif command -v ufw >/dev/null && sudo ufw status | grep -q "active"; then
              sudo ufw allow ${port}/udp
            fi
          `;
          try {
            execSync(fwCmd, { encoding: "utf-8" });
          } catch {}

          // 7. Start service
          execSync("sudo systemctl enable wg-quick@wg0", { encoding: "utf-8" });
          execSync("sudo systemctl restart wg-quick@wg0", { encoding: "utf-8" });
          output += "WireGuard server successfully deployed and started.\n";

          return buildToolResult(
            `WireGuard deployment success.\nPublic Key: ${serverPubKey}\nOutput: ${output}`,
            {
              status: "success",
              serverPubKey,
              port,
              tunnelIp,
            },
          );
        } catch (error) {
          return buildToolResult(
            `WireGuard deployment failed: ${error instanceof Error ? error.message : String(error)}`,
            {
              status: "error",
              output,
            },
          );
        }
      },
    },
    {
      name: "openclaw_add_wg_peer",
      label: "OpenClaw Add WireGuard Peer",
      description: "Add a new peer (router) to the VPS WireGuard server configuration and reload.",
      parameters: AddWgPeerSchema,
      execute: async (_toolCallId, rawParams) => {
        const args = rawParams;
        const { execFileSync, execSync } = await import("node:child_process");
        const confPath = "/etc/wireguard/wg0.conf";
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wrt-wg-peer-"));

        try {
          const peerBlock = `\n[Peer]\nPublicKey = ${args.publicKey}\nAllowedIPs = ${args.allowedIps.join(", ")}\n${args.endpoint ? `Endpoint = ${args.endpoint}\n` : ""}`;
          const existingConf = execSync(`sudo cat ${confPath}`, { encoding: "utf-8" });
          const tempFile = path.join(tempDir, "wg0.conf");
          await fs.writeFile(tempFile, existingConf + peerBlock, "utf8");
          await fs.chmod(tempFile, 0o600);
          execSync(`sudo mv ${tempFile} ${confPath}`, { encoding: "utf-8" });

          // Reload without downtime
          const strippedConf = execFileSync("sudo", ["wg-quick", "strip", "wg0"], {
            encoding: "utf-8",
          });
          execFileSync("sudo", ["wg", "syncconf", "wg0", "/dev/stdin"], {
            encoding: "utf-8",
            input: strippedConf,
          });

          return buildToolResult(`Peer added successfully.\nPublicKey: ${args.publicKey}`, {
            status: "success",
          });
        } catch (error) {
          return buildToolResult(
            `Failed to add peer: ${error instanceof Error ? error.message : String(error)}`,
            { status: "error" },
          );
        } finally {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: "openclaw_get_wg_status",
      label: "OpenClaw Get WireGuard Status",
      description: "Check WireGuard server runtime status, peers, and forwarding state.",
      parameters: Type.Object({}),
      execute: async () => {
        const { execSync } = await import("node:child_process");
        try {
          const wgShow = execSync("sudo wg show", { encoding: "utf-8" });
          const forwarding = execSync("sysctl net.ipv4.ip_forward", { encoding: "utf-8" }).trim();
          return buildToolResult(`WireGuard Status:\n${wgShow}\n\n${forwarding}`, {
            status: "success",
            wgShow,
            forwarding,
          });
        } catch (error) {
          return buildToolResult(
            `Failed to get status: ${error instanceof Error ? error.message : String(error)}`,
            { status: "error" },
          );
        }
      },
    },
    {
      name: "claw_wifi_hello",
      label: "Claw WiFi Hello",
      description:
        "当用户打招呼（如 Hello, 你好, hello 龙虾wifi）、询问龙虾WiFi (Claw WiFi) 具有哪些功能或需要使用示例 (Prompts) 时调用。此工具会确认 Agent 身份，展示功能目录并提供一系列引导示例。",
      parameters: Type.Object({}),
      execute: async () => {
        let catalog = `# 龙虾WiFi (Claw WiFi) 功能清单与使用示例\n\n已识别龙虾WiFi 身份。以下是您可以使用的功能模块及其 Prompts 示例：\n`;

        for (const [, item] of Object.entries(PROMPT_EXAMPLES)) {
          catalog += `\n### ${item.label}\n`;
          item.prompts.forEach((p) => {
            catalog += `- ${p}\n`;
          });
        }

        catalog += `\n---\n您可以直接复制上述 Prompts 或根据需要进行修改。\n`;
        return buildToolResult(catalog, { status: "success", catalogReady: true });
      },
    },
    createGenericTool(bridge),
  ];
}

/**
 * 龙虾WiFi 功能示例库 (Encoded Prompt Examples)
 * 存储在代码中以节省 Skill Token，仅在调用 claw_wifi_hello 时动态返回。
 */
const PROMPT_EXAMPLES: Record<string, { label: string; prompts: string[] }> = {
  mgmt: {
    label: "1. 基础管理与状态监控",
    prompts: [
      '**查询状态**: "帮我看看现在有哪些路由器在线，并报告一下它们的运行状态和负载情况。"',
      "**设置 WiFi**: \"把房间 101 的路由器 SSID 改成 'Claw-Fast'，密码设置为 'claw123456'，记得开启 5G 频段。\"",
      '**强制下线**: "把 MAC 地址是 AA:BB:CC:DD:EE:FF 的那个客户端踢掉。"',
      '**限速管理**: "给正在下载的大流量用户（IP: 192.168.1.50）限速，下行带宽控制在 2Mbps。"',
    ],
  },
  nwct: {
    label: "2. 内网穿透 (NWCT)",
    prompts: [
      '**自动部署**: "我的 VPS 还没装内网穿透服务端，请帮我下载最新版并以 nwct-server 名义安装到 /usr/bin/，配置好 systemd 自启动。然后把 101 房间路由器的 SSH 映射到 6022 端口，并确认端口是否已经在 VPS 上监听了。"',
      '**状态自检**: "检查一下现在的内网穿透服务（nwct-server）是否正常？包括服务端进程、客户端连接，以及公网端口是否已经开启监听。"',
    ],
  },
  vpn: {
    label: "3. 全球组网 (WireGuard VPN)",
    prompts: [
      '**快速部署**: "帮我把这台龙虾WiFi 和 VPS 连起来。先在 VPS 上初始化 WG 服务端，然后生成路由器的密钥并完成对接，最后测试互 ping。"',
      '**添加节点**: "再帮我添加一台 102 房间的路由器到现有的 VPN 组网中，分配 IP 10.0.0.3。"',
      '**域名分流**: "配置好 VPN 后，让 google.com 的流量走隧道，其他的走本地。"',
      '**复杂双向部署**: "请把这次 WG VPN 方案拆成两部分：\\n1. OpenClaw VPS/云主机侧的 WireGuard 服务器、中转、peer、防火墙（必须开启 UDP 端口）、NAT 和转发。\\n2. 龙虾WiFi 路由器侧的客户端配置、认证和路由设置，统一使用相关的 clawwrt_* 工具。\\n\\n要求：\\n- 首先检查 VPS 侧是否安装服务端，未安装则先安装并开启对应的防火墙端口。\\n- 然后执行路由器侧的 key 生成和配置下发。\\n- 部署完成后，通过两端互 ping wg0 接口 IP 来验证隧道是否连通。\\n- 如果是多个龙虾WiFi 组网，请确保服务器端的 AllowedIPs 包含各子网，并提醒用户下发准确的静态路由以实现跨节点互通。\\n- 默认使用 selective 模式；full_tunnel 必须带 excludeIps。\\n\\n请输出：\\n- VPS 侧和路由器侧的详细执行步骤\\n- 互 ping 验证结果预期\\n- 跨节点互通的路由规则说明\\n- 风险点和回滚方式"',
    ],
  },
  portal: {
    label: "4. 商用门户页 (Captive Portal)",
    prompts: [
      "**生成咖啡厅页面**: \"帮我为 '瑞幸咖啡 101 店' 设计一个认证页面。模板选 cafe，标题写 '欢迎来到瑞幸'，内容写 '点击下方按钮即可享受极速网络'，再加上几条上网规则。\"",
      "**企业办公页面**: \"给公司会议室的路由器做一个 business 风格的页面。品牌名叫 '字节跳动'，网络名叫 'ByteDance-Guest'。\"",
      "**口令输入页**: \"为我的私人无线网络生成一个入口。使用 voucher 模板，提示用户输入进场密码，输入框的占位符写 '请输入今日暗号'。\"",
    ],
  },
  social: {
    label: "5. 社交活跃与 Moltbook 互动",
    prompts: [
      '**个人介绍**: "在 Moltbook 上发一个帖子介绍一下我自己，记得带上我现在运行的硬件平台、在线时长，还有我管理的那几台龙虾WiFi 路由器的健康状态。"',
      '**每日总结**: "帮我生成一个今日运行简报：今天一共服务了多少用户，跑了多少流量，测速表现如何，最后艾特一下其他 OpenClaw 节点打个招呼。"',
    ],
  },
};
