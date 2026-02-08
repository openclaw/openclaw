---
summary: "Direktivsyntax för /think + /verbose och hur de påverkar modellens resonemang"
read_when:
  - Justerar tolkning eller standardvärden för thinking- eller verbose-direktiv
title: "Tänknivåer"
x-i18n:
  source_path: tools/thinking.md
  source_hash: 0ae614147675be32
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:53Z
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
  - Z.AI (`zai/*`) stöder endast binärt tänkande (`on`/`off`). Alla icke-`off`-nivåer behandlas som `on` (mappas till `low`).

## Upplösningsordning

1. Inbäddat direktiv i meddelandet (gäller endast det meddelandet).
2. Sessionsöverskrivning (sätts genom att skicka ett meddelande som endast innehåller ett direktiv).
3. Global standard (`agents.defaults.thinkingDefault` i konfig).
4. Reserv: low för modeller med resonemang; annars off.

## Sätta en sessionsstandard

- Skicka ett meddelande som **endast** är direktivet (blanksteg tillåts), t.ex. `/think:medium` eller `/t high`.
- Detta gäller för den aktuella sessionen (per avsändare som standard); rensas av `/think:off` eller genom återställning vid inaktiv session.
- En bekräftelse skickas (`Thinking level set to high.` / `Thinking disabled.`). Om nivån är ogiltig (t.ex. `/thinking big`) avvisas kommandot med en ledtråd och sessionsläget lämnas oförändrat.
- Skicka `/think` (eller `/think:`) utan argument för att se aktuell tänknivå.

## Tillämpning per agent

- **Inbäddad Pi**: den upplösta nivån skickas till Pi-agentens runtime i processen.

## Verbose-direktiv (/verbose eller /v)

- Nivåer: `on` (minimal) | `full` | `off` (standard).
- Meddelande med endast direktiv växlar sessionens verbose och svarar `Verbose logging enabled.` / `Verbose logging disabled.`; ogiltiga nivåer returnerar en ledtråd utan att ändra tillstånd.
- `/verbose off` lagrar en explicit sessionsöverskrivning; rensa den via Sessions-UI genom att välja `inherit`.
- Inbäddat direktiv påverkar endast det meddelandet; annars gäller sessions-/globala standarder.
- Skicka `/verbose` (eller `/verbose:`) utan argument för att se aktuell verbose-nivå.
- När verbose är på skickar agenter som emitterar strukturerade verktygsresultat (Pi, andra JSON-agenter) varje verktygsanrop tillbaka som ett eget meddelande med endast metadata, prefixat med `<emoji> <tool-name>: <arg>` när tillgängligt (sökväg/kommando). Dessa verktygssammanfattningar skickas så snart varje verktyg startar (separata bubblor), inte som strömmande deltas.
- När verbose är `full` vidarebefordras även verktygsutdata efter slutförande (separat bubbla, trunkerad till säker längd). Om du växlar `/verbose on|full|off` medan en körning pågår, följer efterföljande verktygsbubblor den nya inställningen.

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

- Heartbeat-probens innehåll är den konfigurerade heartbeat-prompten (standard: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Inbäddade direktiv i ett heartbeat-meddelande gäller som vanligt (men undvik att ändra sessionsstandarder från heartbeats).
- Leverans av heartbeats skickar som standard endast den slutliga payloaden. För att även skicka det separata `Reasoning:`-meddelandet (när tillgängligt), sätt `agents.defaults.heartbeat.includeReasoning: true` eller per agent `agents.list[].heartbeat.includeReasoning: true`.

## Webbchatt-UI

- Webbchattens tänkväljare speglar sessionens lagrade nivå från den inkommande sessionslagringen/konfigen när sidan laddas.
- Att välja en annan nivå gäller endast för nästa meddelande (`thinkingOnce`); efter skickande hoppar väljaren tillbaka till den lagrade sessionsnivån.
- För att ändra sessionsstandarden, skicka ett `/think:<level>`-direktiv (som tidigare); väljaren återspeglar detta efter nästa omladdning.
