---
summary: "Gateway-livscyklus på macOS (launchd)"
read_when:
  - Integrering af mac-appen med gatewayens livscyklus
title: "Gateway-livscyklus"
x-i18n:
  source_path: platforms/mac/child-process.md
  source_hash: 9b910f574b723bc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:28Z
---

# Gateway-livscyklus på macOS

macOS-appen **styrer Gateway via launchd** som standard og starter ikke
Gateway som en child process. Den forsøger først at forbinde til en allerede
kørende Gateway på den konfigurerede port; hvis ingen er tilgængelig, aktiverer
den launchd-tjenesten via den eksterne `openclaw` CLI (ingen indlejret runtime).
Det giver pålidelig automatisk start ved login og genstart ved nedbrud.

Child-process-tilstand (Gateway startet direkte af appen) er **ikke i brug**
i dag. Hvis du har brug for tættere kobling til UI’et, kan du køre Gateway
manuelt i en terminal.

## Standardadfærd (launchd)

- Appen installerer en pr. bruger LaunchAgent med label `bot.molt.gateway`
  (eller `bot.molt.<profile>` når `--profile`/`OPENCLAW_PROFILE` bruges; ældre `com.openclaw.*` understøttes).
- Når Lokal tilstand er aktiveret, sikrer appen, at LaunchAgent er indlæst, og
  starter Gateway om nødvendigt.
- Logs skrives til launchd-gatewayens logsti (synlig i Debug Settings).

Almindelige kommandoer:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Erstat labelen med `bot.molt.<profile>` ved kørsel af en navngiven profil.

## Usignerede dev-builds

`scripts/restart-mac.sh --no-sign` er til hurtige lokale builds, når du ikke har
signeringsnøgler. For at forhindre, at launchd peger på en usigneret relay-binær, gør den følgende:

- Skriver `~/.openclaw/disable-launchagent`.

Signerede kørsler af `scripts/restart-mac.sh` rydder denne tilsidesættelse, hvis markøren
er til stede. For at nulstille manuelt:

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only-tilstand

For at tvinge macOS-appen til **aldrig at installere eller administrere launchd**,
skal du starte den med `--attach-only` (eller `--no-launchd`). Dette sætter
`~/.openclaw/disable-launchagent`, så appen kun forbinder til en allerede kørende Gateway. Du kan
slå den samme adfærd til og fra i Debug Settings.

## Remote-tilstand

Remote-tilstand starter aldrig en lokal Gateway. Appen bruger en SSH-tunnel til
den eksterne vært og forbinder over den tunnel.

## Hvorfor vi foretrækker launchd

- Automatisk start ved login.
- Indbygget genstart/KeepAlive-semantik.
- Forudsigelige logs og overvågning.

Hvis en ægte child-process-tilstand nogensinde bliver nødvendig igen, bør den
dokumenteres som en separat, eksplicit dev-only-tilstand.
