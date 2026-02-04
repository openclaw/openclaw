# Network Security & Exposure Review (OpenClaw)

Date: 2026-02-04  
Scope: `~/.openclaw/openclaw.json`, repo `extensions/*`, `src/channels/*`, and `skills/*` inventory.  
Focus: security, web exposure, and network surface area (non‑prompt‑injection).

---

## Executive Summary (High-Level)

- **Primary exposure risk:** the gateway is bound to LAN (`gateway.bind: "lan"`), which makes the WebSocket/HTTP gateway reachable on your home network. If you don’t need LAN access, bind to `loopback` or `tailnet`.
- **Secrets are embedded in config** (`~/.openclaw/openclaw.json`), including provider API keys and channel tokens. These should be moved to environment variables or a local secrets file to reduce leakage risk.
- **Public ingress exists via voice-call + ngrok.** That only exposes the single webhook port, but you should keep signature verification enabled and avoid broad port forwards.
- **Your Slack/WhatsApp/Voice-call channels are active.** Inbound exposure should be treated as internet-facing because these services call you; tighten allowlists and rotate credentials regularly.

---

## Findings (Severity-Based, Evidence-Backed)

### Critical

**[C-1] Secrets stored inline in `~/.openclaw/openclaw.json`.**  
**Impact:** A local file exfiltration or accidental sharing of config leaks production API keys and tokens, enabling account takeover or paid API abuse.  
**Evidence:** `~/.openclaw/openclaw.json` contains inline values for `env.*`, `channels.slack.*`, `skills.entries.*`, `talk.apiKey`, and `plugins.entries.voice-call.config.twilio.*` (multiple lines across the file).  
**Fix:** Move secrets to environment variables and reference them via env substitution (or rely on env fallback where supported), then rotate all exposed keys.

### High

**[H-1] Gateway bound to LAN (`gateway.bind: "lan"`).**  
**Impact:** Any device on your home network can reach the gateway port, increasing the attack surface if a token/password leaks or is brute‑forced.  
**Evidence:** `~/.openclaw/openclaw.json` → `gateway.bind: "lan"` and `gateway.port: 18789`.  
**Fix:** Set to `loopback` if you only need local access, or `tailnet` if you use Tailscale. Keep `gateway.auth.mode: "token"` and rotate the token.

**[H-2] Voice-call plugin uses public ingress via ngrok.**  
**Impact:** The webhook is internet‑reachable; any misconfiguration in signature verification or routing can be abused.  
**Evidence:** `plugins.entries.voice-call.config.tunnel.provider: "ngrok"`.  
**Fix:** Keep `skipSignatureVerification` off (default). Use Twilio signature validation and restrict inbound policy to `allowlist`.

### Medium

**[M-1] Slack/WhatsApp/iMessage channels enabled with tokens in config.**  
**Impact:** If tokens leak, an attacker can spoof or control those channels.  
**Evidence:** `channels.slack.botToken`, `channels.slack.appToken`, and other tokens in `~/.openclaw/openclaw.json`.  
**Fix:** Move tokens to env, rotate, and keep `allowlist`/`pairing` policies strict.

**[M-2] Tools web search key stored in config.**  
**Impact:** Low direct risk, but still a key that could be abused.  
**Evidence:** `tools.web.search.apiKey`.  
**Fix:** Move to env and rotate.

### Low

**[L-1] Wide set of skills installed and enabled.**  
**Impact:** Mostly operational risk: accidental invocation or maintenance overhead.  
**Evidence:** `skills/*` directory inventory and `skills.entries.*` in config.  
**Fix:** Disable unused skills and remove any unused API keys from config.

---

## Mid-Level Hardening Recommendations (Actionable)

### A) Reduce network exposure

- **Gateway bind:** set `gateway.bind` to `loopback` (local only) or `tailnet` (Tailscale only).
- **No port forwards on your main router** to the gateway. Use Tailscale or SSH tunnels for remote access instead.
- **ngrok ingress:** only the webhook port is exposed; don’t run additional tunnels unless necessary.

### B) Externalize and rotate secrets

