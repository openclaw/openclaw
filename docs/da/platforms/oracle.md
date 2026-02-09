---
summary: "OpenClaw på Oracle Cloud (Always Free ARM)"
read_when:
  - Opsætning af OpenClaw på Oracle Cloud
  - Leder efter billig VPS-hosting til OpenClaw
  - Vil have OpenClaw kørende 24/7 på en lille server
title: "Oracle Cloud"
---

# OpenClaw på Oracle Cloud (OCI)

## Mål

Kør en vedvarende OpenClaw Gateway på Oracle Clouds **Always Free** ARM-tier.

Oracles gratis tier kan være et godt match til OpenClaw (især hvis du allerede har en OCI-konto), men den kommer med kompromiser:

- ARM-arkitektur (det meste virker, men nogle binærer kan være kun x86)
- Kapacitet og tilmelding kan være ustabil

## Omkostningssammenligning (2026)

| Udbyder      | Plan            | Specifikationer         | Pris/md              | Noter                      |
| ------------ | --------------- | ----------------------- | -------------------- | -------------------------- |
| Oracle Cloud | Always Free ARM | op til 4 OCPU, 24GB RAM | $0                   | ARM, begrænset kapacitet   |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM         | ~ $4 | Billigste betalte mulighed |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM         | $6                   | Nem UI, gode docs          |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM         | $6                   | Mange lokationer           |
| Linode       | Nanode          | 1 vCPU, 1GB RAM         | $5                   | Nu en del af Akamai        |

---

## Forudsætninger

