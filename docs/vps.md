---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "VPS hosting hub for OpenClaw (Oracle/Fly/Hetzner/GCP/exe.dev)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to run the Gateway in the cloud（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a quick map of VPS/hosting guides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "VPS Hosting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# VPS hosting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This hub links to the supported VPS/hosting guides and explains how cloud（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
deployments work at a high level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pick a provider（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Railway** (one‑click + browser setup): [Railway](/install/railway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Northflank** (one‑click + browser setup): [Northflank](/install/northflank)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/month (Always Free, ARM; capacity/signup can be finicky)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Fly.io**: [Fly.io](/install/fly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Hetzner (Docker)**: [Hetzner](/install/hetzner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **GCP (Compute Engine)**: [GCP](/install/gcp)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **exe.dev** (VM + HTTPS proxy): [exe.dev](/install/exe-dev)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **AWS (EC2/Lightsail/free tier)**: works well too. Video guide:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  [https://x.com/techfrenAJ/status/2014934471095812547](https://x.com/techfrenAJ/status/2014934471095812547)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How cloud setups work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The **Gateway runs on the VPS** and owns state + workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You connect from your laptop/phone via the **Control UI** or **Tailscale/SSH**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Treat the VPS as the source of truth and **back up** the state + workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Secure default: keep the Gateway on loopback and access it via SSH tunnel or Tailscale Serve.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  If you bind to `lan`/`tailnet`, require `gateway.auth.token` or `gateway.auth.password`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote access: [Gateway remote](/gateway/remote)  （轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Platforms hub: [Platforms](/platforms)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Using nodes with a VPS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can keep the Gateway in the cloud and pair **nodes** on your local devices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(Mac/iOS/Android/headless). Nodes provide local screen/camera/canvas and `system.run`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
capabilities while the Gateway stays in the cloud.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
