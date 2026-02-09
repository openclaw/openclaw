---
summary: "OpenClaw på DigitalOcean (enkelt betalt VPS-alternativ)"
read_when:
  - Konfigurera OpenClaw på DigitalOcean
  - Letar efter billig VPS-hosting för OpenClaw
title: "DigitalOcean"
---

# OpenClaw på DigitalOcean

## Mål

Kör en persistent OpenClaw Gateway på DigitalOcean för **6 USD/månad** (eller 4 USD/månad med reserverad prissättning).

Om du vill ha ett alternativ för 0 USD/månad och inte har något emot ARM + leverantörsspecifik setup, se [Oracle Cloud-guiden](/platforms/oracle).

## Kostnadsjämförelse (2026)

| Leverantör   | Plan            | Specifikationer           | Pris/mån                                       | Noteringar                                         |
| ------------ | --------------- | ------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Oracle Cloud | Always Free ARM | upp till 4 OCPU, 24GB RAM | $0                                             | ARM, begränsad kapacitet / quirks vid registrering |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM           | €3,79 (~$4) | Billigaste betalda alternativet                    |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM           | $6                                             | Enkelt UI, bra dokumentation                       |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM           | $6                                             | Många platser                                      |
| Linode       | Nanode          | 1 vCPU, 1GB RAM           | $5                                             | Numera del av Akamai                               |

**Välja leverantör:**

- DigitalOcean: enklast UX + förutsägbar setup (denna guide)
- Hetzner: bra pris/prestanda (se [Hetzner-guiden](/install/hetzner))
- Oracle Cloud: kan vara 0 USD/månad, men är mer pilligt och endast ARM (se [Oracle-guiden](/platforms/oracle))

---

## Förutsättningar

- DigitalOcean-konto ([registrera dig med $200 i gratis kredit](https://m.do.co/c/signup))
- SSH-nyckelpar (eller vilja att använda lösenordsautentisering)
- ~20 minuter

## 1. Skapa en Droplet

1. Logga in på [DigitalOcean](https://cloud.digitalocean.com/)
2. Klicka på **Create → Droplets**
3. Välj:
   - **Region:** Närmast dig (eller dina användare)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/mån** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH-nyckel (rekommenderas) eller lösenord
4. Klicka på **Create Droplet**
5. Notera IP-adressen

## 2) Anslut via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. Installera OpenClaw

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

## 4. Kör introduktionen

```bash
openclaw onboard --install-daemon
```

Guiden tar dig igenom:

- Modellautentisering (API-nycklar eller OAuth)
- Kanalsetup (Telegram, WhatsApp, Discord, m.fl.)
- Gateway-token (autogenererad)
- Daemon-installation (systemd)

## 5. Verifiera Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Få åtkomst till Dashboard

Gateway binder till loopback som standard. För att komma åt kontrollgränssnittet:

**Alternativ A: SSH-tunnel (rekommenderas)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Alternativ B: Tailscale Serve (HTTPS, endast loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Öppna: `https://<magicdns>/`

Noteringar:

- Serve håller Gateway loopback-only och autentiserar via Tailscale-identitetshuvuden.
- För att kräva token/lösenord istället, sätt `gateway.auth.allowTailscale: false` eller använd `gateway.auth.mode: "password"`.

**Alternativ C: Tailnet-bindning (ingen Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Öppna: `http://<tailscale-ip>:18789` (token krävs).

## 7. Anslut dina kanaler

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

Se [Kanaler](/channels) för andra leverantörer.

---

## Optimeringar för 1GB RAM

$6 droppe har bara 1GB RAM. För att få saker att fungera smidigt:

### Lägg till swap (rekommenderas)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Använd en lättare modell

Om du får OOM-fel, överväg att:

- Använda API-baserade modeller (Claude, GPT) istället för lokala modeller
- Sätta `agents.defaults.model.primary` till en mindre modell

### Övervaka minne

```bash
free -h
htop
```

---

## Persistens

Allt tillstånd lagras i:

- `~/.openclaw/` — konfig, autentiseringsuppgifter, sessionsdata
- `~/.openclaw/workspace/` — workspace (SOUL.md, minne, m.m.)

Dessa överlever omstarter. Säkerhetskopiera dem regelbundet:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud Free-alternativ

Oracle Cloud erbjuder **Always Free** ARM-instanser som är betydligt kraftfullare än alla betalda alternativ här — för 0 USD/månad.

| Vad du får                    | Specifikationer              |
| ----------------------------- | ---------------------------- |
| **4 OCPU:er** | ARM Ampere A1                |
| **24GB RAM**                  | Mer än tillräckligt          |
| **200GB lagring**             | Blockvolym                   |
| **För alltid gratis**         | Inga kreditkortsdebiteringar |

**Begränsningar:**

- Registreringen kan vara pillig (försök igen om det misslyckas)
- ARM-arkitektur — det mesta fungerar, men vissa binärer kräver ARM-byggen

För hela installationsguiden, se [Oracle Cloud](/platforms/oracle). För anmälningstips och felsökning av inskrivningsprocessen, se denna [communityguide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Felsökning

### Gateway startar inte

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Porten används redan

```bash
lsof -i :18789
kill <PID>
```

### Slut på minne

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Se även

- [Hetzner-guiden](/install/hetzner) — billigare, kraftfullare
- [Docker-installation](/install/docker) — containerbaserad setup
- [Tailscale](/gateway/tailscale) — säker fjärråtkomst
- [Konfiguration](/gateway/configuration) — fullständig konfigreferens
