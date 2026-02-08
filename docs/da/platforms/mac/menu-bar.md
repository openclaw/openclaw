---
summary: "Statuslogik for menulinjen og hvad der vises for brugere"
read_when:
  - Justering af mac-menulinjens UI eller statuslogik
title: "Menulinje"
x-i18n:
  source_path: platforms/mac/menu-bar.md
  source_hash: 8eb73c0e671a76aa
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:31Z
---

# Statuslogik for menulinjen

## Hvad der vises

- Vi viser den aktuelle agents arbejdstilstand i menulinjeikonet og i den første statusrække i menuen.
- Sundhedsstatus er skjult, mens arbejde er aktivt; den vender tilbage, når alle sessioner er inaktive.
- Blokken “Nodes” i menuen viser kun **enheder** (parrede noder via `node.list`), ikke klient-/tilstedeværelsesposter.
- Et afsnit “Usage” vises under Context, når snapshots af udbyderforbrug er tilgængelige.

## Tilstandsmodel

- Sessioner: hændelser ankommer med `runId` (pr. kørsel) samt `sessionKey` i payloaden. Den “primære” session er nøglen `main`; hvis den mangler, falder vi tilbage til den senest opdaterede session.
- Prioritet: primær vinder altid. Hvis primær er aktiv, vises dens tilstand straks. Hvis primær er inaktiv, vises den senest aktive ikke‑primære session. Vi skifter ikke frem og tilbage midt i aktivitet; vi skifter kun, når den aktuelle session bliver inaktiv, eller når primær bliver aktiv.
- Aktivitetstyper:
  - `job`: udførelse af kommandoer på højt niveau (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` med `toolName` og `meta/args`.

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (debug‑overstyring)

### ActivityKind → glyf

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- default → 🛠️

### Visuel mapping

- `idle`: normal critter.
- `workingMain`: badge med glyf, fuld farvetoning, benenes “working”-animation.
- `workingOther`: badge med glyf, afdæmpet farvetoning, ingen scurry.
- `overridden`: bruger den valgte glyf/farvetoning uanset aktivitet.

## Statusrække-tekst (menu)

- Mens arbejde er aktivt: `<Session role> · <activity label>`
  - Eksempler: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- Når inaktiv: falder tilbage til sundhedsoversigten.

## Indlæsning af hændelser

- Kilde: kontrolkanal `agent`-hændelser (`ControlChannel.handleAgentEvent`).
- Fortolkede felter:
  - `stream: "job"` med `data.state` for start/stop.
  - `stream: "tool"` med `data.phase`, `name`, valgfri `meta`/`args`.
- Etiketter:
  - `exec`: første linje af `args.command`.
  - `read`/`write`: forkortet sti.
  - `edit`: sti plus udledt ændringstype fra `meta`/diff‑tællinger.
  - fallback: værktøjsnavn.

## Debug‑overstyring

- Indstillinger ▸ Debug ▸ vælgeren “Icon override”:
  - `System (auto)` (standard)
  - `Working: main` (pr. værktøjstype)
  - `Working: other` (pr. værktøjstype)
  - `Idle`
- Gemmes via `@AppStorage("iconOverride")`; mappet til `IconState.overridden`.

## Testtjekliste

- Udløs job i primær session: verificér at ikonet skifter med det samme, og at statusrækken viser primær-etiketten.
- Udløs job i ikke‑primær session, mens primær er inaktiv: ikon/status viser ikke‑primær; forbliver stabilt, indtil det afsluttes.
- Start primær, mens andre er aktive: ikonet skifter straks til primær.
- Hurtige værktøjsudbrud: sikr, at badgen ikke flimrer (TTL‑henstand på værktøjsresultater).
- Sundhedsrækken dukker op igen, når alle sessioner er inaktive.
