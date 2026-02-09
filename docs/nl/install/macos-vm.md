---
summary: "Draai OpenClaw in een gesandboxde macOS-VM (lokaal of gehost) wanneer je isolatie of iMessage nodig hebt"
read_when:
  - Je wilt OpenClaw geïsoleerd houden van je primaire macOS-omgeving
  - Je wilt iMessage-integratie (BlueBubbles) in een sandbox
  - Je wilt een resetbare macOS-omgeving die je kunt klonen
  - Je wilt lokale versus gehoste macOS-VM-opties vergelijken
title: "macOS-VM's"
---

# OpenClaw op macOS-VM's (Sandboxing)

## Aanbevolen standaard (meeste gebruikers)

- **Kleine Linux VPS** voor een altijd-actieve Gateway en lage kosten. Zie [VPS hosting](/vps).
- **Dedicated hardware** (Mac mini of Linux-box) als je volledige controle wilt en een **residentieel IP** voor browserautomatisering. Veel sites blokkeren datacenter-IP's, dus lokaal browsen werkt vaak beter.
- **Hybride:** houd de Gateway op een goedkope VPS en verbind je Mac als **node** wanneer je browser/UI-automatisering nodig hebt. Zie [Nodes](/nodes) en [Gateway remote](/gateway/remote).

Gebruik een macOS-VM wanneer je specifiek macOS-exclusieve mogelijkheden nodig hebt (iMessage/BlueBubbles) of strikte isolatie wilt van je dagelijkse Mac.

## macOS-VM-opties

### Lokale VM op je Apple Silicon Mac (Lume)

Draai OpenClaw in een gesandboxde macOS-VM op je bestaande Apple Silicon Mac met [Lume](https://cua.ai/docs/lume).

Dit biedt je:

- Volledige macOS-omgeving in isolatie (je host blijft schoon)
- iMessage-ondersteuning via BlueBubbles (onmogelijk op Linux/Windows)
- Direct resetten door VM's te klonen
- Geen extra hardware- of cloudkosten

### Gehoste Mac-providers (cloud)

Als je macOS in de cloud wilt, werken gehoste Mac-providers ook:

- [MacStadium](https://www.macstadium.com/) (gehoste Macs)
- Andere gehoste Mac-leveranciers werken ook; volg hun VM- en SSH-documentatie

Zodra je SSH-toegang hebt tot een macOS-VM, ga verder bij stap 6 hieronder.

---

## Snelle route (Lume, ervaren gebruikers)

1. Installeer Lume
2. `lume create openclaw --os macos --ipsw latest`
3. Voltooi Setup Assistant, schakel Remote Login (SSH) in
4. `lume run openclaw --no-display`
5. Log in via SSH, installeer OpenClaw, configureer kanalen
6. Voltooid

---

## Wat je nodig hebt (Lume)

- Apple Silicon Mac (M1/M2/M3/M4)
- macOS Sequoia of later op de host
- ~60 GB vrije schijfruimte per VM
- ~20 minuten

---

## 1. Installeer Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

Als `~/.local/bin` niet in je PATH staat:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

Verifiëren:

```bash
lume --version
```

Docs: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. Maak de macOS-VM aan

```bash
lume create openclaw --os macos --ipsw latest
```

Dit downloadt macOS en maakt de VM aan. Er opent automatisch een VNC-venster.

Let op: Het downloaden kan even duren, afhankelijk van je verbinding.

---

## 3. Voltooi Setup Assistant

In het VNC-venster:

1. Selecteer taal en regio
2. Sla Apple ID over (of meld je aan als je later iMessage wilt)
3. Maak een gebruikersaccount aan (onthoud de gebruikersnaam en het wachtwoord)
4. Sla alle optionele functies over

Schakel na het voltooien van de setup SSH in:

1. Open Systeeminstellingen → Algemeen → Delen
2. Schakel "Remote Login" in

---

## 4. Verkrijg het IP-adres van de VM

```bash
lume get openclaw
```

Zoek het IP-adres (meestal `192.168.64.x`).

---

## 5. SSH inloggen op de VM

```bash
ssh youruser@192.168.64.X
```

Vervang `youruser` door het account dat je hebt aangemaakt, en het IP door het IP-adres van je VM.

---

## 6. Installeer OpenClaw

Binnen de VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

Volg de onboarding-prompts om je model provider in te stellen (Anthropic, OpenAI, enz.).

---

## 7. Kanalen configureren

Bewerk het config-bestand:

```bash
nano ~/.openclaw/openclaw.json
```

Voeg je kanalen toe:

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

Log vervolgens in op WhatsApp (scan QR):

```bash
openclaw channels login
```

---

## 8. Draai de VM headless

Stop de VM en start opnieuw zonder display:

```bash
lume stop openclaw
lume run openclaw --no-display
```

De VM draait op de achtergrond. De daemon van OpenClaw houdt de gateway draaiende.

Status controleren:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## Bonus: iMessage-integratie

Dit is de killer feature van draaien op macOS. Gebruik [BlueBubbles](https://bluebubbles.app) om iMessage aan OpenClaw toe te voegen.

Binnen de VM:

1. Download BlueBubbles van bluebubbles.app
2. Log in met je Apple ID
3. Schakel de Web API in en stel een wachtwoord in
4. Richt BlueBubbles-webhooks naar je gateway (voorbeeld: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

Voeg toe aan je OpenClaw-config:

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

Herstart de gateway. Nu kan je agent iMessages verzenden en ontvangen.

Volledige setupdetails: [BlueBubbles channel](/channels/bluebubbles)

---

## Sla een golden image op

Maak een snapshot van je schone staat voordat je verder aanpast:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

Altijd resetten:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## 24/7 uitgevoerd

Houd de VM draaiende door:

- Je Mac aangesloten te houden op stroom
- Slaapstand uit te schakelen in Systeeminstellingen → Energiestand
- Indien nodig `caffeinate` te gebruiken

Voor echt altijd-aan, overweeg een dedicated Mac mini of een kleine VPS. Zie [VPS hosting](/vps).

---

## Problemen oplossen

| Probleem                    | Oplossing                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Kan niet via SSH in VM      | Controleer of "Remote Login" is ingeschakeld in de Systeeminstellingen van de VM                                     |
| VM-IP wordt niet getoond    | Wacht tot de VM volledig is opgestart, voer `lume get openclaw` opnieuw uit                                          |
| Lume-commando niet gevonden | Voeg `~/.local/bin` toe aan je PATH                                                                                  |
| WhatsApp QR scant niet      | Zorg dat je bent ingelogd in de VM (niet de host) bij het uitvoeren van `openclaw channels login` |

---

## Gerelateerde documentatie

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (geavanceerd)
- [Docker Sandboxing](/install/docker) (alternatieve isolatie-aanpak)
