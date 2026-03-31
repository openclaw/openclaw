---
name: vpn-deployment
description: End-to-end WireGuard VPN deployment guide — VPS server setup, router client configuration, and traffic routing via apfree-wifidog tools.
user-invocable: true
---

# WireGuard VPN Deployment Guide

This skill guides you through the complete WireGuard VPN deployment workflow: installing and configuring a WireGuard server on a VPS, connecting an OpenWrt router as a client via `apfree_wifidog_set_wireguard_vpn`, and managing traffic routing via `apfree_wifidog_set_vpn_routes`.

## Overview

```
VPS (WireGuard Server)                     Router (WireGuard Client)
┌──────────────────────┐                   ┌──────────────────────┐
│  wg0: 10.0.0.1/24    │◄── WG tunnel ──► │  wg0: 10.0.0.2/24    │
│  Public IP: X.X.X.X  │                   │  LAN: 192.168.1.0/24 │
│  NAT masquerade       │                   │  ip route proto static│
└──────────────────────┘                   └──────────────────────┘
         │                                          │
    Internet ◄─── selected/all traffic ────── LAN clients
```

## Phase 1: VPS WireGuard Server Setup

These are local shell commands to run on the VPS directly (not through apfree-wifidog tools).

### 1.1 Install WireGuard

Detect the distro and use the appropriate package manager:

```bash
# Debian / Ubuntu
apt update && apt install -y wireguard

# CentOS 8+ / RHEL 8+ / Rocky / AlmaLinux
dnf install -y epel-release elrepo-release
dnf install -y kmod-wireguard wireguard-tools

# CentOS 7 (requires ELRepo)
yum install -y epel-release
yum install -y https://www.elrepo.org/elrepo-release-7.el7.elrepo.noarch.rpm
yum install -y kmod-wireguard wireguard-tools

# Fedora
dnf install -y wireguard-tools

# Arch Linux
pacman -S --noconfirm wireguard-tools

# Verify
which wg && which wg-quick
modprobe wireguard && echo "wireguard module loaded"
```

> **Note:** On CentOS/RHEL with kernel < 5.6, the `kmod-wireguard` package provides the kernel module. On kernel >= 5.6 (including most CentOS 8 Stream / RHEL 9), WireGuard is built-in and only `wireguard-tools` is needed.

### 1.2 Generate Server Keys

```bash
wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key
chmod 600 /etc/wireguard/server_private.key
```

### 1.3 Generate Router Public Key (Secure — keys generated on router)

Instead of generating router keys on the VPS, use `apfree_wifidog_generate_wireguard_keys` to generate the key pair **on the router itself**. The private key is written directly to UCI and never leaves the device. Only the public key is returned.

```
Tool: apfree_wifidog_generate_wireguard_keys
Params:
  deviceId: "<router_device_id>"
```

Response will contain `data.public_key` — save this for the VPS `[Peer]` section below.

> **Security:** The router's private key never traverses the network (MQTT/WebSocket). It is generated locally by `wg genkey` and stored in UCI `network.wg0.private_key`.

### 1.4 Create Server Configuration

```bash
cat > /etc/wireguard/wg0.conf << 'EOF'
[Interface]
Address = 10.0.0.1/24
ListenPort = 51820
PrivateKey = <server_private_key>
PostUp = iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE; iptables -A FORWARD -i wg0 -j ACCEPT; iptables -A FORWARD -o wg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE; iptables -D FORWARD -i wg0 -j ACCEPT; iptables -D FORWARD -o wg0 -j ACCEPT

[Peer]
# Router 1
PublicKey = <router1_public_key>
AllowedIPs = 10.0.0.2/32, 192.168.1.0/24
EOF
```

**Important:** Replace `eth0` with the actual public-facing interface name (`ip route get 1.1.1.1 | awk '{print $5}'`).

### 1.5 Enable IP Forwarding

```bash
# Check current state
sysctl net.ipv4.ip_forward

# Enable persistently (works on all distros)
sed -i '/^net.ipv4.ip_forward/d' /etc/sysctl.conf
echo 'net.ipv4.ip_forward = 1' >> /etc/sysctl.conf
sysctl -p
```

### 1.6 Firewall Configuration

Open the WireGuard listen port. Detect which firewall is active:

