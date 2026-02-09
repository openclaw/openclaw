---
summary: "Gateway‑livscykel på macOS (launchd)"
read_when:
  - Integrerar mac‑appen med Gateway‑livscykeln
title: "Gateway‑livscykel"
---

# Gateway‑livscykel på macOS

MacOS-appen **hanterar Gateway via launchd** som standard och spawnar inte
Gateway som en underordnad process. Den försöker först ansluta till en redan körande
Gateway på den konfigurerade porten; om ingen är nåbar, det aktiverar launchd
-tjänsten via den externa `openclaw` CLI (ingen inbäddad runtime). Detta ger dig
pålitliga autostart vid inloggning och omstart vid krascher.

Child‐processläge (Gateway spawnas direkt av appen) används \*\*inte idag.
Om du behöver en hårdare koppling till användargränssnittet, kör Gateway manuellt i en terminal.

## Standardbeteende (launchd)

- Appen installerar en LaunchAgent märkt `bot.molt.gateway`
  (eller `bot.molt.<profile>` vid användning av `--profile`/`OPENCLAW_PROFILE`; äldre `com.openclaw.*` stöds).
- När Lokalt läge är aktiverat ser appen till att LaunchAgent är laddad och
  startar Gateway vid behov.
- Loggar skrivs till launchd‑gatewayns loggsökväg (synlig i Felsökningsinställningar).

Vanliga kommandon:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Ersätt etiketten med `bot.molt.<profile>` när du kör en namngiven profil.

## Osignerade dev‑byggen

`scripts/restart-mac.sh --no-sign` är för snabba lokala kompileringar när du inte har
signeringsnycklar. För att förhindra launchd från att peka på ett osignerat relä binärt, den:

- Skriver `~/.openclaw/disable-launchagent`.

Signerade körningar av `scripts/restart-mac.sh` rensa denna åsidosättning om markören är
närvarande. Återställning manuellt:

```bash
rm ~/.openclaw/disable-launchagent
```

## Endast‑anslutningsläge

För att tvinga macOS appen att **aldrig installera eller hantera launchd**, starta den med
`--attach-only` (eller `--no-launchd`). Detta sätter `~/.openclaw/disable-launchagent`,
så att appen bara fäster till en redan körande Gateway. Du kan växla mellan samma
beteende i Debug Settings.

## Fjärrläge

Fjärrläge startar aldrig en lokal Gateway. Appen använder en SSH-tunnel till
fjärrvärd och ansluter över den tunneln.

## Varför vi föredrar launchd

- Autostart vid inloggning.
- Inbyggd omstart/KeepAlive‑semantik.
- Förutsägbara loggar och övervakning.

Om ett äkta barnprocess‑läge någon gång behövs igen bör det dokumenteras som ett
separat, uttryckligt läge endast för utveckling.
