---
summary: "Statuslogik för menyraden och vad som visas för användare"
read_when:
  - Justering av mac-menyns UI eller statuslogik
title: "Menyrad"
---

# Statuslogik för menyraden

## Vad som visas

- Vi visar den aktuella agentens arbetsstatus i menyradsikonen och i den första statusraden i menyn.
- Hälsostatus döljs medan arbete är aktivt; den återkommer när alla sessioner är inaktiva.
- Blocket ”Nodes” i menyn listar endast **enheter** (parade noder via `node.list`), inte klient-/närvaroposter.
- Ett avsnitt ”Usage” visas under Context när ögonblicksbilder av leverantörsanvändning finns tillgängliga.

## Tillståndsmodell

- Sessioner: händelser anländer med `runId` (per-run) plus `sessionKey` i nyttolasten. “main” sessionen är nyckeln `main`; om den saknas, vi faller tillbaka till den senast uppdaterade sessionen.
- Prioritet: main alltid vinner. Om huvud är aktiv, dess tillstånd visas omedelbart. Om huvud är inaktiv, den senaste aktiva non‐main sessionen visas. Vi växlar inte flip‐flop mid‐activity; vi växlar bara när den aktuella sessionen går vilande eller main blir aktiv.
- Aktivitetstyper:
  - `job`: exekvering av kommandon på hög nivå (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` med `toolName` och `meta/args`.

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (felsökningsåsidosättning)

### ActivityKind → glyph

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- default → 🛠️

### Visuell mappning

- `idle`: normal critter.
- `workingMain`: märke med glyph, full toning, ”working”-benanimation.
- `workingOther`: märke med glyph, dämpad toning, ingen scurry.
- `overridden`: använder vald glyph/toning oavsett aktivitet.

## Statusradstext (meny)

- När arbete är aktivt: `<Session role> · <activity label>`
  - Exempel: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- När inaktiv: faller tillbaka till hälsosammanfattningen.

## Händelseintag

- Källa: control‑channel `agent`‑händelser (`ControlChannel.handleAgentEvent`).
- Parsade fält:
  - `stream: "job"` med `data.state` för start/stopp.
  - `stream: "tool"` med `data.phase`, `name`, valfritt `meta`/`args`.
- Etiketter:
  - `exec`: första raden av `args.command`.
  - `read`/`write`: förkortad sökväg.
  - `edit`: sökväg plus härledd ändringstyp från `meta`/diff‑antal.
  - reserv: verktygsnamn.

## Felsökningsåsidosättning

- Inställningar ▸ Debug ▸ väljare för ”Icon override”:
  - `System (auto)` (standard)
  - `Working: main` (per verktygstyp)
  - `Working: other` (per verktygstyp)
  - `Idle`
- Lagring via `@AppStorage("iconOverride")`; mappas till `IconState.overridden`.

## Testchecklista

- Starta jobb i huvudsessionen: verifiera att ikonen växlar omedelbart och att statusraden visar huvudetiketten.
- Starta jobb i icke‑huvudsession medan huvudsessionen är inaktiv: ikon/status visar icke‑huvudsessionen; förblir stabil tills den är klar.
- Starta huvudsessionen medan annan är aktiv: ikonen växlar till huvudsessionen direkt.
- Snabba verktygsburstar: säkerställ att märket inte flimrar (TTL‑marginal på verktygsresultat).
- Hälsoraden visas igen när alla sessioner är inaktiva.
