---
summary: "Automatiserad, härdad OpenClaw-installation med Ansible, Tailscale VPN och brandväggsisolering"
read_when:
  - Du vill ha automatiserad serverdriftsättning med säkerhetshärdning
  - Du behöver en brandväggsisolerad installation med VPN-åtkomst
  - Du distribuerar till fjärrservrar med Debian/Ubuntu
title: "Ansible"
---

# Ansible-installation

Det rekommenderade sättet att distribuera OpenClaw till produktionsservrar är via **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — ett automatiserat installationsverktyg med säkerhet-först-arkitektur.

## Snabbstart

Installation med ett kommando:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Fullständig guide: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> Den öppen-ansible repo är källan till sanningen för Ansible utplacering. Denna sida är en snabb översikt.

## Vad du får

- 🔒 **Brandvägg-först-säkerhet**: UFW + Docker-isolering (endast SSH + Tailscale åtkomliga)
- 🔐 **Tailscale VPN**: Säker fjärråtkomst utan att exponera tjänster offentligt
- 🐳 **Docker**: Isolerade sandbox-containrar, bindningar endast till localhost
- 🛡️ **Defense in depth**: Säkerhetsarkitektur i 4 lager
- 🚀 **Installation med ett kommando**: Fullständig driftsättning på minuter
- 🔧 **Systemd-integration**: Autostart vid uppstart med härdning

## Förutsättningar

- **OS**: Debian 11+ eller Ubuntu 20.04+
- **Åtkomst**: Root- eller sudo-behörighet
- **Nätverk**: Internetanslutning för paketinstallation
- **Ansible**: 2.14+ (installeras automatiskt av snabbstartsskriptet)

## Vad som installeras

Ansible-playbooken installerar och konfigurerar:

1. **Tailscale** (mesh-VPN för säker fjärråtkomst)
2. **UFW-brandvägg** (endast SSH + Tailscale-portar)
3. **Docker CE + Compose V2** (för agent-sandboxar)
4. **Node.js 22.x + pnpm** (körtidsberoenden)
5. **OpenClaw** (värdbaserad, inte containeriserad)
6. **Systemd-tjänst** (autostart med säkerhetshärdning)

Obs: Gateway körs **direkt på värden** (inte i Docker), men agent sandlådor använder Docker för isolering. Se [Sandboxing](/gateway/sandboxing) för detaljer.

## Konfiguration efter installation

När installationen är klar, växla till användaren openclaw:

```bash
sudo -i -u openclaw
```

Efterinstallationsskriptet guidar dig genom:

1. **Introduktionsguide**: Konfigurera OpenClaw-inställningar
2. **Leverantörsinloggning**: Anslut WhatsApp/Telegram/Discord/Signal
3. **Gateway-testning**: Verifiera installationen
4. **Tailscale-konfiguration**: Anslut till ditt VPN-mesh

### Snabba kommandon

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## Säkerhetsarkitektur

### 4-lagers försvar

1. **Brandvägg (UFW)**: Endast SSH (22) + Tailscale (41641/udp) exponeras offentligt
2. **VPN (Tailscale)**: Gateway (nätverksgateway) är endast åtkomlig via VPN-mesh
3. **Docker-isolering**: iptables-kedjan DOCKER-USER förhindrar extern portexponering
4. **Systemd-härdning**: NoNewPrivileges, PrivateTmp, oprivilegierad användare

### Verifiering

Testa extern attackyta:

```bash
nmap -p- YOUR_SERVER_IP
```

Bör visa **endast port 22** (SSH) öppen. Alla andra tjänster (gateway, Docker) är låsta.

### Docker-tillgänglighet

Docker är installerat för **agent sandlådor** (isolerat verktygsutförande), inte för att köra själva gatewayen. Gateway binder endast till localhost och är tillgänglig via Tailscale VPN.

Se [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) för sandbox-konfiguration.

## Manuell installation

Om du föredrar manuell kontroll över automatiseringen:

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## Uppdatera OpenClaw

Den Ansible installeraren ställer in OpenClaw för manuella uppdateringar. Se [Updating](/install/updating) för standarduppdateringsflödet.

För att köra Ansible-playbooken igen (t.ex. vid konfigurationsändringar):

```bash
cd openclaw-ansible
./run-playbook.sh
```

Obs: Detta är idempotent och säkert att köra flera gånger.

## Felsökning

### Brandväggen blockerar min anslutning

Om du är utelåst:

- Säkerställ att du först kan nå via Tailscale VPN
- SSH-åtkomst (port 22) är alltid tillåten
- Gatewayn är **endast** åtkomlig via Tailscale enligt design

### Tjänsten startar inte

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Problem med Docker-sandbox

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Leverantörsinloggning misslyckas

Se till att du kör som användaren `openclaw`:

```bash
sudo -i -u openclaw
openclaw channels login
```

## Avancerad konfiguration

För detaljerad säkerhetsarkitektur och felsökning:

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Relaterat

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — fullständig distributionsguide
- [Docker](/install/docker) — containeriserad gateway-konfiguration
- [Sandboxing](/gateway/sandboxing) — konfiguration av agent-sandbox
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — isolering per agent
