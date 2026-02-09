---
summary: "Beständighet för macOS-behörigheter (TCC) och krav på signering"
read_when:
  - Felsökning av saknade eller fastnade macOS-behörighetsprompter
  - Paketering eller signering av macOS-appen
  - Ändring av bundle-ID eller appens installationssökvägar
title: "macOS-behörigheter"
---

# macOS-behörigheter (TCC)

macOS tillståndsbidrag är bräckliga. TCC associerar ett behörighetsbidrag med
appens kodsignatur, paketidentifierare och sökväg på disk. Om någon av dessa ändringar,
macOS behandlar appen som ny och kan släppa eller dölja uppmaningar.

## Krav för stabila behörigheter

- Samma sökväg: kör appen från en fast plats (för OpenClaw, `dist/OpenClaw.app`).
- Samma bundle-identifierare: att ändra bundle-ID skapar en ny behörighetsidentitet.
- Signerad app: osignerade eller ad-hoc-signerade byggen bevarar inte behörigheter.
- Konsekvent signatur: använd ett riktigt Apple Development- eller Developer ID-certifikat
  så att signaturen förblir stabil mellan ombyggen.

Ad-hoc signaturer genererar en ny identitet varje bygge. macOS kommer att glömma tidigare
bidrag, och uppmaningar kan försvinna helt tills inaktuella poster rensas.

## Återställningschecklista när prompter försvinner

1. Avsluta appen.
2. Ta bort appens post i Systeminställningar -> Integritet & säkerhet.
3. Starta om appen från samma sökväg och bevilja behörigheter igen.
4. Om prompten fortfarande inte visas, återställ TCC-poster med `tccutil` och försök igen.
5. Vissa behörigheter återkommer först efter en fullständig omstart av macOS.

Exempel på återställningar (ersätt bundle-ID vid behov):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Behörigheter för filer och mappar (Skrivbord/Dokument/Hämtningar)

macOS kan också grinda skrivbordet, dokument och nedladdningar för terminal/bakgrundsprocesser. Om filen läser eller kataloglistningar hänger, ge åtkomst till samma processsammanhang som utför filverksamhet (till exempel Terminal/iTerm, LaunchAgent-lanserad app eller SSH-process).

Tillfällig lösning: flytta filer till OpenClaw-arbetsytan (`~/.openclaw/workspace`) om du vill undvika behörigheter per mapp.

Om du testar behörigheter, underteckna alltid med ett riktigt certifikat. Ad-hoc
bygger är endast acceptabla för snabba lokala körningar där behörigheter inte spelar någon roll.
