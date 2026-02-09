---
summary: "OpenClaw op Oracle Cloud (Always Free ARM)"
read_when:
  - OpenClaw instellen op Oracle Cloud
  - Op zoek naar goedkope VPS-hosting voor OpenClaw
  - Wil 24/7 OpenClaw op een kleine server
title: "Oracle Cloud"
---

# OpenClaw op Oracle Cloud (OCI)

## Doel

Een persistente OpenClaw Gateway draaien op de **Always Free** ARM-laag van Oracle Cloud.

De gratis laag van Oracle kan een goede keuze zijn voor OpenClaw (vooral als je al een OCI-account hebt), maar er zijn wel afwegingen:

- ARM-architectuur (de meeste dingen werken, maar sommige binaries zijn mogelijk alleen x86)
- Capaciteit en aanmelding kunnen grillig zijn

## Kostenvergelijking (2026)

| Provider     | Plan            | Specificaties        | Prijs/maand          | Notities                   |
| ------------ | --------------- | -------------------- | -------------------- | -------------------------- |
| Oracle Cloud | Always Free ARM | tot 4 OCPU, 24GB RAM | $0                   | ARM, beperkte capaciteit   |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM      | ~ $4 | Goedkoopste betaalde optie |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM      | $6                   | Eenvoudige UI, goede docs  |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM      | $6                   | Veel locaties              |
| Linode       | Nanode          | 1 vCPU, 1GB RAM      | $5                   | Nu onderdeel van Akamai    |

---

## Vereisten