```bash
# If firewalld is active (CentOS/RHEL/Fedora default)
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=51820/udp
  firewall-cmd --permanent --add-masquerade
  firewall-cmd --reload
# If ufw is active (Ubuntu/Debian default)
elif command -v ufw &>/dev/null && ufw status | grep -q "active"; then
  ufw allow 51820/udp
# Otherwise ensure iptables rules in wg0.conf PostUp/PostDown handle it
else
  echo "No firewalld or ufw detected; relying on wg0.conf PostUp/PostDown iptables rules."
fi
```

### 1.7 Start and Enable

```bash
systemctl enable --now wg-quick@wg0
wg show wg0
```

## Phase 2: Router WireGuard Client Configuration

Use apfree-wifidog tools to configure the router. Run these via the OpenClaw agent.

### 2.1 Configure WireGuard Tunnel

**Prerequisite:** Run `apfree_wifidog_generate_wireguard_keys` first (Phase 1.3). The private key is already stored in UCI.

Use `apfree_wifidog_set_wireguard_vpn` with:

- **interface**: tunnel address only (private key is already in UCI from key generation)
- **peers**: VPS public key + endpoint + `allowedIps: ["0.0.0.0/0"]` + `routeAllowedIps: false`

Setting `routeAllowedIps: false` prevents netifd from auto-creating kernel routes, letting us manage routes explicitly.

```
Tool: apfree_wifidog_set_wireguard_vpn
Params:
  deviceId: "<router_device_id>"
  interface:
    addresses: ["10.0.0.2/24"]
  peers:
    - publicKey: "<server_public_key>"
      endpointHost: "<vps_public_ip>"
      endpointPort: 51820
      allowedIps: ["0.0.0.0/0"]
      persistentKeepalive: 25
      routeAllowedIps: false
```

> **Note:** Do NOT pass `privateKey` here — it is already set by `generate_wireguard_keys`. The `set_wireguard_vpn` handler preserves existing UCI options that are not overwritten.

### 2.2 Verify Tunnel Status

Use `apfree_wifidog_get_wireguard_vpn_status` to confirm the tunnel is up and has a handshake.

## Phase 3: Traffic Routing

### 3.1 Selective Routing (specific destinations through VPN)

Use `apfree_wifidog_set_vpn_routes` with `mode: "selective"`:

```
Tool: apfree_wifidog_set_vpn_routes
Params:
  deviceId: "<router_device_id>"
  mode: "selective"
  routes: ["1.2.3.0/24", "4.5.6.0/24"]
```

### 3.2 Full Tunnel (all traffic through VPN)

Use `apfree_wifidog_set_vpn_routes` with `mode: "full_tunnel"` and `excludeIps` containing the VPS public IP to prevent routing loop:

```
Tool: apfree_wifidog_set_vpn_routes
Params:
  deviceId: "<router_device_id>"
  mode: "full_tunnel"
  excludeIps: ["<vps_public_ip>"]
```

### 3.3 Verify Routes

Use `apfree_wifidog_get_vpn_routes` to confirm routes are applied.

### 3.4 Remove Routes

Use `apfree_wifidog_delete_vpn_routes` with `flushAll: true` to clear all VPN routes.

## Phase 3B: Domain-Based Routing

When a user wants to route traffic for specific **domain names** (e.g. "youtube.com", "netflix.com") through the VPN tunnel, the agent must resolve domains to IP addresses first because `set_vpn_routes` only accepts CIDR blocks.

**Important:** `set_vpn_routes` does NOT accept domain names. Domains must be resolved to IPs before calling the tool.

### 3B.1 Resolve Domains to IPs

Run DNS resolution on the VPS (or any machine with internet access) using shell commands:

```bash
# Resolve a single domain to all IPs
dig +short youtube.com | grep -E '^[0-9]+\.' | sort -u

# Resolve multiple domains and aggregate
for domain in youtube.com netflix.com; do
  dig +short "$domain" | grep -E '^[0-9]+\.'
done | sort -u

# For domains with CDN (many IPs), use whois to get the CIDR block
whois $(dig +short youtube.com | head -1) | grep -i 'cidr\|route:' | head -3
```

### 3B.2 Convert IPs to CIDR Routes

