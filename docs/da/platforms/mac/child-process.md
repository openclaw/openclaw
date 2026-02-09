---
summary: "Gateway-livscyklus på macOS (launchd)"
read_when:
  - Integrering af mac-appen med gatewayens livscyklus
title: "Gateway-livscyklus"
---

# Gateway-livscyklus på macOS

MacOS-appen **administrerer Gateway via launchd** som standard og spawner ikke
Gateway som et barn proces. Den forsøger først at knytte en allerede fungerende
Gateway til den konfigurerede havn. hvis ingen er tilgængelig, det aktiverer launchd
tjeneste via den eksterne `openclaw` CLI (ingen indlejret runtime). Dette giver dig
pålidelig autostart ved login og genstart ved nedbrud.

Child-process mode (Gateway spawned direkte af appen) er **ikke i brug** i dag.
Hvis du har brug for strammere kobling til brugergrænsefladen, skal du køre porten manuelt i en terminal.

## Standardadfærd (launchd)

- Appen installerer en per‐bruger LaunchAgent mærket `bot.molt.gateway`
  (eller `bot.molt.<profile>` når du bruger `--profile`/`OPENCLAW_PROFILE`; arv `com.openclaw.*` er understøttet).
- Når Lokal tilstand er aktiveret, sikrer appen, at LaunchAgent er indlæst, og
  starter Gateway om nødvendigt.
- Logs skrives til launchd-gatewayens logsti (synlig i Debug Settings).

Almindelige kommandoer:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Erstat etiketten med bot.molt.<profile>\` når du kører en navngiven profil.

## Usignerede dev-builds

`scripts/restart-mac.sh --no-sign` er for hurtige lokale bygninger, når du ikke har
signeringsnøgler. For at forhindre lanceringen i at pege på et usigneret relæ binær, det:

- Skriver `~/.openclaw/disable-launchagent`.

Signerede kørsler af `scripts/genstart-mac.sh` rydde denne tilsidesættelse, hvis markøren er
til stede. Sådan nulstilles manuelt:

```bash
rm ~/.openclaw/disable-launchagent
```

## Attach-only-tilstand

For at tvinge MacOS-appen til **aldrig at installere eller administrere launchd**, start den med
`--attach-only` (eller `--no-launchd`). Dette sætter `~/.openclaw/disable-launchagent`,
, så app'en kun tillægger en allerede kørende Gateway. Du kan slå den samme
-adfærd til i fejlfindingsindstillinger.

## Remote-tilstand

Fjerntilstand starter aldrig en lokal Gateway. Appen bruger en SSH-tunnel til
-fjernværten og forbinder den pågældende tunnel.

## Hvorfor vi foretrækker launchd

- Automatisk start ved login.
- Indbygget genstart/KeepAlive-semantik.
- Forudsigelige logs og overvågning.

Hvis en ægte child-process-tilstand nogensinde bliver nødvendig igen, bør den
dokumenteres som en separat, eksplicit dev-only-tilstand.