- Oracle Cloud-account ([aanmelden](https://www.oracle.com/cloud/free/)) — zie de [community-aanmeldgids](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) als je tegen problemen aanloopt
- Tailscale-account (gratis op [tailscale.com](https://tailscale.com))
- ~30 minuten

## 1. Een OCI-instantie maken

1. Log in op de [Oracle Cloud Console](https://cloud.oracle.com/)
2. Ga naar **Compute → Instances → Create Instance**
3. Configureer:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (of tot 4)
   - **Memory:** 12 GB (of tot 24 GB)
   - **Boot volume:** 50 GB (tot 200 GB gratis)
   - **SSH key:** Voeg je publieke sleutel toe
4. Klik op **Create**
5. Noteer het publieke IP-adres

**Tip:** Als het aanmaken van de instantie faalt met "Out of capacity", probeer een andere availability domain of probeer het later opnieuw. De capaciteit van de free tier is beperkt.

## 2. Verbinden en bijwerken

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Let op:** `build-essential` is vereist voor ARM-compilatie van sommige afhankelijkheden.

## 3. Gebruiker en hostnaam configureren

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Tailscale installeren

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Dit schakelt Tailscale SSH in, zodat je vanaf elk apparaat op je tailnet kunt verbinden via `ssh openclaw` — geen publiek IP nodig.

Verifiëren:

```bash
tailscale status
```

**Vanaf nu verbinden via Tailscale:** `ssh ubuntu@openclaw` (of gebruik het Tailscale-IP).

## 5. OpenClaw installeren

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Wanneer je wordt gevraagd "How do you want to hatch your bot?", kies **"Do this later"**.

> Let op: Als je tegen ARM-native buildproblemen aanloopt, begin met systeempakketten (bijv. `sudo apt install -y build-essential`) voordat je naar Homebrew grijpt.

## 6. Gateway configureren (loopback + tokenauthenticatie) en Tailscale Serve inschakelen

Gebruik tokenauthenticatie als standaard. Dit is voorspelbaar en voorkomt dat je “insecure auth”-flags in de Control UI nodig hebt.

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. Verifiëren

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. VCN-beveiliging vergrendelen

Nu alles werkt, vergrendel je de VCN om al het verkeer behalve Tailscale te blokkeren. Het Virtual Cloud Network van OCI fungeert als firewall aan de netwerkgrens — verkeer wordt geblokkeerd voordat het je instantie bereikt.

1. Ga in de OCI Console naar **Networking → Virtual Cloud Networks**
2. Klik op je VCN → **Security Lists** → Default Security List
3. **Verwijder** alle ingress-regels behalve:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Behoud de standaard egress-regels (alles uitgaand toestaan)

Dit blokkeert SSH op poort 22, HTTP, HTTPS en alles daarbuiten aan de netwerkgrens. Vanaf nu kun je alleen nog verbinden via Tailscale.

---

## Toegang tot de Control UI

Vanaf elk apparaat op je Tailscale-netwerk:

```
https://openclaw.<tailnet-name>.ts.net/
```

Vervang `<tailnet-name>` door je tailnet-naam (zichtbaar in `tailscale status`).

Geen SSH-tunnel nodig. Tailscale biedt:

- HTTPS-versleuteling (automatische certificaten)
- Authenticatie via Tailscale-identiteit
- Toegang vanaf elk apparaat op je tailnet (laptop, telefoon, enz.)

---

## Beveiliging: VCN + Tailscale (aanbevolen basis)

Met de VCN vergrendeld (alleen UDP 41641 open) en de Gateway gebonden aan local loopback, krijg je sterke defense-in-depth: publiek verkeer wordt aan de netwerkgrens geblokkeerd en beheerstoegang loopt via je tailnet.

Deze setup neemt vaak de _noodzaak_ weg voor extra host-gebaseerde firewallregels puur om internetbrede SSH-bruteforce te stoppen — maar je moet het OS wel up-to-date houden, `openclaw security audit` uitvoeren en verifiëren dat je niet per ongeluk luistert op publieke interfaces.

### Wat al is beschermd

| Traditionele stap       | Benodigd?    | Waarom                                                                                          |
| ----------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| UFW firewall            | Nee          | VCN blokkeert verkeer voordat het de instantie bereikt                                          |
| fail2ban                | Nee          | Geen bruteforce als poort 22 op VCN is geblokkeerd                                              |
| sshd hardening          | Nee          | Tailscale SSH gebruikt geen sshd                                                                |
| Root-login uitschakelen | Nee          | Tailscale gebruikt Tailscale-identiteit, geen systeemgebruikers                                 |
| Alleen SSH-sleutels     | Nee          | Tailscale authenticeert via je tailnet                                                          |
| IPv6 hardening          | Meestal niet | Hangt af van je VCN/subnet-instellingen; verifieer wat daadwerkelijk is toegewezen/blootgesteld |

### Nog steeds aanbevolen

- **Referentierechten:** `chmod 700 ~/.openclaw`
- **Beveiligingsaudit:** `openclaw security audit`
- **Systeemupdates:** voer `sudo apt update && sudo apt upgrade` regelmatig uit
- **Tailscale monitoren:** controleer apparaten in de [Tailscale admin console](https://login.tailscale.com/admin)

### Beveiligingsstatus verifiëren

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Terugvaloptie: SSH-tunnel

Als Tailscale Serve niet werkt, gebruik een SSH-tunnel:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Open daarna `http://localhost:18789`.

---

## Problemen oplossen

### Aanmaken van instantie faalt ("Out of capacity")

Free tier ARM-instanties zijn populair. Probeer:

- Een andere availability domain
- Opnieuw proberen buiten piekuren (vroeg in de ochtend)
- De filter "Always Free" gebruiken bij het selecteren van de shape

### Tailscale maakt geen verbinding

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway start niet

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Control UI niet bereikbaar

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM-binaryproblemen

Sommige tools hebben mogelijk geen ARM-builds. Controleer:

```bash
uname -m  # Should show aarch64
```

De meeste npm-pakketten werken prima. Voor binaries, zoek naar `linux-arm64` of `aarch64` releases.

---

## Persistentie

Alle status staat in:

- `~/.openclaw/` — config, referenties, sessiegegevens
- `~/.openclaw/workspace/` — werkruimte (SOUL.md, geheugen, artefacten)

Maak periodiek back-ups:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Zie ook

- [Gateway remote access](/gateway/remote) — andere patronen voor externe toegang
- [Tailscale integration](/gateway/tailscale) — volledige Tailscale-documentatie
- [Gateway configuration](/gateway/configuration) — alle configuratieopties
- [DigitalOcean guide](/platforms/digitalocean) — als je betaald + eenvoudiger aanmelden wilt
- [Hetzner guide](/install/hetzner) — Docker-gebaseerd alternatief
