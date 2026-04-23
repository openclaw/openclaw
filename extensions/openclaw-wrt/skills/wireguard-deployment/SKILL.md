---
name: wireguard-deployment
description: VPS and cloud-host WireGuard server deployment guide for OpenClaw. Covers server setup, peer management, NAT/forwarding, route policy, and observability. Router/client setup is handled by clawwrt.
user-invocable: true
---

# WireGuard Server Deployment Guide

Build and operate the WireGuard server on an **OpenClaw VPS host** or other cloud Linux host so it can relay traffic for connected 龙虾WiFi routers. Router/client setup is handled separately by `clawwrt`.

This skill is server-side only. If you need a router/client WireGuard tunnel, use the `clawwrt` workflow. If you need a single host to act as both a WireGuard server and an upstream WireGuard client, treat that as two separate configurations and keep the server-side and client-side steps isolated.

## Architecture

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  OpenClaw VPS / Cloud Host                                               │
│                                                                          │
│  WireGuard server (wg0)                                                  │
│  - peers from router/client side                                        │
│  - NAT / forwarding                                                       │
│  - selective / full-tunnel / domain route policy                         │
└──────────────────────────────────────────────────────────────────────────┘
```

## Quick Start (E2E Deployment)

### Phase 1: Server Setup (VPS)

1. **Automated Deployment**: Use `openclaw_deploy_wg_server` to install WireGuard, enable forwarding, and set up the `wg0` interface.
2. **Collect Public Key**: The tool will return the **Server PublicKey**. You will need this for the router configuration.

### Phase 2: Peer Registration (VPS)

1. **Generate Router Keys**: Use `clawwrt_generate_wireguard_keys` on the target router to get its **PublicKey**.
2. **Add Peer to Server**: Call `openclaw_add_wg_peer` on the VPS with the router's PublicKey and assigned tunnel IP (e.g., `10.0.0.2/32`).

### Phase 3: Client Configuration (Router)

1. **Push Config**: Use `clawwrt_set_wireguard_vpn` to configure the router. Use the Server PublicKey, VPS Public IP, and the assigned tunnel IP.
   - **CRITICAL**: Never set `route_allowed_ips: 1` with `allowed_ips: 0.0.0.0/0`. Always set `route_allowed_ips: 0` and manage routes explicitly via `clawwrt_set_vpn_routes`.
2. **Set Routes**: Apply routing policies via `clawwrt_set_vpn_routes` or `clawwrt_set_vpn_domain_routes`.

### Phase 4: Verification

1. **Check Status**: Use `clawwrt_get_wireguard_vpn_status` and `openclaw_get_wg_status` to confirm the tunnel is up. (Expected: Handshake within last 2 minutes, RX/TX bytes increasing).
2. **Ping Test**: Attempt bidirectional pings between the VPS tunnel IP and router tunnel IP.

## ⚠️ Anti-Lockout Rules (MANDATORY)

These rules **must** be followed to prevent loss of connectivity to the router agent:

1. **Always start with `selective` mode.** Route only specific IPs/CIDRs first.
2. **Never use `full_tunnel` mode without first adding the VPS public IP to `excludeIps`.** This prevents a routing loop that breaks the WebSocket.
3. **Emergency Recovery**: If locked out by `full_tunnel`, you can reboot the router (VPN routes are kernel-only and won't persist) or run `clawwrt_delete_vpn_routes` with `flush_all: true` once reconnected.
