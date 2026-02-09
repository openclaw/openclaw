---
summary: "Modellautentisering: OAuth, API-nycklar och setup-token"
read_when:
  - Felsökning av modellautentisering eller OAuth-utgång
  - Dokumentation av autentisering eller lagring av autentiseringsuppgifter
title: "Autentisering"
---

# Autentisering

OpenClaw stöder OAuth och API-nycklar för modellleverantörer. För antropiska
konton rekommenderar vi att du använder en **API-nyckel**. För Claude prenumerationsaccess använder
den långlivade token skapad av `claude setup-token`.

Se [/concepts/oauth](/concepts/oauth) för det fullständiga OAuth‑flödet och lagringslayouten.

## Rekommenderad Anthropic‑konfigurering (API‑nyckel)

Om du använder Anthropic direkt, använd en API‑nyckel.

1. Skapa en API‑nyckel i Anthropic Console.
2. Lägg den på **gateway‑värden** (maskinen som kör `openclaw gateway`).

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Om Gateway (nätverksgateway) körs under systemd/launchd, föredra att lägga nyckeln i
   `~/.openclaw/.env` så att demonen kan läsa den:

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

Starta sedan om demonen (eller starta om din Gateway‑process) och kontrollera igen:

```bash
openclaw models status
openclaw doctor
```

Om du hellre inte vill hantera miljövariabler själv kan introduktionsguiden lagra API‑nycklar för demonanvändning: `openclaw onboard`.

Se [Help](/help) för detaljer om arv av miljövariabler (`env.shellEnv`,
`~/.openclaw/.env`, systemd/launchd).

## Anthropic: setup-token (prenumerationsautentisering)

För Anthropic, är den rekommenderade sökvägen en **API-nyckel**. Om du använder en Claude
-prenumeration, stöds även setup-token-flödet. Kör det på **gateway-värden**:

```bash
claude setup-token
```

Klistra sedan in den i OpenClaw:

```bash
openclaw models auth setup-token --provider anthropic
```

Om token skapades på en annan maskin, klistra in den manuellt:

```bash
openclaw models auth paste-token --provider anthropic
```

Om du ser ett Anthropic‑fel som:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…använd i stället en Anthropic API‑nyckel.

Manuell tokeninmatning (valfri leverantör; skriver `auth-profiles.json` + uppdaterar konfig):

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

Automationsvänlig kontroll (avslutar med `1` när den är utgången/saknas, `2` när den håller på att gå ut):

```bash
openclaw models status --check
```

Valfria driftsskript (systemd/Termux) dokumenteras här:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` kräver en interaktiv TTY.

## Kontrollera status för modellautentisering

```bash
openclaw models status
openclaw doctor
```

## Styra vilken autentiseringsuppgift som används

### Per session (chattkommando)

Använd `/model <alias-or-id>@<profileId>` för att låsa en specifik leverantörsautentisering för den aktuella sessionen (exempel på profil‑ID: `anthropic:default`, `anthropic:work`).

Använd `/model` (eller `/model list`) för en kompakt väljare; använd `/model status` för full vy (kandidater + nästa autentiseringsprofil, samt leverantörens endpoint‑detaljer när de är konfigurerade).

### Per agent (CLI‑åsidosättning)

Ställ in en explicit ordningsåsidosättning för autentiseringsprofiler för en agent (lagras i agentens `auth-profiles.json`):

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

Använd `--agent <id>` för att rikta in dig på en specifik agent; utelämna den för att använda den konfigurerade standardagenten.

## Felsökning

### ”Inga autentiseringsuppgifter hittades”

Om Anthropic‑tokenprofilen saknas, kör `claude setup-token` på
**gateway‑värden**, och kontrollera sedan igen:

```bash
openclaw models status
```

### Token håller på att gå ut/har gått ut

Kör `openclaw models status` för att bekräfta vilken profil som löper ut. Om profilen
saknas, reerun `claude setup-token` och klistra in token igen.

## Krav

- Claude Max‑ eller Pro‑prenumeration (för `claude setup-token`)
- Claude Code CLI installerad (kommandot `claude` tillgängligt)
