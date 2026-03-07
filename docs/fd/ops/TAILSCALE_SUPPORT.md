# Tailscale Support

## Goal

Enable secure remote access to OpenClaw cluster nodes without exposing router ports.
Tailscale provides a zero-config mesh VPN with stable hostnames.

## When to Use

- **LAN (default):** Use static IPs + SSH aliases (`claw-m4`, `claw-i7`)
- **Remote / off-LAN:** Use Tailscale IPs + aliases (`ts-claw-m4`, `ts-claw-i7`)

## Nodes

| Node | LAN IP | Tailscale IP | LAN Alias | TS Alias |
|------|--------|--------------|-----------|----------|
| M1 | 10.0.0.145 | 100.x.y.z | local | local |
| M4 | 10.0.0.10 | 100.x.y.z | claw-m4 | ts-claw-m4 |
| i7 | 10.0.0.11 | 100.x.y.z | claw-i7 | ts-claw-i7 |

## Setup (per node)

1. Install Tailscale: https://tailscale.com/download
2. Authenticate to the same tailnet: `tailscale up`
3. Note the Tailscale IP: `tailscale ip -4`
4. Optional: enable Tailscale SSH: `tailscale set --ssh`

## SSH Config (add to ~/.ssh/config on M1)

```
Host ts-claw-m4
  HostName <tailscale-ip-of-m4>
  User fdclaw-m4
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519

Host ts-claw-i7
  HostName <tailscale-ip-of-i7>
  User fdclaw-i7
  IdentitiesOnly yes
  IdentityFile ~/.ssh/id_ed25519
```

## Makefile Usage

Switch cluster targets to Tailscale by overriding `CLUSTER_HOSTS`:

```bash
# LAN (default)
make cluster-bootstrap

# Remote via Tailscale
make cluster-bootstrap CLUSTER_HOSTS="ts-claw-m4 ts-claw-i7"
```

## Security

- Prefer Tailscale ACLs + device approval over open ports
- Never store secrets on shared SMB mount (`~/cluster`)
- Tailscale provides end-to-end encryption (WireGuard)
- Consider enabling Tailscale SSH for keyless auth
