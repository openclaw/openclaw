---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenClaw on Oracle Cloud (Always Free ARM)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up OpenClaw on Oracle Cloud（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Looking for low-cost VPS hosting for OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Want 24/7 OpenClaw on a small server（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Oracle Cloud"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw on Oracle Cloud (OCI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run a persistent OpenClaw Gateway on Oracle Cloud's **Always Free** ARM tier.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Oracle’s free tier can be a great fit for OpenClaw (especially if you already have an OCI account), but it comes with tradeoffs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ARM architecture (most things work, but some binaries may be x86-only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Capacity and signup can be finicky（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost Comparison (2026)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Provider     | Plan            | Specs                  | Price/mo | Notes                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | --------------- | ---------------------- | -------- | --------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0       | ARM, limited capacity |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | ~ $4     | Cheapest paid option  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6       | Easy UI, good docs    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6       | Many locations        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5       | Now part of Akamai    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prerequisites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Oracle Cloud account ([signup](https://www.oracle.com/cloud/free/)) — see [community signup guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) if you hit issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale account (free at [tailscale.com](https://tailscale.com))（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ~30 minutes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 1) Create an OCI Instance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Log into [Oracle Cloud Console](https://cloud.oracle.com/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Navigate to **Compute → Instances → Create Instance**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Configure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Name:** `openclaw`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Image:** Ubuntu 24.04 (aarch64)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **OCPUs:** 2 (or up to 4)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Memory:** 12 GB (or up to 24 GB)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Boot volume:** 50 GB (up to 200 GB free)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **SSH key:** Add your public key（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Click **Create**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Note the public IP address（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Tip:** If instance creation fails with "Out of capacity", try a different availability domain or retry later. Free tier capacity is limited.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2) Connect and Update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Connect via public IP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh ubuntu@YOUR_PUBLIC_IP（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Update system（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt update && sudo apt upgrade -y（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo apt install -y build-essential（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** `build-essential` is required for ARM compilation of some dependencies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 3) Configure User and Hostname（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Set hostname（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo hostnamectl set-hostname openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Set password for ubuntu user（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo passwd ubuntu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Enable lingering (keeps user services running after logout)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo loginctl enable-linger ubuntu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 4) Install Tailscale（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://tailscale.com/install.sh | sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo tailscale up --ssh --hostname=openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This enables Tailscale SSH, so you can connect via `ssh openclaw` from any device on your tailnet — no public IP needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Verify:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tailscale status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**From now on, connect via Tailscale:** `ssh ubuntu@openclaw` (or use the Tailscale IP).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 5) Install OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -fsSL https://openclaw.ai/install.sh | bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source ~/.bashrc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When prompted "How do you want to hatch your bot?", select **"Do this later"**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> Note: If you hit ARM-native build issues, start with system packages (e.g. `sudo apt install -y build-essential`) before reaching for Homebrew.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 6) Configure Gateway (loopback + token auth) and enable Tailscale Serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use token auth as the default. It’s predictable and avoids needing any “insecure auth” Control UI flags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Keep the Gateway private on the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Require auth for the Gateway + Control UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.auth.mode token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor --generate-gateway-token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Expose over Tailscale Serve (HTTPS + tailnet access)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.tailscale.mode serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set gateway.trustedProxies '["127.0.0.1"]'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
systemctl --user restart openclaw-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 7) Verify（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check daemon status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
systemctl --user status openclaw-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check Tailscale Serve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tailscale serve status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Test local response（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl http://localhost:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 8) Lock Down VCN Security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Now that everything is working, lock down the VCN to block all traffic except Tailscale. OCI's Virtual Cloud Network acts as a firewall at the network edge — traffic is blocked before it reaches your instance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Go to **Networking → Virtual Cloud Networks** in the OCI Console（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Click your VCN → **Security Lists** → Default Security List（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Remove** all ingress rules except:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `0.0.0.0/0 UDP 41641` (Tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Keep default egress rules (allow all outbound)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This blocks SSH on port 22, HTTP, HTTPS, and everything else at the network edge. From now on, you can only connect via Tailscale.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access the Control UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From any device on your Tailscale network:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
https://openclaw.<tailnet-name>.ts.net/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Replace `<tailnet-name>` with your tailnet name (visible in `tailscale status`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No SSH tunnel needed. Tailscale provides:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- HTTPS encryption (automatic certs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Authentication via Tailscale identity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Access from any device on your tailnet (laptop, phone, etc.)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security: VCN + Tailscale (recommended baseline)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
With the VCN locked down (only UDP 41641 open) and the Gateway bound to loopback, you get strong defense-in-depth: public traffic is blocked at the network edge, and admin access happens over your tailnet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This setup often removes the _need_ for extra host-based firewall rules purely to stop Internet-wide SSH brute force — but you should still keep the OS updated, run `openclaw security audit`, and verify you aren’t accidentally listening on public interfaces.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What's Already Protected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Traditional Step   | Needed?     | Why                                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------ | ----------- | ---------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| UFW firewall       | No          | VCN blocks before traffic reaches instance                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| fail2ban           | No          | No brute force if port 22 blocked at VCN                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| sshd hardening     | No          | Tailscale SSH doesn't use sshd                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Disable root login | No          | Tailscale uses Tailscale identity, not system users                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| SSH key-only auth  | No          | Tailscale authenticates via your tailnet                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| IPv6 hardening     | Usually not | Depends on your VCN/subnet settings; verify what’s actually assigned/exposed |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Still Recommended（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Credential permissions:** `chmod 700 ~/.openclaw`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Security audit:** `openclaw security audit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **System updates:** `sudo apt update && sudo apt upgrade` regularly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Monitor Tailscale:** Review devices in [Tailscale admin console](https://login.tailscale.com/admin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Verify Security Posture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Confirm no public ports listening（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo ss -tlnp | grep -v '127.0.0.1\|::1'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify Tailscale SSH is active（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Optional: disable sshd entirely（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo systemctl disable --now ssh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Fallback: SSH Tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If Tailscale Serve isn't working, use an SSH tunnel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# From your local machine (via Tailscale)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then open `http://localhost:18789`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Instance creation fails ("Out of capacity")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Free tier ARM instances are popular. Try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Different availability domain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Retry during off-peak hours (early morning)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use the "Always Free" filter when selecting shape（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Tailscale won't connect（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo tailscale status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Re-authenticate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sudo tailscale up --ssh --hostname=openclaw --reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Gateway won't start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor --non-interactive（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
journalctl --user -u openclaw-gateway -n 50（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can't reach Control UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Verify Tailscale Serve is running（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tailscale serve status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Check gateway is listening（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl http://localhost:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Restart if needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
systemctl --user restart openclaw-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### ARM binary issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Some tools may not have ARM builds. Check:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
uname -m  # Should show aarch64（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most npm packages work fine. For binaries, look for `linux-arm64` or `aarch64` releases.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Persistence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All state lives in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/` — config, credentials, session data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory, artifacts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Back up periodically:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## See Also（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway remote access](/gateway/remote) — other remote access patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Tailscale integration](/gateway/tailscale) — full Tailscale docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway configuration](/gateway/configuration) — all config options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [DigitalOcean guide](/platforms/digitalocean) — if you want paid + easier signup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Hetzner guide](/install/hetzner) — Docker-based alternative（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
