---
summary: "macOS-tilladelsers persistens (TCC) og krav til signering"
read_when:
  - Fejlfinding af manglende eller fastlåste macOS-tilladelsesprompter
  - Pakning eller signering af macOS-appen
  - Ændring af bundle-id'er eller app-installationsstier
title: "macOS-tilladelser"
---

# macOS-tilladelser (TCC)

macOS tilladelse tilskud er skrøbelige. TCC forbinder en tilladelse med
appens kode-signatur, bundt-id og på disk-sti. Hvis nogen af disse ændringer,
macOS behandler app som ny og kan slippe eller skjule prompter.

## Krav for stabile tilladelser

- Samme sti: kør appen fra en fast placering (for OpenClaw, `dist/OpenClaw.app`).
- Samme bundle-id: ændring af bundle-id opretter en ny tilladelsesidentitet.
- Signeret app: usignerede eller ad-hoc-signerede builds bevarer ikke tilladelser.
- Konsistent signatur: brug et ægte Apple Development- eller Developer ID-certifikat,
  så signaturen forbliver stabil på tværs af genbygninger.

Ad-hoc signaturer genererer en ny identitet hver bygning. macOS vil glemme tidligere
tilskud, og beder kan helt forsvinde, indtil forældede poster er ryddet.

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

macOS kan også gate Desktop, dokumenter og downloads til terminal/baggrundsprocesser. Hvis filen læser eller mappelister hænger, gives adgang til den samme processammenhæng, der udfører filoperationer (f.eks. Terminal/iTerm, LaunchAgent-lanceret app eller SSH proces).

Workaround: flyt filer ind i OpenClaw-arbejdsområdet (`~/.openclaw/workspace`), hvis du vil undgå tilladelser pr. mappe.

Hvis du tester tilladelser, skal du altid underskrive med et rigtigt certifikat. Ad-hoc
builds er kun acceptable for hurtige lokale kørsler, hvor tilladelser ikke betyder noget.