Use `/32` suffix for each individual IP address to ensure precise routing through the tunnel.

1. **Individual IPs**: Use `/32` suffix for each IP — most reliable for domain-based routing.

   ```
   routes: ["142.250.80.46/32", "142.250.80.78/32"]
   ```

2. **CIDR aggregation**: Use the subnet that covers the IPs — fewer routes, slightly broader (use with caution).

   ```bash
   # Example: Google/YouTube IPs often fall within these ranges
   whois 142.250.80.46 | grep -i cidr
   # CIDR: 142.250.0.0/15
   ```

   ```
   routes: ["142.250.0.0/15"]
   ```

3. **Known service CIDR blocks**: For major services, use published IP ranges

   ```bash
   # Google/YouTube
   curl -s https://www.gstatic.com/ipranges/goog.json | jq -r '.prefixes[].ipv4Prefix' | head -20

   # Cloudflare
   curl -s https://www.cloudflare.com/ips-v4
   ```

### 3B.3 Push Routes to Router

After resolving domains to IPs (using `/32`), call `apfree_wifidog_set_vpn_routes`:

```
Tool: apfree_wifidog_set_vpn_routes
Params:
  deviceId: "<router_device_id>"
  mode: "selective"
  routes: ["142.250.80.46/32", "142.250.80.78/32"]
```

### 3B.4 Domain Routing Workflow Summary

The complete agent workflow when a user says "route youtube.com through VPN":

1. **Resolve**: Run `dig +short youtube.com` on VPS via shell → get IP list
2. **Aggregate**: Use `whois` or known ranges to find covering CIDRs
3. **Push**: Call `apfree_wifidog_set_vpn_routes` with the CIDRs
4. **Verify**: Call `apfree_wifidog_get_vpn_routes` to confirm

**Caveats:**

- DNS results change over time (CDN rotation). Routes may need periodic refresh.
- Large services (Google, AWS, Cloudflare) may have hundreds of CIDRs. Use aggregated ranges.
- Routes are kernel-only and lost on router reboot. Re-push after tunnel re-establishment.

## Phase 4: Adding More Routers

For each additional router:

1. Generate keys on the new router via `apfree_wifidog_generate_wireguard_keys` — note the returned public key
2. Add a `[Peer]` section to VPS `/etc/wireguard/wg0.conf` with the new router's public key and a unique tunnel IP (10.0.0.3/32, 10.0.0.4/32, etc.)
3. Reload VPS config: `wg syncconf wg0 <(wg-quick strip wg0)`
4. Configure the new router via `apfree_wifidog_set_wireguard_vpn` (Phase 2) — omit `privateKey` (already set)
5. Apply routes via `apfree_wifidog_set_vpn_routes` (Phase 3)

## Troubleshooting

| Symptom                           | Check                                                    | Fix                                                                              |
| --------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| No handshake                      | `wg show wg0` on VPS — peer should show latest handshake | Verify endpoint host/port, check VPS firewall (see Phase 1.6)                    |
| WireGuard module not loaded       | `modprobe wireguard` fails                               | CentOS/RHEL: install `kmod-wireguard` from ELRepo; kernel >= 5.6 has it built-in |
| Tunnel up but no traffic          | `apfree_wifidog_get_vpn_routes` — routes should exist    | Re-apply routes with `set_vpn_routes`                                            |
| Full tunnel breaks VPS connection | `exclude_ips` missing VPS IP                             | Add VPS public IP to `excludeIps` array                                          |
| Routes lost after reboot          | Routes are not persisted in UCI                          | Re-push via `set_vpn_routes` after tunnel re-establishment                       |
| DNS not resolving through VPN     | Router using local DNS                                   | Configure DNS to use tunnel: `ip route add <dns_ip>/32 dev wg0 proto static`     |

## Security Notes

- **Private keys never leave the device.** Use `apfree_wifidog_generate_wireguard_keys` to generate keys on the router; only the public key is returned. The private key goes directly to UCI.
- Never expose private keys in logs or chat. Use placeholders when discussing.
- VPS firewall: open only the WireGuard listen port (default 51820/udp).
- Use `PresharedKey` for post-quantum protection when required.
- Rotate keys by calling `apfree_wifidog_generate_wireguard_keys` again and updating the VPS peer config with the new public key.