- **Move all keys out of `~/.openclaw/openclaw.json`.**  
  Use env vars like:
  - `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
  - `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` (or per-channel env if supported)
- **Rotate every key currently embedded** in the config after you move them.

### C) Tighten inbound channels

- **WhatsApp:** keep `dmPolicy: allowlist` and `groupPolicy: allowlist`.
- **Slack:** reduce the number of allowed channels, set `requireMention: true` where possible.
- **Voice-call:** keep `inboundPolicy: allowlist`, restrict `allowFrom`.

### D) Log and audit

- Periodically review `~/.openclaw/logs/gateway.log` for unexpected inbound activity.
- Keep the gateway token/password unique and stored outside config.

---

## Router Isolation Strategy (Extra Router as “Security Subnet”)

Goal: isolate the OpenClaw gateway host and Pi from your primary home network while still allowing outbound internet.

**Recommended topology (simple and effective):**

```
Primary Router (Home LAN: 192.168.1.0/24)
  |
  |—> WAN port of Extra Router
         |
         └── OpenClaw Subnet (e.g., 192.168.50.0/24)
             - Gateway host
             - Raspberry Pi 5
```

**Key settings on the extra router:**

- **WAN = DHCP from primary router** (double NAT).
- **LAN = new subnet** (e.g., `192.168.50.1/24`).
- **Disable UPnP**.
- **Disable inter‑LAN routing** (some routers call this “Isolate LAN from WAN” or “Block private networks”).
- **Only allow outbound traffic** from the extra router’s LAN to the internet.
- **No port forwards** on either router.

This makes your OpenClaw hosts invisible to devices on your main home network unless you explicitly route between them.

---

## Raspberry Pi 5 Setup (Start-to-Finish Guide)

### 1) Image the SD card

1. Use **Raspberry Pi Imager**.
2. Choose **Raspberry Pi OS Lite (64‑bit)**.
3. In “Advanced options”:
   - Set hostname (e.g., `openclaw-pi`).
   - Enable SSH (password or key).
   - Set username/password.
   - (Optional) Configure Wi‑Fi — but prefer Ethernet for stability.

### 2) First boot + baseline hardening

```bash
ssh <user>@openclaw-pi
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y ufw fail2ban
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw enable
```

### 3) Create a static IP on the isolated subnet

Option A: **DHCP reservation** on the extra router (recommended).  
Option B: **Static IP** in `dhcpcd.conf`:

```bash
sudo nano /etc/dhcpcd.conf
# Add:
interface eth0
static ip_address=192.168.50.10/24
static routers=192.168.50.1
static domain_name_servers=1.1.1.1 8.8.8.8
```

Then:

```bash
sudo systemctl restart dhcpcd
```

### 4) Lock down SSH

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys <<'EOF'
<your-ssh-public-key>
EOF
chmod 600 ~/.ssh/authorized_keys
```

Then disable password auth:

```bash
sudo nano /etc/ssh/sshd_config
# Set:
PasswordAuthentication no
PermitRootLogin no
```

```bash
sudo systemctl restart ssh
```

### 5) Install OpenClaw (on Pi if desired)

If the Pi will run the gateway, install OpenClaw normally, then configure:

- `gateway.bind: "loopback"` or `gateway.bind: "tailnet"`
- `gateway.auth.mode: "token"`
- Use env vars for keys

If the Pi is only a node, keep the gateway on your main machine and connect via Tailscale or SSH.

### 6) Add Tailscale (optional but recommended)

If you need remote access without public exposure:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Then set `gateway.bind: "tailnet"` on the gateway host.

---

## Suggested Next Steps (Priority Order)

1. **Move all secrets out of `~/.openclaw/openclaw.json`**, then rotate keys.
2. **Change `gateway.bind` to `loopback` or `tailnet`**.
3. **Put gateway + Pi on the isolated subnet** behind your extra router.
4. **Harden SSH and update the Pi** as outlined above.

---

## Appendix: Known Active Integrations from Your Config

- Channels: Slack, WhatsApp, iMessage (enabled in config)
- Plugins: voice-call (Twilio + ngrok)
- Skills with API keys: multiple entries (OpenAI, Gemini, ElevenLabs, etc.)

If you want, I can produce a sanitized, env‑based version of your `openclaw.json` and a key‑rotation checklist.
