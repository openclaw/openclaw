---
name: apfree-wifidog
description: Guide tool usage for managing ApFree WiFiDog routers, gateways, and captive portal devices.
user-invocable: false
---

# ApFree WiFiDog Tool Guidance

You have access to a suite of tools for managing and monitoring network routers, Wi-Fi access points, gateways, and captive portals.

When a user asks to manage, list, configure, or query routers (路由器), devices (设备), gateways (网关), Wi-Fi (无线网络), or network clients (终端/客户端), you must use the `apfree_wifidog_*` tools.

Prefer the specific `apfree_wifidog_*` tools over the low-level `apfree_wifidog` tool for router management.

## Recommended tool choices

- Use `apfree_wifidog_list_devices` to discover online routers.
- Use `apfree_wifidog_get_status` for router health, runtime, and service status.
- Use `apfree_wifidog_get_sys_info` for system resources, platform details, and runtime metrics.
- Use `apfree_wifidog_get_device_info` for configured device metadata.
- Use `apfree_wifidog_update_device_info` to update structured device metadata fields.
- Use `apfree_wifidog_get_clients` to inspect authenticated clients.
- Use `apfree_wifidog_get_client_info` for one client by MAC address.
- Use `apfree_wifidog_kickoff_client` to disconnect a client by MAC address.
- Use `apfree_wifidog_tmp_pass` to temporarily allow a client MAC.
- Use `apfree_wifidog_get_wifi_info` for Wi-Fi configuration.
- Use `apfree_wifidog_set_wifi_info` to update Wi-Fi settings including SSID (network name), password, encryption, or hidden status. Use this when the user asks to change or modify Wi-Fi or SSID settings.
- Use `apfree_wifidog_scan_wifi` to scan nearby Wi-Fi networks.
- Use `apfree_wifidog_set_wifi_relay` to configure upstream Wi-Fi relay or STA.
- Use `apfree_wifidog_get_trusted_domains` and `apfree_wifidog_sync_trusted_domains` for trusted domain allowlists.
- Use `apfree_wifidog_get_trusted_wildcard_domains` and `apfree_wifidog_sync_trusted_wildcard_domains` for wildcard domain allowlists.
- Use `apfree_wifidog_get_trusted_mac` and `apfree_wifidog_sync_trusted_mac` for trusted MAC allowlists.
- Use `apfree_wifidog_get_auth_serv` and `apfree_wifidog_set_auth_serv` for captive portal auth server settings.
- Use `apfree_wifidog_get_mqtt_serv` and `apfree_wifidog_set_mqtt_serv` for MQTT server connection settings.
- Use `apfree_wifidog_get_websocket_serv` and `apfree_wifidog_set_websocket_serv` for WebSocket server connection settings.
- Use `apfree_wifidog_generate_wireguard_keys` to generate a WireGuard key pair on the router (private key stays on device, only public key returned). **Always call this before `set_wireguard_vpn`** to avoid sending private keys over the network.
- Use `apfree_wifidog_get_wireguard_vpn`, `apfree_wifidog_set_wireguard_vpn`, and `apfree_wifidog_get_wireguard_vpn_status` for WireGuard VPN configuration and runtime status.
- Use `apfree_wifidog_get_vpn_routes` to view current VPN routing rules (which traffic goes through the WireGuard tunnel).
- Use `apfree_wifidog_set_vpn_routes` to steer traffic through the VPN tunnel: `selective` mode for specific CIDRs, `full_tunnel` mode for all traffic with `excludeIps` to prevent routing loop.
- Use `apfree_wifidog_delete_vpn_routes` to remove VPN routing rules: `flushAll` to clear everything, or `routes` array for individual CIDRs.
- Use `apfree_wifidog_get_firmware_info` for firmware and build details.
- Use `apfree_wifidog_get_network_interfaces` for interface inventory and IP details.
- Use `apfree_wifidog_bpf_add` to add an IPv4, IPv6, or MAC target to BPF traffic monitoring.
- Use `apfree_wifidog_bpf_json` to query BPF traffic monitoring statistics for `ipv4`, `ipv6`, `mac`, `sid`, or `l7` tables.
- Use `apfree_wifidog_get_l7_active_stats` to query active L7 protocol traffic speed and volume statistics (SID view).
- Use `apfree_wifidog_get_l7_protocol_catalog` to list the L7 protocol library currently supported by the device (including domain signatures when available).
- Use `apfree_wifidog_bpf_del` to remove an IPv4, IPv6, or MAC target from BPF traffic monitoring.
- Use `apfree_wifidog_bpf_flush` to clear all monitored entries in one BPF table.
- Use `apfree_wifidog_bpf_update` to update per-target downrate/uprate limits.
- Use `apfree_wifidog_bpf_update_all` to update downrate/uprate limits for all monitored entries in one BPF table.
- Use `apfree_wifidog_execute_shell` only when the user explicitly requests a shell command.
- Use `apfree_wifidog_reboot_device` only when the user explicitly requests a reboot.
  Only use the low-level `apfree_wifidog` tool when you need an apfree-wifidog operation that is not covered by a specific tool above.

