---
summary: "CLI-referens för `openclaw update` (säker-ish källuppdatering + automatisk omstart av Gateway)"
read_when:
  - Du vill uppdatera en källutcheckning på ett säkert sätt
  - Du behöver förstå förkortningsbeteendet för `--update`
title: "update"
---

# `openclaw update`

Uppdatera OpenClaw säkert och växla mellan kanalerna stable/beta/dev.

Om du installerade via **npm/pnpm** (global installation, ingen git-metadata) sker uppdateringar via paketförvaltarflödet i [Updating](/install/updating).

## Användning

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Alternativ

- `--no-restart`: hoppa över omstart av Gateway-tjänsten efter en lyckad uppdatering.
- `--channel <stable|beta|dev>`: ange uppdateringskanal (git + npm; sparas i konfig).
- `--tag <dist-tag|version>`: åsidosätt npm dist-tag eller version endast för denna uppdatering.
- `--json`: skriv ut maskinläsbar `UpdateRunResult` JSON.
- `--timeout <seconds>`: timeout per steg (standard är 1200 s).

Obs: nedgraderingar kräver bekräftelse eftersom äldre versioner kan bryta konfigurationen.

## `update status`

Visa den aktiva uppdateringskanalen + git-tag/branch/SHA (för källutcheckningar), samt uppdateringstillgänglighet.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Alternativ:

- `--json`: skriv ut maskinläsbar status-JSON.
- `--timeout <seconds>`: timeout för kontroller (standard är 3 s).

## `update wizard`

Interaktivt flöde för att välja en uppdateringskanal och bekräfta om du vill starta om Gateway
efter uppdatering (standard är att starta om). Om du väljer `dev` utan en git kassan, det
erbjuder att skapa en.

## Vad den gör

När du byter kanal explicit (`--channel ...`) ser OpenClaw också till att
installationsmetoden hålls i linje:

- `dev` → säkerställer en git-utcheckning (standard: `~/openclaw`, åsidosätt med `OPENCLAW_GIT_DIR`),
  uppdaterar den och installerar den globala CLI:n från den utcheckningen.
- `stable`/`beta` → installerar från npm med motsvarande dist-tag.

## Git-utcheckningsflöde

Kanaler:

- `stable`: checkar ut den senaste icke-beta-taggen, därefter build + doctor.
- `beta`: checkar ut den senaste `-beta`-taggen, därefter build + doctor.
- `dev`: checkar ut `main`, därefter fetch + rebase.

På hög nivå:

1. Kräver en ren arbetskatalog (inga ocommittade ändringar).
2. Växlar till vald kanal (tagg eller branch).
3. Hämtar upstream (endast dev).
4. Endast dev: förkontroll med lint + TypeScript-build i en temporär arbetskatalog; om tippen misslyckas backar den upp till 10 commits för att hitta den senaste rena builden.
5. Rebaserar på vald commit (endast dev).
6. Installerar beroenden (pnpm föredras; npm som fallback).
7. Bygger + bygger Control UI.
8. Kör `openclaw doctor` som den slutliga ”säkra uppdaterings”-kontrollen.
9. Synkar plugins till den aktiva kanalen (dev använder bundlade tillägg; stable/beta använder npm) och uppdaterar npm-installerade plugins.

## `--update`-förkortning

`openclaw --update` skrivs om till `openclaw update` (användbart för skal och launcher-skript).

## Se även

- `openclaw doctor` (erbjuder att köra update först på git-utcheckningar)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [CLI reference](/cli)
