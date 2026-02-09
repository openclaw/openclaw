---
summary: "Geautomatiseerde, geharde OpenClaw-installatie met Ansible, Tailscale VPN en firewallisolatie"
read_when:
  - Je wilt geautomatiseerde serveruitrol met beveiligingsverharding
  - Je hebt een door de firewall geïsoleerde installatie met VPN-toegang nodig
  - Je implementeert op externe Debian/Ubuntu-servers
title: "Ansible"
---

# Ansible-installatie

De aanbevolen manier om OpenClaw op productieservers te implementeren is via **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — een geautomatiseerde installer met een security-first architectuur.

## Snelle start

Installatie met één opdracht:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Volledige handleiding: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> De openclaw-ansible-repo is de bron van waarheid voor Ansible-implementatie. Deze pagina is een kort overzicht.

## Wat je krijgt

- 🔒 **Firewall-first beveiliging**: UFW + Docker-isolatie (alleen SSH + Tailscale toegankelijk)
- 🔐 **Tailscale VPN**: Veilige externe toegang zonder services publiek bloot te stellen
- 🐳 **Docker**: Geïsoleerde sandboxcontainers, alleen localhost-bindingen
- 🛡️ **Defense in depth**: 4-laagse beveiligingsarchitectuur
- 🚀 **Installatie met één opdracht**: Volledige implementatie in minuten
- 🔧 **Systemd-integratie**: Automatisch starten bij boot met verharding

## Provideropties

- **OS**: Debian 11+ of Ubuntu 20.04+
- **Toegang**: Root- of sudo-rechten
- **Netwerk**: Internetverbinding voor pakketinstallatie
- **Ansible**: 2.14+ (wordt automatisch geïnstalleerd door het quick-startscript)

## Wat wordt geïnstalleerd

Het Ansible-playbook installeert en configureert:

1. **Tailscale** (mesh VPN voor veilige externe toegang)
2. **UFW firewall** (alleen SSH- en Tailscale-poorten)
3. **Docker CE + Compose V2** (voor agent-sandboxes)
4. **Node.js 22.x + pnpm** (runtime-afhankelijkheden)
5. **OpenClaw** (host-gebaseerd, niet gecontaineriseerd)
6. **Systemd-service** (automatisch starten met beveiligingsverharding)

Let op: De Gateway draait **direct op de host** (niet in Docker), maar agent-sandboxes gebruiken Docker voor isolatie. Zie [Sandboxing](/gateway/sandboxing) voor details.

## Post-installatie

Na voltooiing van de installatie, schakel over naar de openclaw-gebruiker:

```bash
sudo -i -u openclaw
```

Het post-installatiescript begeleidt je bij:

1. **Onboarding-wizard**: OpenClaw-instellingen configureren
2. **Provider-login**: WhatsApp/Telegram/Discord/Signal koppelen
3. **Gateway-testen**: De installatie verifiëren
4. **Tailscale-installatie**: Verbinden met je VPN-mesh

### Snelle opdrachten

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

## Beveiligingsarchitectuur

### 4-laagse verdediging

1. **Firewall (UFW)**: Alleen SSH (22) + Tailscale (41641/udp) publiek blootgesteld
2. **VPN (Tailscale)**: Gateway alleen toegankelijk via VPN-mesh
3. **Docker-isolatie**: DOCKER-USER iptables-keten voorkomt externe poortblootstelling
4. **Systemd-verharding**: NoNewPrivileges, PrivateTmp, ongeprivilegieerde gebruiker

### Verificatie

Test het externe aanvalsoppervlak:

```bash
nmap -p- YOUR_SERVER_IP
```

Moet **alleen poort 22** (SSH) tonen als open. Alle andere services (Gateway, Docker) zijn vergrendeld.

### Docker-beschikbaarheid

Docker is geïnstalleerd voor **agent-sandboxes** (geïsoleerde tooluitvoering), niet om de Gateway zelf te draaien. De Gateway bindt alleen aan localhost en is toegankelijk via Tailscale VPN.

Zie [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) voor sandboxconfiguratie.

## Handmatige installatie

Als je de voorkeur geeft aan handmatige controle over de automatisering:

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

## OpenClaw bijwerken

De Ansible-installer configureert OpenClaw voor handmatige updates. Zie [Updating](/install/updating) voor de standaard updateflow.

Om het Ansible-playbook opnieuw uit te voeren (bijv. voor configuratiewijzigingen):

```bash
cd openclaw-ansible
./run-playbook.sh
```

Let op: Dit is idempotent en veilig om meerdere keren uit te voeren.

## Problemen oplossen

### Firewall blokkeert mijn verbinding

Als je bent buitengesloten:

- Zorg dat je eerst via Tailscale VPN toegang hebt
- SSH-toegang (poort 22) is altijd toegestaan
- De Gateway is **alleen** via Tailscale toegankelijk, bewust zo ontworpen

### Service start niet

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

### Docker-sandboxproblemen

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Provider-login mislukt

Zorg dat je draait als de `openclaw`-gebruiker:

```bash
sudo -i -u openclaw
openclaw channels login
```

## Geavanceerde configuratie

Voor gedetailleerde beveiligingsarchitectuur en probleemoplossing:

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Gerelateerd

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — volledige implementatiehandleiding
- [Docker](/install/docker) — gecontaineriseerde Gateway-installatie
- [Sandboxing](/gateway/sandboxing) — agent-sandboxconfiguratie
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — isolatie per agent
