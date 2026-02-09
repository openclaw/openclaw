---
summary: "Persistente macOS-machtigingen (TCC) en vereisten voor ondertekening"
read_when:
  - Foutopsporing bij ontbrekende of vastgelopen macOS-machtigingsprompts
  - Het verpakken of ondertekenen van de macOS-app
  - Het wijzigen van bundle-ID's of app-installatiepaden
title: "macOS-machtigingen"
---

# macOS-machtigingen (TCC)

macOS-machtigingsverlening is kwetsbaar. TCC koppelt een machtigingsverlening aan de
code-ondertekening, bundle-ID en het pad op schijf van de app. Als een van deze verandert,
beschouwt macOS de app als nieuw en kan het prompts laten vervallen of verbergen.

## Vereisten voor stabiele machtigingen

- Hetzelfde pad: voer de app uit vanaf een vaste locatie (voor OpenClaw, `dist/OpenClaw.app`).
- Dezelfde bundle-ID: het wijzigen van de bundle-ID creëert een nieuwe machtigingsidentiteit.
- Ondertekende app: niet-ondertekende of ad-hoc ondertekende builds behouden geen machtigingen.
- Consistente ondertekening: gebruik een echt Apple Development- of Developer ID-certificaat
  zodat de ondertekening stabiel blijft over rebuilds heen.

Ad-hoc ondertekeningen genereren bij elke build een nieuwe identiteit. macOS zal eerdere
verleningen vergeten, en prompts kunnen volledig verdwijnen totdat de verouderde vermeldingen
zijn opgeschoond.

## Herstelchecklist wanneer prompts verdwijnen

1. Sluit de app af.
2. Verwijder de app-vermelding in Systeeminstellingen -> Privacy en beveiliging.
3. Start de app opnieuw vanaf hetzelfde pad en verleen de machtigingen opnieuw.
4. Als de prompt nog steeds niet verschijnt, reset TCC-vermeldingen met `tccutil` en probeer het opnieuw.
5. Sommige machtigingen verschijnen pas weer na een volledige herstart van macOS.

Voorbeeldresets (vervang de bundle-ID indien nodig):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Machtigingen voor bestanden en mappen (Bureaublad/Documenten/Downloads)

macOS kan ook het Bureaublad, Documenten en Downloads afschermen voor terminal-/achtergrondprocessen. Als het lezen van bestanden of het weergeven van mappen blijft hangen, verleen dan toegang aan dezelfde procescontext die de bestandsbewerkingen uitvoert (bijvoorbeeld Terminal/iTerm, een via LaunchAgent gestart app of een SSH-proces).

Workaround: verplaats bestanden naar de OpenClaw-werkruimte (`~/.openclaw/workspace`) als je per-map-verleningen wilt vermijden.

Als je machtigingen test, onderteken altijd met een echt certificaat. Ad-hoc
builds zijn alleen acceptabel voor snelle lokale runs waarbij machtigingen niet van belang zijn.