## BPF quick reference

Use `table` as one of: `mac`, `ipv4`, `ipv6`, `sid`, `l7`.

- `apfree_wifidog_bpf_add`
  - Required: `deviceId`, `address`
  - Optional: `table` (default `mac`)
  - Example: add one MAC to monitoring.
- `apfree_wifidog_bpf_del`
  - Required: `deviceId`, `address`
  - Optional: `table` (default `mac`)
  - Example: remove one IPv4 from monitoring.
- `apfree_wifidog_bpf_json`
  - Required: `deviceId`
  - Optional: `table` (default `mac`)
  - Example: read current stats for `ipv4` table, `sid` active L7 traffic stats, or `l7` protocol library.
- `apfree_wifidog_get_l7_active_stats`
  - Required: `deviceId`
  - Query target: `bpf_json` with `table=sid`.
- `apfree_wifidog_get_l7_protocol_catalog`
  - Required: `deviceId`
  - Query target: `bpf_json` with `table=l7`.
- `apfree_wifidog_bpf_flush`
  - Required: `deviceId`
  - Optional: `table` (default `mac`)
  - Example: clear all monitored entries in `mac` table.
- `apfree_wifidog_bpf_update`
  - Required: `deviceId`, `target`, `downrate`, `uprate`
  - Optional: `table` (default `mac`)
  - Rate units: bps, valid range `1..10000000000`.
- `apfree_wifidog_bpf_update_all`
  - Required: `deviceId`, `downrate`, `uprate`
  - Optional: `table` (default `mac`)
  - Rate units: bps, valid range `1..10000000000`.

## Additional operations via low-level `apfree_wifidog`

When a user explicitly asks for any of the following operations, call the low-level tool with `action=call` and `op` set to the exact operation name:

- `firmware_upgrade` or `ota` for firmware upgrades.
- `delete_wifi_relay` or `unset_wifi_relay` to clear Wi-Fi relay or STA configuration.
- `get_ipsec_vpn`, `set_ipsec_vpn`, `get_ipsec_vpn_status`.

## VPN route quick reference

- `apfree_wifidog_get_vpn_routes`
  - Required: `deviceId`
  - Returns: list of `proto static` routes on wg0, tunnel_up status.
- `apfree_wifidog_set_vpn_routes`
  - Required: `deviceId`, `mode` (`selective` or `full_tunnel`)
  - Selective mode: provide `routes` array of CIDRs (e.g. `["1.2.3.0/24", "4.5.6.0/24"]`).
  - Full tunnel mode: provide `excludeIps` array with VPS public IP to prevent routing loop. Routes `0.0.0.0/1` + `128.0.0.0/1` are added automatically.
  - Note: existing routes are flushed before new ones are applied.
- `apfree_wifidog_delete_vpn_routes`
  - Required: `deviceId`
  - Optional: `flushAll` (boolean, removes all VPN routes), `routes` (array of CIDRs to remove individually).

### WireGuard + VPN routing workflow

1. **Generate keys on router**: `apfree_wifidog_generate_wireguard_keys` — private key stays on device, returns public key for VPS `[Peer]` config.
2. Configure WireGuard tunnel: `apfree_wifidog_set_wireguard_vpn` with `routeAllowedIps: false` on the peer (omit `privateKey` — already set by step 1).
3. Check tunnel status: `apfree_wifidog_get_wireguard_vpn_status`.
4. Set VPN routes: `apfree_wifidog_set_vpn_routes` with `selective` or `full_tunnel` mode.
5. Verify routes: `apfree_wifidog_get_vpn_routes`.
6. Remove routes when no longer needed: `apfree_wifidog_delete_vpn_routes` with `flushAll: true`.

Do not use low-level `apfree_wifidog` for operations that already have dedicated tools unless the user explicitly asks for the exact low-level op.

The following are internal device-control operations and should not be used unless the user explicitly requests them with exact parameters:

- `gateway_heartbeat`
- `auth`

Note about device IDs: You can directly use a device alias (for example "Router-1", "Router-2") in the `device_id` parameter for any tool. The system will automatically map the alias to the correct long ID.

## Tool calling output

When you decide to use a tool, do not output any conversational text, preamble, or explanations. Output exactly the tool call directly and nothing else.
