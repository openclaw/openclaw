---
summary: "Gateway‑livscykel på macOS (launchd)"
read_when:
  - Integrerar mac‑appen med Gateway‑livscykeln
title: "Gateway‑livscykel"
x-i18n:
  source_path: platforms/mac/child-process.md
  source_hash: 9b910f574b723bc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:56Z
---

# Gateway‑livscykel på macOS

macOS‑appen **hanterar Gateway via launchd** som standard och startar inte
Gateway som en barnprocess. Den försöker först ansluta till en redan körande
Gateway på den konfigurerade porten; om ingen kan nås aktiverar den launchd‑tjänsten
via den externa `openclaw` CLI (ingen inbäddad runtime). Detta ger tillförlitlig
autostart vid inloggning och omstart vid krascher.

Barnprocess‑läge (Gateway startas direkt av appen) används **inte** i dag.
Om du behöver tätare koppling till UI:t, kör Gateway manuellt i en terminal.

## Standardbeteende (launchd)

- Appen installerar en LaunchAgent per användare med etiketten `bot.molt.gateway`
  (eller `bot.molt.<profile>` när `--profile`/`OPENCLAW_PROFILE` används; äldre `com.openclaw.*` stöds).
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

`scripts/restart-mac.sh --no-sign` är till för snabba lokala byggen när du inte har
signeringsnycklar. För att förhindra att launchd pekar på en osignerad relay‑binär gör den följande:

- Skriver `~/.openclaw/disable-launchagent`.

Signerande körningar av `scripts/restart-mac.sh` rensar denna åsidosättning om markören finns.
För att återställa manuellt:

```bash
rm ~/.openclaw/disable-launchagent
```

## Endast‑anslutningsläge

För att tvinga macOS‑appen att **aldrig installera eller hantera launchd**, starta den med
`--attach-only` (eller `--no-launchd`). Detta sätter `~/.openclaw/disable-launchagent`,
så att appen endast ansluter till en redan körande Gateway. Du kan växla samma
beteende i Felsökningsinställningar.

## Fjärrläge

Fjärrläge startar aldrig en lokal Gateway. Appen använder en SSH‑tunnel till
fjärrvärden och ansluter över den tunneln.

## Varför vi föredrar launchd

- Autostart vid inloggning.
- Inbyggd omstart/KeepAlive‑semantik.
- Förutsägbara loggar och övervakning.

Om ett äkta barnprocess‑läge någon gång behövs igen bör det dokumenteras som ett
separat, uttryckligt läge endast för utveckling.
