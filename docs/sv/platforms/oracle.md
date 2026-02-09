---
summary: "OpenClaw på Oracle Cloud (Always Free ARM)"
read_when:
  - Konfigurera OpenClaw på Oracle Cloud
  - Letar efter lågkostnads-VPS-hosting för OpenClaw
  - Vill ha OpenClaw igång dygnet runt på en liten server
title: "Oracle Cloud"
---

# OpenClaw på Oracle Cloud (OCI)

## Mål

Kör en persistent OpenClaw Gateway på Oracle Clouds **Always Free** ARM-nivå.

Oracles gratisnivå kan vara ett bra val för OpenClaw (särskilt om du redan har ett OCI-konto), men den kommer med vissa kompromisser:

- ARM-arkitektur (det mesta fungerar, men vissa binärer kan vara x86‑endast)
- Kapacitet och registrering kan vara opålitliga

## Kostnadsjämförelse (2026)

| Leverantör   | Plan            | Specifikationer            | Pris/mån             | Noteringar                      |
| ------------ | --------------- | -------------------------- | -------------------- | ------------------------------- |
| Oracle Cloud | Always Free ARM | upp till 4 OCPU, 24 GB RAM | $0                   | ARM, begränsad kapacitet        |
| Hetzner      | CX22            | 2 vCPU, 4 GB RAM           | ~ $4 | Billigaste betalda alternativet |
| DigitalOcean | Basic           | 1 vCPU, 1 GB RAM           | $6                   | Enkelt UI, bra dokumentation    |
| Vultr        | Cloud Compute   | 1 vCPU, 1 GB RAM           | $6                   | Många platser                   |
| Linode       | Nanode          | 1 vCPU, 1 GB RAM           | $5                   | Numera del av Akamai            |

---

## Förutsättningar

