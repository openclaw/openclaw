---
summary: "Direktivsyntax för /think + /verbose och hur de påverkar modellens resonemang"
read_when:
  - Justerar tolkning eller standardvärden för thinking- eller verbose-direktiv
title: "Tänknivåer"
---

# Tänknivåer (/think-direktiv)

## Vad det gör

- Inbäddat direktiv i vilken inkommande text som helst: `/t <level>`, `/think:<level>` eller `/thinking <level>`.
- Nivåer (alias): `off | minimal | low | medium | high | xhigh` (endast GPT-5.2 + Codex-modeller)
  - minimal → ”think”
  - low → ”think hard”
  - medium → ”think harder”
  - high → ”ultrathink” (maxbudget)
  - xhigh → ”ultrathink+” (endast GPT-5.2 + Codex-modeller)
  - `x-high`, `x_high`, `extra-high`, `extra high` och `extra_high` mappas till `xhigh`.
  - `highest`, `max` mappas till `high`.
- Leverantörsnoteringar:
  - Z.AI (`zai/*`) stöder endast binärt tänkande (`on`/`off`). Varje icke-`off`-nivå behandlas som `on` (mappad till `low`).

## Upplösningsordning

1. Inbäddat direktiv i meddelandet (gäller endast det meddelandet).
2. Sessionsöverskrivning (sätts genom att skicka ett meddelande som endast innehåller ett direktiv).
3. Global standard (`agents.defaults.thinkingDefault` i konfig).
4. Reserv: low för modeller med resonemang; annars off.

## Sätta en sessionsstandard

- Skicka ett meddelande som är **bara** direktivet (blanktecken tillåtet), t.ex. `/think:medium` eller `/t high`.
- Detta gäller för den aktuella sessionen (per avsändare som standard); rensas av `/think:off` eller genom återställning vid inaktiv session.
- Bekräftelse svar skickas (`Thinking nivå inställd på hög.` / `Thinking inaktiverad.`). Om nivån är ogiltig (t.ex. `/thinking big`), avvisas kommandot med en ledtråd och sessionstillståndet lämnas oförändrat.
- Skicka `/think` (eller `/think:`) utan argument för att se aktuell tänknivå.

## Tillämpning per agent

- **Inbäddad Pi**: den upplösta nivån skickas till Pi-agentens runtime i processen.

## Verbose-direktiv (/verbose eller /v)

- Nivåer: `on` (minimal) | `full` | `off` (standard).
- Meddelande med endast direktiv växlar sessionens verbose och svarar `Verbose logging enabled.` / `Verbose logging disabled.`; ogiltiga nivåer returnerar en ledtråd utan att ändra tillstånd.
- `/verbose off` lagrar en explicit sessionsöverskrivning; rensa den via Sessions-UI genom att välja `inherit`.
- Inbäddat direktiv påverkar endast det meddelandet; annars gäller sessions-/globala standarder.
- Skicka `/verbose` (eller `/verbose:`) utan argument för att se aktuell verbose-nivå.
- När verbose är på, agenter som avger strukturerade resultat verktyg (Pi, andra JSON agenter) skicka varje verktyg samtal tillbaka som sin egen metadata-endast-meddelande, prefixet med `<emoji> <tool-name>: <arg>` när tillgänglig (sökväg/kommandot). Dessa verktygssammanfattningar skickas så snart varje verktyg startar (separata bubblor), inte som strömmande deltas.
- När verbose är "full" vidarebefordras även verktygsutmatningar efter slutförandet (separat bubbla, trunkerade till en säker längd). Om du växlar `/verbose on<unk> full<unk> off` medan en körning är under flygning, efterföljande verktygsbubblor hedrar den nya inställningen.

## Synlighet för resonemang (/reasoning)

- Nivåer: `on|off|stream`.
- Meddelande med endast direktiv växlar om tankeblock visas i svar.
- När aktiverat skickas resonemang som ett **separat meddelande** prefixat med `Reasoning:`.
- `stream` (endast Telegram): strömmar resonemang in i Telegrams utkastbubbla medan svaret genereras, och skickar sedan det slutliga svaret utan resonemang.
- Alias: `/reason`.
- Skicka `/reasoning` (eller `/reasoning:`) utan argument för att se aktuell resonemangsnivå.

## Relaterat

- Dokumentation för förhöjt läge finns i [Elevated mode](/tools/elevated).

## Heartbeats

- Heartbeat sondkroppen är den konfigurerade hjärtslagsprompten (standard: `Read HEARTBEAT.md om den existerar (arbetsytans sammanhang). Följ den strikt. Sluta inte eller upprepa gamla uppgifter från tidigare chattar. Om inget behöver uppmärksamhet, svara HEARTBEAT_OK.`). Inline direktiv i ett hjärtslag meddelande gäller som vanligt (men undvik att ändra sessionsstandard från hjärtslag).
- Heartbeat leveransstandard är endast den slutliga nyttolasten. För att också skicka det separata `Anledning:` meddelandet (när det finns), sätt `agents.defaults.heartbeat.includeAnledning: true` eller per-agent `agents.list[].heartbeat.includeAnledning: true`.

## Webbchatt-UI

- Webbchattens tänkväljare speglar sessionens lagrade nivå från den inkommande sessionslagringen/konfigen när sidan laddas.
- Att välja en annan nivå gäller endast för nästa meddelande (`thinkingOnce`); efter skickande hoppar väljaren tillbaka till den lagrade sessionsnivån.
- För att ändra sessionsstandarden, skicka ett `/think:<level>`-direktiv (som tidigare); väljaren återspeglar detta efter nästa omladdning.
