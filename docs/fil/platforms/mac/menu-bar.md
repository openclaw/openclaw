---
summary: "Lohika ng status ng menu bar at kung ano ang ipinapakita sa mga user"
read_when:
  - Pag-aayos ng mac menu UI o lohika ng status
title: "Menu Bar"
---

# Lohika ng Status ng Menu Bar

## Ano ang ipinapakita

- Ipinapakita namin ang kasalukuyang estado ng trabaho ng agent sa icon ng menu bar at sa unang status row ng menu.
- Nakatago ang health status habang may aktibong trabaho; bumabalik ito kapag idle na ang lahat ng session.
- Ang block na “Nodes” sa menu ay naglilista ng **mga device** lamang (paired nodes via `node.list`), hindi mga entry ng client/presence.
- Lumalabas ang seksyong “Usage” sa ilalim ng Context kapag available ang provider usage snapshots.

## Modelo ng estado

- Mga session: dumarating ang mga event na may `runId` (per-run) kasama ang `sessionKey` sa payload. Ang “main” na session ay ang key na `main`; kung wala ito, babalik tayo sa pinakahuling na-update na session.
- Prayoridad: laging nananalo ang main. 1. Kapag aktibo ang main, agad na ipinapakita ang estado nito. Kung idle ang main, ipinapakita ang pinakahuling aktibong non‑main na session. Hindi kami nagpapalit-palit sa gitna ng aktibidad; nagpapalit lamang kami kapag naging idle ang kasalukuyang session o naging aktibo ang main.
- Mga uri ng aktibidad:
  - `job`: high‑level na pag-execute ng command (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` na may `toolName` at `meta/args`.

## IconState enum (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (debug override)

### ActivityKind → glyph

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- default → 🛠️

### Visual mapping

- `idle`: normal na critter.
- `workingMain`: badge na may glyph, full tint, animation ng “working” na mga paa.
- `workingOther`: badge na may glyph, muted na tint, walang scurry.
- `overridden`: ginagamit ang napiling glyph/tint anuman ang aktibidad.

## Teksto ng status row (menu)

- Habang aktibo ang trabaho: `<Session role> · <activity label>`
  - Mga halimbawa: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- Kapag idle: bumabalik sa buod ng health.

## Pag-ingest ng event

- Pinagmulan: control‑channel `agent` events (`ControlChannel.handleAgentEvent`).
- Mga na-parse na field:
  - `stream: "job"` na may `data.state` para sa start/stop.
  - `stream: "tool"` na may `data.phase`, `name`, opsyonal na `meta`/`args`.
- Mga label:
  - `exec`: unang linya ng `args.command`.
  - `read`/`write`: pinaikling path.
  - `edit`: path kasama ang inferred na uri ng pagbabago mula sa `meta`/bilang ng diff.
  - fallback: pangalan ng tool.

## Debug override

- Settings ▸ Debug ▸ “Icon override” picker:
  - `System (auto)` (default)
  - `Working: main` (per tool kind)
  - `Working: other` (per tool kind)
  - `Idle`
- Ini-store sa pamamagitan ng `@AppStorage("iconOverride")`; mina-map sa `IconState.overridden`.

## Checklist sa testing

- I-trigger ang job ng main session: tiyaking agad na nag-i-switch ang icon at ipinapakita ng status row ang label ng main.
- I-trigger ang job ng non‑main session habang idle ang main: ipinapakita ng icon/status ang non‑main; nananatiling stable hanggang matapos ito.
- Simulan ang main habang may ibang aktibo: agad na lilipat ang icon sa main.
- Mabilis na mga burst ng tool: tiyaking hindi nagfi-flicker ang badge (TTL grace sa mga resulta ng tool).
- Muling lalabas ang health row kapag idle na ang lahat ng session.