- Oracle Cloud-konto ([registrering](https://www.oracle.com/cloud/free/)) — se [community-guide för registrering](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) om du stöter på problem
- Tailscale-konto (gratis på [tailscale.com](https://tailscale.com))
- ~30 minuter

## 1. Skapa en OCI-instans

1. Logga in på [Oracle Cloud Console](https://cloud.oracle.com/)
2. Navigera till **Compute → Instances → Create Instance**
3. Konfigurera:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (eller upp till 4)
   - **Memory:** 12 GB (eller upp till 24 GB)
   - **Boot volume:** 50 GB (upp till 200 GB gratis)
   - **SSH key:** Lägg till din publika nyckel
4. Klicka på **Create**
5. Notera den publika IP-adressen

**Tips:** Om instansskapande misslyckas med "Utanför kapacitet", prova en annan tillgänglighetsdomän eller försök igen senare. Den fria kapaciteten är begränsad.

## 2. Anslut och uppdatera

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Obs:** `build-essential` krävs för ARM-kompilering av vissa beroenden.

## 3. Konfigurera användare och värdnamn

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Installera Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Detta aktiverar Tailscale SSH, så att du kan ansluta via `ssh openclaw` från vilken enhet som helst i ditt tailnet — ingen publik IP behövs.

Verifiera:

```bash
tailscale status
```

**Från och med nu, anslut via Tailscale:** `ssh ubuntu@openclaw` (eller använd Tailscale-IP:n).

## 5. Installera OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

När du får frågan ”How do you want to hatch your bot?”, välj **”Do this later”**.

> Obs: Om du träffar på ARM-native kompileringsproblem, börja med systempaket (t.ex. `sudo apt install -y build-essential`) innan du når Homebrew.

## 6. Konfigurera Gateway (loopback + tokenautentisering) och aktivera Tailscale Serve

Använd token auth som standard. Det är förutsägbart och undviker att behöva någon "osäker författa" Control UI flaggor.

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

## 7. Verifiera

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

## 8. Lås ner VCN-säkerheten

Nu när allt fungerar, lås VCN för att blockera all trafik utom Tailscale. OCI:s virtuella molnnätverk fungerar som en brandvägg vid nätverkskanten – trafiken blockeras innan den når din instans.

1. Gå till **Networking → Virtual Cloud Networks** i OCI Console
2. Klicka på ditt VCN → **Security Lists** → Default Security List
3. **Ta bort** alla ingressregler utom:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Behåll standardreglerna för egress (tillåt all utgående trafik)

Detta blockerar SSH på port 22, HTTP, HTTPS, och allt annat på nätverkskanten. Från och med nu kan du bara ansluta via Tailscale.

---

## Åtkomst till Control UI

Från valfri enhet i ditt Tailscale-nätverk:

```
https://openclaw.<tailnet-name>.ts.net/
```

Ersätt `<tailnet-name>` med namnet på ditt tailnet (synligt i `tailscale status`).

Ingen SSH-tunnel behövs. Skräddarskala erbjuder:

- HTTPS-kryptering (automatiska certifikat)
- Autentisering via Tailscale-identitet
- Åtkomst från valfri enhet i ditt tailnet (laptop, telefon, etc.)

---

## Säkerhet: VCN + Tailscale (rekommenderad baslinje)

Med VCN låst (endast UDP 41641 öppet) och Gateway bunden till loopback får du ett starkt försvar i flera lager: publik trafik blockeras vid nätverkskanten, och administrativ åtkomst sker via ditt tailnet.

Den här konfigurationen eliminerar ofta _behovet_ av extra värdbaserade brandväggsregler enbart för att stoppa SSH-bruteforce från Internet — men du bör fortfarande hålla operativsystemet uppdaterat, köra `openclaw security audit`, och verifiera att du inte av misstag lyssnar på publika gränssnitt.

### Vad som redan är skyddat

| Traditionellt steg         | Behövs?     | Varför                                                                                    |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| UFW-brandvägg              | Nej         | VCN blockerar innan trafiken når instansen                                                |
| fail2ban                   | Nej         | Ingen bruteforce om port 22 blockeras i VCN                                               |
| sshd-härdning              | Nej         | Tailscale SSH använder inte sshd                                                          |
| Inaktivera root-inloggning | Nej         | Tailscale använder Tailscale-identitet, inte systemanvändare                              |
| Endast SSH-nycklar         | Nej         | Tailscale autentiserar via ditt tailnet                                                   |
| IPv6-härdning              | Oftast inte | Beror på dina VCN-/subnetinställningar; verifiera vad som faktiskt är tilldelat/exponerat |

### Fortfarande rekommenderat

- **Behörigheter för inloggningsuppgifter:** `chmod 700 ~/.openclaw`
- **Säkerhetsgranskning:** `openclaw security audit`
- **Systemuppdateringar:** kör `sudo apt update && sudo apt upgrade` regelbundet
- **Övervaka Tailscale:** granska enheter i [Tailscale admin console](https://login.tailscale.com/admin)

### Verifiera säkerhetsläget

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Reservlösning: SSH-tunnel

Om Tailscale Serve inte fungerar, använd en SSH-tunnel:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Öppna sedan `http://localhost:18789`.

---

## Felsökning

### Skapande av instans misslyckas (”Out of capacity”)

Free tier ARM instanser är populära. Prova:

- En annan availability domain
- Försök igen under lågtrafik (tidig morgon)
- Använd filtret ”Always Free” när du väljer shape

### Tailscale ansluter inte

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway startar inte

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Kan inte nå Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM-binärproblem

Vissa verktyg kanske inte har ARM-byggen. Kontroll:

```bash
uname -m  # Should show aarch64
```

De flesta npm paket fungerar bra. För binärer, sök efter `linux-arm64` eller `aarch64` utgåvor.

---

## Persistens

Allt tillstånd lagras i:

- `~/.openclaw/` — konfig, inloggningsuppgifter, sessionsdata
- `~/.openclaw/workspace/` — arbetsyta (SOUL.md, minne, artefakter)

Säkerhetskopiera regelbundet:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Se även

- [Gateway fjärråtkomst](/gateway/remote) — andra mönster för fjärråtkomst
- [Tailscale-integration](/gateway/tailscale) — fullständig Tailscale-dokumentation
- [Gateway-konfiguration](/gateway/configuration) — alla konfigurationsalternativ
- [DigitalOcean-guide](/platforms/digitalocean) — om du vill ha betalt + enklare registrering
- [Hetzner-guide](/install/hetzner) — Docker-baserat alternativ
