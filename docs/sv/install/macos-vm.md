---
summary: "Kör OpenClaw i en sandboxad macOS-VM (lokal eller hostad) när du behöver isolering eller iMessage"
read_when:
  - Du vill ha OpenClaw isolerat från din huvudsakliga macOS-miljö
  - Du vill ha iMessage-integration (BlueBubbles) i en sandbox
  - Du vill ha en återställningsbar macOS-miljö som du kan klona
  - Du vill jämföra lokala kontra hostade macOS-VM-alternativ
title: "macOS-VM:er"
---

# OpenClaw på macOS-VM:er (Sandboxing)

## Rekommenderad standard (de flesta användare)

- **Liten Linux VPS** för en alltid-på Gateway och låg kostnad. Se [VPS hosting](/vps).
- \*\*Dedikerad hårdvara \*\* (Mac mini eller Linux box) om du vill ha full kontroll och ett **bostads-IP** för webbläsarautomatisering. Många webbplatser blockera datacenter IPs, så lokal surfning fungerar ofta bättre.
- **Hybrid:** behåll Gateway på en billig VPS, och anslut din Mac som en **nod** när du behöver webbläsar/UI automation. Se [Nodes](/nodes) och [Gateway remote](/gateway/remote).

Använd en macOS-VM när du specifikt behöver macOS-exklusiva funktioner (iMessage/BlueBubbles) eller vill ha strikt isolering från din dagliga Mac.

## macOS-VM-alternativ

### Lokal VM på din Apple Silicon Mac (Lume)

Kör OpenClaw i en sandboxad macOS-VM på din befintliga Apple Silicon Mac med [Lume](https://cua.ai/docs/lume).

Detta ger dig:

- Fullständig macOS-miljö i isolering (värden hålls ren)
- iMessage-stöd via BlueBubbles (omöjligt på Linux/Windows)
- Omedelbar återställning genom att klona VM:er
- Ingen extra hårdvara eller molnkostnader

### Hostade Mac-leverantörer (moln)

Om du vill ha macOS i molnet fungerar hostade Mac-leverantörer också:

- [MacStadium](https://www.macstadium.com/) (hostade Mac-datorer)
- Andra hostade Mac-leverantörer fungerar också; följ deras VM- och SSH-dokumentation

När du har SSH-åtkomst till en macOS-VM, fortsätt vid steg 6 nedan.

---

## Snabb väg (Lume, erfarna användare)

1. Installera Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Slutför Setup Assistant, aktivera Remote Login (SSH)
4. `lume run openclaw --no-display`
5. SSH:a in, installera OpenClaw, konfigurera kanaler
6. Klart

---

## Vad du behöver (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- macOS Sequoia eller senare på värden
- ~60 GB ledigt diskutrymme per VM
- ~20 minuter

---

## 1. Installera Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Om `~/.local/bin` inte finns i din PATH:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Verifiera:

```bash
lume --version
```

Dokumentation: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Skapa macOS-VM:n

```bash
lume create openclaw --os macos --ipsw latest
```

Detta laddar ner macOS och skapar VM. Ett VNC-fönster öppnas automatiskt.

Obs: Nedladdningen kan ta en stund beroende på din anslutning.

---

## 3. Slutför Setup Assistant

I VNC-fönstret:

1. Välj språk och region
2. Hoppa över Apple ID (eller logga in om du vill ha iMessage senare)
3. Skapa ett användarkonto (kom ihåg användarnamn och lösenord)
4. Hoppa över alla valfria funktioner

När installationen är klar, aktivera SSH:

1. Öppna Systeminställningar → Allmänt → Delning
2. Aktivera ”Remote Login”

---

## 4. Hämta VM:ns IP-adress

```bash
lume get openclaw
```

Leta efter IP-adressen (vanligtvis `192.168.64.x`).

---

## 5. SSH:a in i VM:n

```bash
ssh youruser@192.168.64.X
```

Ersätt `youruser` med kontot du skapade och IP-adressen med din VM:s IP.

---

## 6. Installera OpenClaw

Inuti VM:n:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Följ introduktionsanvisningarna för att konfigurera din modellleverantör (Anthropic, OpenAI, etc.).

---

## 7. Konfigurera kanaler

Redigera konfigfilen:

```bash
nano ~/.openclaw/openclaw.json
```

Lägg till dina kanaler:

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

Logga sedan in på WhatsApp (skanna QR-kod):

```bash
openclaw channels login
```

---

## 8. Kör VM:n utan visning (headless)

Stoppa VM:n och starta om utan visning:

```bash
lume stop openclaw
lume run openclaw --no-display
```

Den virtuella maskinen körs i bakgrunden. OpenClaws daemon håller gatewayen igång.

För att kontrollera status:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus: iMessage-integration

Detta är mördarfunktionen för att köra på macOS. Använd [BlueBubbles](https://bluebubbles.app) för att lägga till iMessage till OpenClaw.

Inuti VM:n:

1. Ladda ner BlueBubbles från bluebubbles.app
2. Logga in med ditt Apple ID
3. Aktivera Web API och ange ett lösenord
4. Peka BlueBubbles-webhooks mot din gateway (exempel: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Lägg till i din OpenClaw-konfig:

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

Starta om gatewayn. Nu kan er agent skicka och ta emot iMessages.

Fullständiga installationsdetaljer: [BlueBubbles channel](/channels/bluebubbles)

---

## Spara en gyllene image

Innan du anpassar vidare, ta en snapshot av ditt rena tillstånd:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Återställ när som helst:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## Körning 24/7

Håll VM:n igång genom att:

- Ha din Mac inkopplad
- Inaktivera viloläge i Systeminställningar → Energibesparing
- Använd `caffeinate` vid behov

För sant alltid-på, överväga en dedikerad Mac mini eller en liten VPS. Se [VPS hosting](/vps).

---

## Felsökning

| Problem                                                  | Lösning                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Kan inte SSH:a in i VM:n | Kontrollera att ”Remote Login” är aktiverat i VM:ns Systeminställningar                                    |
| VM-IP visas inte                                         | Vänta tills VM:n har startat helt, kör `lume get openclaw` igen                                            |
| Lume-kommando hittas ej                                  | Lägg till `~/.local/bin` i din PATH                                                                                        |
| WhatsApp-QR skannas ej                                   | Säkerställ att du är inloggad i VM:n (inte värden) när du kör `openclaw channels login` |

---

## Relaterad dokumentation

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (avancerat)
- [Docker Sandboxing](/install/docker) (alternativ isoleringsmetod)