- Oracle Cloud-konto ([tilmelding](https://www.oracle.com/cloud/free/)) — se [community-tilmeldingsguide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd), hvis du støder på problemer
- Tailscale-konto (gratis på [tailscale.com](https://tailscale.com))
- ~30 minutter

## 1. Opret en OCI-instans

1. Log ind i [Oracle Cloud Console](https://cloud.oracle.com/)
2. Gå til **Compute → Instances → Create Instance**
3. Konfigurér:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (eller op til 4)
   - **Memory:** 12 GB (eller op til 24 GB)
   - **Boot volume:** 50 GB (op til 200 GB gratis)
   - **SSH key:** Tilføj din offentlige nøgle
4. Klik **Create**
5. Notér den offentlige IP-adresse

**Tip:** Hvis oprettelse af instans mislykkes med "Ud af kapacitet", prøv et andet tilgængelighedsdomæne eller prøv igen senere. Frit niveau kapacitet er begrænset.

## 2. Forbind og opdatér

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Note:** `build-essential` er påkrævet for ARM-kompilering af nogle afhængigheder.

## 3. Konfigurér bruger og hostname

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Installér Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Dette aktiverer Tailscale SSH, så du kan forbinde via `ssh openclaw` fra enhver enhed på dit tailnet — ingen offentlig IP nødvendig.

Verificér:

```bash
tailscale status
```

**Fremover: forbind via Tailscale:** `ssh ubuntu@openclaw` (eller brug Tailscale-IP’en).

## 5. Installér OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Når du bliver spurgt "How do you want to hatch your bot?", vælg **"Do this later"**.

> Bemærk: Hvis du rammer ARM-indfødte byggeproblemer, skal du starte med systempakker (f.eks. 'sudo apt install -y build-essential'), før du når til Homebrew.

## 6. Konfigurér Gateway (loopback + token-auth) og aktivér Tailscale Serve

Brug token auth som standard. Det er forudsigeligt og undgår at behøve enhver “usikker auth” Control UI flag.

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

## 7. Verificér

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

## 8. Lås VCN-sikkerheden ned

Nu, hvor alt fungerer, låse VCN til at blokere al trafik undtagen Tailscale. OCI's Virtual Cloud Network fungerer som en firewall på netværkskanten - trafikken er blokeret, før den når frem til din instans.

1. Gå til **Networking → Virtual Cloud Networks** i OCI Console
2. Klik på din VCN → **Security Lists** → Default Security List
3. **Fjern** alle indgående regler undtagen:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Behold standard udgående regler (tillad al udgående trafik)

Dette blokerer SSH på port 22, HTTP, HTTPS, og alt andet ved netværkskanten. Fra nu af kan du kun oprette forbindelse via Tailscale.

---

## Få adgang til Control UI

Fra enhver enhed på dit Tailscale-netværk:

```
https://openclaw.<tailnet-name>.ts.net/
```

Erstat `<tailnet-name>` med navnet på dit tailnet (synligt i `tailscale status`).

Ingen SSH-tunnel nødvendig. Skræddersy leverer:

- HTTPS-kryptering (automatiske certifikater)
- Autentificering via Tailscale-identitet
- Adgang fra enhver enhed på dit tailnet (bærbar, telefon osv.)

---

## Sikkerhed: VCN + Tailscale (anbefalet baseline)

Med VCN’en låst ned (kun UDP 41641 åben) og Gateway bundet til loopback får du stærk defense-in-depth: offentlig trafik blokeres ved netværkskanten, og admin-adgang sker over dit tailnet.

Denne opsætning fjerner ofte _behovet_ for ekstra host-baserede firewallregler udelukkende for at stoppe internet-dækkende SSH brute force — men du bør stadig holde OS’et opdateret, køre `openclaw security audit`, og verificere, at du ikke ved en fejl lytter på offentlige interfaces.

### Hvad der allerede er beskyttet

| Traditionelt trin    | Nødvendigt?    | Hvorfor                                                                                     |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| UFW firewall         | Nej            | VCN blokerer før trafikken når instansen                                                    |
| fail2ban             | Nej            | Ingen brute force hvis port 22 er blokeret i VCN                                            |
| sshd-hærdning        | Nej            | Tailscale SSH bruger ikke sshd                                                              |
| Deaktiver root-login | Nej            | Tailscale bruger Tailscale-identitet, ikke systembrugere                                    |
| Kun SSH-nøgle-auth   | Nej            | Tailscale autentificerer via dit tailnet                                                    |
| IPv6-hærdning        | Som regel ikke | Afhænger af dine VCN/subnet-indstillinger; verificér hvad der faktisk er tildelt/eksponeret |

### Stadig anbefalet

- **Rettigheder til credentials:** `chmod 700 ~/.openclaw`
- **Sikkerhedsrevision:** `openclaw security audit`
- **Systemopdateringer:** Kør `sudo apt update && sudo apt upgrade` regelmæssigt
- **Overvåg Tailscale:** Gennemse enheder i [Tailscale admin console](https://login.tailscale.com/admin)

### Verificér sikkerhedsstatus

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Fallback: SSH-tunnel

Hvis Tailscale Serve ikke virker, så brug en SSH-tunnel:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Åbn derefter `http://localhost:18789`.

---

## Fejlfinding

### Oprettelse af instans fejler ("Out of capacity")

Gratis niveau ARM forekomster er populære. Try:

- Et andet availability domain
- Forsøg igen uden for spidsbelastning (tidlig morgen)
- Brug filteret "Always Free", når du vælger shape

### Tailscale vil ikke forbinde

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway vil ikke starte

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Kan ikke nå Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM-binærproblemer

Nogle værktøjer har muligvis ikke ARM builds. Tjek:

```bash
uname -m  # Should show aarch64
```

De fleste npm pakker fungerer fint. For binærer, se efter 'linux-arm64' eller 'aarch64' udgivelser.

---

## Persistens

Al tilstand ligger i:

- `~/.openclaw/` — konfiguration, credentials, sessionsdata
- `~/.openclaw/workspace/` — workspace (SOUL.md, hukommelse, artefakter)

Lav jævnligt backup:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Se også

- [Gateway remote access](/gateway/remote) — andre mønstre for fjernadgang
- [Tailscale integration](/gateway/tailscale) — fuld Tailscale-dokumentation
- [Gateway configuration](/gateway/configuration) — alle konfigurationsmuligheder
- [DigitalOcean guide](/platforms/digitalocean) — hvis du vil have betalt + nemmere tilmelding
- [Hetzner guide](/install/hetzner) — Docker-baseret alternativ
