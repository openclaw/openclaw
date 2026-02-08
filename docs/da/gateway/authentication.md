---
summary: "Modelautentificering: OAuth, API-nøgler og setup-token"
read_when:
  - Fejlfinding af modelautentificering eller OAuth-udløb
  - Dokumentation af autentificering eller lagring af legitimationsoplysninger
title: "Autentificering"
x-i18n:
  source_path: gateway/authentication.md
  source_hash: 66fa2c64ff374c9c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:15Z
---

# Autentificering

OpenClaw understøtter OAuth og API-nøgler til modeludbydere. For Anthropic‑konti
anbefaler vi at bruge en **API-nøgle**. For adgang via Claude‑abonnement skal du
bruge det langtidsholdbare token, der oprettes af `claude setup-token`.

Se [/concepts/oauth](/concepts/oauth) for det fulde OAuth‑flow og
lagerlayout.

## Anbefalet Anthropic-opsætning (API-nøgle)

Hvis du bruger Anthropic direkte, skal du bruge en API-nøgle.

1. Opret en API-nøgle i Anthropic Console.
2. Læg den på **gateway-værten** (maskinen, der kører `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Hvis Gateway kører under systemd/launchd, foretrækkes det at lægge nøglen i
   `~/.openclaw/.env`, så daemonen kan læse den:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Genstart derefter daemonen (eller genstart din Gateway‑proces) og tjek igen:

```bash
openclaw models status
openclaw doctor
```

Hvis du helst vil undgå selv at administrere miljøvariabler, kan
introduktionsguiden gemme API-nøgler til brug for daemonen: `openclaw onboard`.

Se [Help](/help) for detaljer om arv af env (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (abonnementsautentificering)

For Anthropic er den anbefalede vej en **API-nøgle**. Hvis du bruger et
Claude‑abonnement, understøttes setup-token‑flowet også. Kør det på
**gateway-værten**:

```bash
claude setup-token
```

Indsæt det derefter i OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Hvis tokenet blev oprettet på en anden maskine, indsæt det manuelt:

```bash
openclaw models auth paste-token --provider anthropic
```

Hvis du ser en Anthropic‑fejl som:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…så brug i stedet en Anthropic API-nøgle.

Manuel tokenindtastning (enhver udbyder; skriver `auth-profiles.json` + opdaterer konfiguration):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Automationsvenlig kontrol (afslut `1` ved udløbet/mangler, `2` når udløb nærmer sig):

```bash
openclaw models status --check
```

Valgfrie ops‑scripts (systemd/Termux) er dokumenteret her:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` kræver en interaktiv TTY.

## Kontrol af modelautentificeringsstatus

```bash
openclaw models status
openclaw doctor
```

## Styring af, hvilken legitimationsoplysning der bruges

### Pr. session (chatkommando)

Brug `/model <alias-or-id>@<profileId>` til at fastlåse en specifik udbyder‑legitimationsoplysning
for den aktuelle session (eksempel på profil‑id’er: `anthropic:default`,
`anthropic:work`).

Brug `/model` (eller `/model list`) for en kompakt vælger; brug
`/model status` for fuld visning (kandidater + næste auth‑profil samt
udbyderens endpoint‑detaljer, når de er konfigureret).

### Pr. agent (CLI‑override)

Angiv en eksplicit override af rækkefølgen for auth‑profiler for en agent
(gemmes i agentens `auth-profiles.json`):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Brug `--agent <id>` til at målrette en specifik agent; udelad den for at bruge
den konfigurerede standardagent.

## Fejlfinding

### “No credentials found”

Hvis Anthropic‑tokenprofilen mangler, kør `claude setup-token` på
**gateway-værten**, og tjek derefter igen:

```bash
openclaw models status
```

### Token udløber/er udløbet

Kør `openclaw models status` for at bekræfte, hvilken profil der udløber. Hvis profilen
mangler, kør `claude setup-token` igen og indsæt tokenet på ny.

## Krav

- Claude Max- eller Pro‑abonnement (for `claude setup-token`)
- Claude Code CLI installeret (`claude`‑kommando tilgængelig)
