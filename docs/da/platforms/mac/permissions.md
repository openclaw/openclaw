---
summary: "macOS-tilladelsers persistens (TCC) og krav til signering"
read_when:
  - Fejlfinding af manglende eller fastlåste macOS-tilladelsesprompter
  - Pakning eller signering af macOS-appen
  - Ændring af bundle-id'er eller app-installationsstier
title: "macOS-tilladelser"
x-i18n:
  source_path: platforms/mac/permissions.md
  source_hash: 52bee5c896e31e99
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:27Z
---

# macOS-tilladelser (TCC)

macOS-tilladelsesbevillinger er skrøbelige. TCC knytter en tilladelsesbevilling til
appens kodesignatur, bundle-id og sti på disken. Hvis nogen af disse ændres,
behandler macOS appen som ny og kan droppe eller skjule prompter.

## Krav for stabile tilladelser

- Samme sti: kør appen fra en fast placering (for OpenClaw, `dist/OpenClaw.app`).
- Samme bundle-id: ændring af bundle-id opretter en ny tilladelsesidentitet.
- Signeret app: usignerede eller ad-hoc-signerede builds bevarer ikke tilladelser.
- Konsistent signatur: brug et ægte Apple Development- eller Developer ID-certifikat,
  så signaturen forbliver stabil på tværs af genbygninger.

Ad-hoc-signaturer genererer en ny identitet ved hvert build. macOS glemmer tidligere
bevillinger, og prompter kan forsvinde helt, indtil de forældede poster ryddes.

## Tjekliste til gendannelse, når prompter forsvinder

1. Afslut appen.
2. Fjern app-posten i Systemindstillinger -> Privatliv & sikkerhed.
3. Genstart appen fra samme sti og giv tilladelserne igen.
4. Hvis prompten stadig ikke vises, nulstil TCC-poster med `tccutil` og prøv igen.
5. Nogle tilladelser dukker først op igen efter en fuld genstart af macOS.

Eksempel på nulstillinger (erstat bundle-id efter behov):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Tilladelser til filer og mapper (Skrivebord/Dokumenter/Overførsler)

macOS kan også begrænse Skrivebord, Dokumenter og Overførsler for terminal-/baggrundsprocesser. Hvis fillæsning eller mappelister hænger, så giv adgang til den samme proceskontekst, der udfører filoperationerne (for eksempel Terminal/iTerm, en app startet via LaunchAgent eller en SSH-proces).

Workaround: flyt filer ind i OpenClaw-arbejdsområdet (`~/.openclaw/workspace`), hvis du vil undgå tilladelser pr. mappe.

Hvis du tester tilladelser, så signér altid med et ægte certifikat. Ad-hoc
builds er kun acceptable til hurtige lokale kørsler, hvor tilladelser ikke er vigtige.
