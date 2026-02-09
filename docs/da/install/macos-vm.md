---
summary: "Kør OpenClaw i en sandboxed macOS-VM (lokal eller hosted), når du har brug for isolation eller iMessage"
read_when:
  - Du vil have OpenClaw isoleret fra dit primære macOS-miljø
  - Du vil have iMessage-integration (BlueBubbles) i en sandbox
  - Du vil have et nulstilleligt macOS-miljø, som du kan klone
  - Du vil sammenligne lokale vs. hosted macOS-VM-muligheder
title: "macOS-VM'er"
---

# OpenClaw på macOS-VM'er (Sandboxing)

## Anbefalet standard (de fleste brugere)

- **Lille Linux VPS** til en altid-on Gateway og lave omkostninger. Se [VPS hosting](/vps).
- **Dedikeret hardware** (Mac mini eller Linux-boks) hvis du ønsker fuld kontrol og en \*\* bolig-IP\*\* til browserautomatisering. Mange steder blokere data center IP'er, så lokal browsing ofte fungerer bedre.
- **Hybrid:** Hold Gateway på en billig VPS, og tilslut din Mac som en **node**, når du har brug for browser/UI-automatisering. Se [Nodes](/nodes) og [Gateway remote] (/gateway/remote).

Brug en macOS-VM, når du specifikt har brug for macOS-eksklusive funktioner (iMessage/BlueBubbles) eller ønsker streng isolation fra din daglige Mac.

## macOS-VM-muligheder

### Lokal VM på din Apple Silicon Mac (Lume)

Kør OpenClaw i en sandboxed macOS-VM på din eksisterende Apple Silicon Mac ved hjælp af [Lume](https://cua.ai/docs/lume).

Det giver dig:

- Fuldt macOS-miljø i isolation (din vært forbliver ren)
- iMessage-understøttelse via BlueBubbles (umuligt på Linux/Windows)
- Øjeblikkelig nulstilling ved at klone VM’er
- Ingen ekstra hardware- eller cloud-omkostninger

### Hosted Mac-udbydere (cloud)

Hvis du vil have macOS i skyen, fungerer hosted Mac-udbydere også:

- [MacStadium](https://www.macstadium.com/) (hostede Macs)
- Andre hosted Mac-leverandører fungerer også; følg deres VM + SSH-dokumentation

Når du har SSH-adgang til en macOS-VM, fortsæt ved trin 6 nedenfor.

---

## Hurtig vej (Lume, erfarne brugere)

1. Installér Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Gennemfør Setup Assistant, aktivér Remote Login (SSH)
4. `lume run openclaw --no-display`
5. SSH ind, installér OpenClaw, konfigurer kanaler
6. Færdig

---

## Hvad du skal bruge (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- macOS Sequoia eller nyere på værten
- ~60 GB ledig diskplads pr. VM
- ~20 minutter

---

## 1. Installér Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Hvis `~/.local/bin` ikke er i din PATH:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Verificér:

```bash
lume --version
```

Docs: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Opret macOS-VM’en

```bash
lume create openclaw --os macos --ipsw latest
```

Dette henter macOS og opretter VM. Et VNC vindue åbnes automatisk.

Bemærk: Downloaden kan tage noget tid afhængigt af din forbindelse.

---

## 3. Gennemfør Setup Assistant

I VNC-vinduet:

1. Vælg sprog og region
2. Spring Apple ID over (eller log ind, hvis du vil have iMessage senere)
3. Opret en brugerkonto (husk brugernavn og adgangskode)
4. Spring alle valgfrie funktioner over

Når opsætningen er færdig, aktivér SSH:

1. Åbn Systemindstillinger → Generelt → Deling
2. Aktivér "Remote Login"

---

## 4. Få VM’ens IP-adresse

```bash
lume get openclaw
```

Se efter IP-adressen (typisk `192.168.64.x`).

---

## 5. SSH ind i VM’en

```bash
ssh youruser@192.168.64.X
```

Erstat `youruser` med den konto, du oprettede, og IP’en med din VM’s IP.

---

## 6. Installér OpenClaw

Inde i VM’en:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Følg introduktionsprompterne for at opsætte din modeludbyder (Anthropic, OpenAI osv.).

---

## 7. Konfigurér kanaler

Redigér konfigurationsfilen:

```bash
nano ~/.openclaw/openclaw.json
```

Tilføj dine kanaler:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

Log derefter ind på WhatsApp (scan QR):

```bash
openclaw channels login
```

---

## 8. Kør VM’en headless

Stop VM’en og genstart uden visning:

```bash
lume stop openclaw
lume run openclaw --no-display
```

VM kører i baggrunden. OpenClaw's dæmon holder porten kørende.

For at tjekke status:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus: iMessage-integration

Dette er den dræberfunktion at køre på macOS. Brug [BlueBubbles](https://bluebubbles.app) til at tilføje iMessage til OpenClaw.

Inde i VM’en:

1. Download BlueBubbles fra bluebubbles.app
2. Log ind med dit Apple ID
3. Aktivér Web API’et og sæt en adgangskode
4. Peg BlueBubbles-webhooks på din gateway (eksempel: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Tilføj til din OpenClaw-konfiguration:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

Genstart gatewayen. Nu kan din agent sende og modtage iMessages.

Fuld opsætning: [BlueBubbles channel](/channels/bluebubbles)

---

## Gem et gyldent image

Før du tilpasser yderligere, tag et snapshot af din rene tilstand:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Nulstil når som helst:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Kørsel 24/7

Hold VM’en kørende ved at:

- Holde din Mac tilsluttet strøm
- Deaktivere dvale i Systemindstillinger → Energisparer
- Bruge `caffeinate` om nødvendigt

For sand altid-on, overveje en dedikeret Mac mini eller en lille VPS. Se [VPS hosting](/vps).

---

## Fejlfinding

| Problem                   | Løsning                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Kan ikke SSH ind i VM     | Tjek, at "Remote Login" er aktiveret i VM’ens Systemindstillinger                                              |
| VM-IP vises ikke          | Vent til VM’en er helt bootet, kør `lume get openclaw` igen                                                    |
| Lume-kommando ikke fundet | Tilføj `~/.local/bin` til din PATH                                                                             |
| WhatsApp-QR scanner ikke  | Sørg for, at du er logget ind i VM’en (ikke værten), når du kører `openclaw channels login` |

---

## Relaterede docs

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (avanceret)
- [Docker Sandboxing](/install/docker) (alternativ isolationsmetode)
