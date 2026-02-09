---
summary: "OpenClaw op DigitalOcean (eenvoudige betaalde VPS-optie)"
read_when:
  - OpenClaw instellen op DigitalOcean
  - Op zoek naar goedkope VPS-hosting voor OpenClaw
title: "DigitalOcean"
---

# OpenClaw op DigitalOcean

## Doel

Een persistente OpenClaw Gateway draaien op DigitalOcean voor **$6/maand** (of $4/maand met gereserveerde prijzen).

Wil je een optie van $0/maand en vind je ARM + provider-specifieke installatie geen probleem, zie dan de [Oracle Cloud-gids](/platforms/oracle).

## Kostenvergelijking (2026)

| Provider     | Plan            | Specificaties        | Prijs/maand                                    | Notities                                 |
| ------------ | --------------- | -------------------- | ---------------------------------------------- | ---------------------------------------- |
| Oracle Cloud | Always Free ARM | tot 4 OCPU, 24GB RAM | $0                                             | ARM, beperkte capaciteit / aanmeldquirks |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM      | €3,79 (~$4) | Goedkoopste betaalde optie               |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM      | $6                                             | Eenvoudige UI, goede documentatie        |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM      | $6                                             | Veel locaties                            |
| Linode       | Nanode          | 1 vCPU, 1GB RAM      | $5                                             | Nu onderdeel van Akamai                  |

**Een provider kiezen:**

- DigitalOcean: eenvoudigste UX + voorspelbare installatie (deze gids)
- Hetzner: goede prijs/prestatie (zie [Hetzner-gids](/install/hetzner))
- Oracle Cloud: kan $0/maand zijn, maar is kieskeuriger en alleen ARM (zie [Oracle-gids](/platforms/oracle))

---

## Vereisten

- DigitalOcean-account ([aanmelden met $200 gratis tegoed](https://m.do.co/c/signup))
- SSH-sleutelpaar (of bereidheid om wachtwoordauthenticatie te gebruiken)
- ~20 minuten

## 1. Maak een Droplet aan

1. Log in op [DigitalOcean](https://cloud.digitalocean.com/)
2. Klik op **Create → Droplets**
3. Kies:
   - **Regio:** Het dichtst bij jou (of je gebruikers)
   - **Image:** Ubuntu 24.04 LTS
   - **Grootte:** Basic → Regular → **$6/maand** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authenticatie:** SSH-sleutel (aanbevolen) of wachtwoord
4. Klik op **Create Droplet**
5. Noteer het IP-adres

## 2) Verbinden via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. OpenClaw installeren

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. Onboarding uitvoeren

```bash
openclaw onboard --install-daemon
```

De wizard leidt je door:

- Modelauthenticatie (API-sleutels of OAuth)
- Kanaalconfiguratie (Telegram, WhatsApp, Discord, enz.)
- Gateway-token (automatisch gegenereerd)
- Daemon-installatie (systemd)

## 5. De Gateway verifiëren

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Toegang tot het Dashboard

De gateway bindt standaard aan local loopback. Om toegang te krijgen tot de Control UI:

**Optie A: SSH-tunnel (aanbevolen)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Optie B: Tailscale Serve (HTTPS, alleen loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Open: `https://<magicdns>/`

Notities:

- Serve houdt de Gateway loopback-only en authenticeert via Tailscale-identiteitsheaders.
- Om in plaats daarvan een token/wachtwoord te vereisen, stel `gateway.auth.allowTailscale: false` in of gebruik `gateway.auth.mode: "password"`.

**Optie C: Tailnet-binding (geen Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Open: `http://<tailscale-ip>:18789` (token vereist).

## 7. Verbind je kanalen

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

Zie [Kanalen](/channels) voor andere providers.

---

## Optimalisaties voor 1GB RAM

De $6-droplet heeft slechts 1GB RAM. Om alles soepel te laten draaien:

### Swap toevoegen (aanbevolen)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Een lichter model gebruiken

Als je OOM's tegenkomt, overweeg dan:

- API-gebaseerde modellen gebruiken (Claude, GPT) in plaats van lokale modellen
- `agents.defaults.model.primary` instellen op een kleiner model

### Geheugen monitoren

```bash
free -h
htop
```

---

## Persistentie

Alle status bevindt zich in:

- `~/.openclaw/` — config, referenties, sessiegegevens
- `~/.openclaw/workspace/` — werkruimte (SOUL.md, geheugen, enz.)

Deze blijven behouden na herstarts. Maak er periodiek back-ups van:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud Free-alternatief

Oracle Cloud biedt **Always Free** ARM-instances die aanzienlijk krachtiger zijn dan elke betaalde optie hier — voor $0/maand.

| Wat je krijgt     | Specificaties             |
| ----------------- | ------------------------- |
| **4 OCPU's**      | ARM Ampere A1             |
| **24GB RAM**      | Meer dan voldoende        |
| **200GB opslag**  | Block volume              |
| **Altijd gratis** | Geen kosten op creditcard |

**Kanttekeningen:**

- Aanmelden kan kieskeurig zijn (opnieuw proberen als het mislukt)
- ARM-architectuur — de meeste dingen werken, maar sommige binaries hebben ARM-builds nodig

Voor de volledige installatiegids, zie [Oracle Cloud](/platforms/oracle). Voor aanmeldtips en probleemoplossing tijdens het inschrijfproces, zie deze [communitygids](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Problemen oplossen

### Gateway start niet

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Poort al in gebruik

```bash
lsof -i :18789
kill <PID>
```

### Onvoldoende geheugen

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Zie ook

- [Hetzner-gids](/install/hetzner) — goedkoper, krachtiger
- [Docker-installatie](/install/docker) — containerized setup
- [Tailscale](/gateway/tailscale) — veilige externe toegang
- [Configuratie](/gateway/configuration) — volledige config-referentie
