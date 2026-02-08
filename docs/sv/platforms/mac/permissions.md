---
summary: "Beständighet för macOS-behörigheter (TCC) och krav på signering"
read_when:
  - Felsökning av saknade eller fastnade macOS-behörighetsprompter
  - Paketering eller signering av macOS-appen
  - Ändring av bundle-ID eller appens installationssökvägar
title: "macOS-behörigheter"
x-i18n:
  source_path: platforms/mac/permissions.md
  source_hash: 52bee5c896e31e99
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:58Z
---

# macOS-behörigheter (TCC)

macOS-behörighetsbeviljanden är sköra. TCC kopplar ett behörighetsbeviljande till
appens kodsignatur, bundle-identifierare och sökväg på disk. Om någon av dessa ändras
behandlar macOS appen som ny och kan ta bort eller dölja prompter.

## Krav för stabila behörigheter

- Samma sökväg: kör appen från en fast plats (för OpenClaw, `dist/OpenClaw.app`).
- Samma bundle-identifierare: att ändra bundle-ID skapar en ny behörighetsidentitet.
- Signerad app: osignerade eller ad-hoc-signerade byggen bevarar inte behörigheter.
- Konsekvent signatur: använd ett riktigt Apple Development- eller Developer ID-certifikat
  så att signaturen förblir stabil mellan ombyggen.

Ad-hoc-signaturer skapar en ny identitet vid varje bygge. macOS glömmer tidigare
beviljanden, och prompter kan försvinna helt tills de inaktuella posterna rensas.

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

macOS kan även begränsa Skrivbord, Dokument och Hämtningar för terminal- eller bakgrundsprocesser. Om filläsningar eller kataloglistningar hänger, bevilja åtkomst till samma processkontext som utför filoperationerna (till exempel Terminal/iTerm, en app som startas via LaunchAgent eller en SSH-process).

Tillfällig lösning: flytta filer till OpenClaw-arbetsytan (`~/.openclaw/workspace`) om du vill undvika behörigheter per mapp.

Om du testar behörigheter, signera alltid med ett riktigt certifikat. Ad-hoc-
byggen är endast acceptabla för snabba lokala körningar där behörigheter inte spelar någon roll.
