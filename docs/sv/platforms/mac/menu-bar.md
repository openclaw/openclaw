---
summary: "Statuslogik för menyraden och vad som visas för användare"
read_when:
  - Justering av mac-menyns UI eller statuslogik
title: "Menyrad"
x-i18n:
  source_path: platforms/mac/menu-bar.md
  source_hash: 8eb73c0e671a76aa
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:03Z
---

# Statuslogik för menyraden

## Vad som visas

- Vi visar den aktuella agentens arbetsstatus i menyradsikonen och i den första statusraden i menyn.
- Hälsostatus döljs medan arbete är aktivt; den återkommer när alla sessioner är inaktiva.
- Blocket ”Nodes” i menyn listar endast **enheter** (parade noder via `node.list`), inte klient-/närvaroposter.
- Ett avsnitt ”Usage” visas under Context när ögonblicksbilder av leverantörsanvändning finns tillgängliga.

## Tillståndsmodell

- Sessioner: händelser anländer med `runId` (per körning) plus `sessionKey` i nyttolasten. Den ”huvudsakliga” sessionen är nyckeln `main`; om den saknas faller vi tillbaka till den senast uppdaterade sessionen.
- Prioritet: huvudsessionen vinner alltid. Om huvudsessionen är aktiv visas dess tillstånd omedelbart. Om huvudsessionen är inaktiv visas den senast aktiva icke‑huvudsessionen. Vi växlar inte fram och tillbaka mitt under aktivitet; vi byter endast när den aktuella sessionen blir inaktiv eller när huvudsessionen blir aktiv.
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
