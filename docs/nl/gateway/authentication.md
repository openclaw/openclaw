---
summary: "Modelauthenticatie: OAuth, API-sleutels en setup-token"
read_when:
  - Fouten opsporen bij modelauthenticatie of OAuth-verval
  - Authenticatie of opslag van inloggegevens documenteren
title: "Authenticatie"
---

# Authenticatie

OpenClaw ondersteunt OAuth en API-sleutels voor modelproviders. Voor Anthropic-
accounts raden we aan een **API-sleutel** te gebruiken. Voor toegang via een
Claude-abonnement gebruik je het langlevende token dat is aangemaakt door
`claude setup-token`.

Zie [/concepts/oauth](/concepts/oauth) voor de volledige OAuth-flow en
opslagindeling.

## Aanbevolen Anthropic-installatie (API-sleutel)

Als je Anthropic rechtstreeks gebruikt, gebruik dan een API-sleutel.

1. Maak een API-sleutel aan in de Anthropic Console.
2. Plaats deze op de **Gateway-host** (de machine waarop `openclaw gateway` draait).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Als de Gateway onder systemd/launchd draait, plaats de sleutel bij voorkeur in
   `~/.openclaw/.env` zodat de daemon deze kan lezen:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Herstart daarna de daemon (of herstart je Gateway-proces) en controleer opnieuw:

```bash
openclaw models status
openclaw doctor
```

Als je liever niet zelf omgevingsvariabelen beheert, kan de onboarding-wizard
API-sleutels opslaan voor gebruik door de daemon: `openclaw onboard`.

Zie [Help](/help) voor details over env-overerving (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (abonnementsauthenticatie)

Voor Anthropic is het aanbevolen pad een **API-sleutel**. Als je een
Claude-abonnement gebruikt, wordt de setup-token-flow ook ondersteund. Voer dit
uit op de **Gateway-host**:

```bash
claude setup-token
```

Plak het vervolgens in OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Als het token op een andere machine is aangemaakt, plak het handmatig:

```bash
openclaw models auth paste-token --provider anthropic
```

Als je een Anthropic-fout ziet zoals:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…gebruik dan in plaats daarvan een Anthropic API-sleutel.

Handmatige tokeninvoer (elke provider; schrijft `auth-profiles.json` + werkt de config bij):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Automatiseringsvriendelijke controle (exit `1` bij verlopen/ontbrekend,
`2` bij bijna verlopen):

```bash
openclaw models status --check
```

Optionele ops-scripts (systemd/Termux) zijn hier gedocumenteerd:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` vereist een interactieve TTY.

## Controleren van modelauthenticatiestatus

```bash
openclaw models status
openclaw doctor
```

## Controleren welke referenties worden gebruikt

### Per sessie (chatopdracht)

Gebruik `/model <alias-or-id>@<profileId>` om een specifieke provider-inloggegevens vast te zetten
voor de huidige sessie (voorbeeldprofiel-id’s: `anthropic:default`, `anthropic:work`).

Gebruik `/model` (of `/model list`) voor een compacte keuzelijst; gebruik
`/model status` voor de volledige weergave (kandidaten + volgend
authenticatieprofiel, plus provider-endpointdetails indien geconfigureerd).

### Per agent (CLI-override)

Stel een expliciete volgorde-override voor authenticatieprofielen in voor een
agent (opgeslagen in de `auth-profiles.json` van die agent):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Gebruik `--agent <id>` om een specifieke agent te targeten; laat dit weg om de
geconfigureerde standaardagent te gebruiken.

## Problemen oplossen

### “No credentials found”

Als het Anthropic-tokenprofiel ontbreekt, voer `claude setup-token` uit op de
**Gateway-host** en controleer daarna opnieuw:

```bash
openclaw models status
```

### Token verloopt/verlopen

Voer `openclaw models status` uit om te bevestigen welk profiel verloopt. Als het profiel
ontbreekt, voer `claude setup-token` opnieuw uit en plak het token opnieuw.

## Provideropties

- Claude Max- of Pro-abonnement (voor `claude setup-token`)
- Claude Code CLI geïnstalleerd (`claude`-opdracht beschikbaar)
