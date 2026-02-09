---
summary: "Direktivsyntaks for /think + /verbose og hvordan de påvirker modellens ræsonnering"
read_when:
  - Justering af parsing eller standarder for thinking- eller verbose-direktiver
title: "Thinking-niveauer"
---

# Thinking-niveauer (/think-direktiver)

## Hvad det gør

- Inline-direktiv i enhver indgående body: `/t <level>`, `/think:<level>` eller `/thinking <level>`.
- Niveauer (aliaser): `off | minimal | low | medium | high | xhigh` (kun GPT-5.2 + Codex-modeller)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (maks. budget)
  - xhigh → “ultrathink+” (kun GPT-5.2 + Codex-modeller)
  - `x-high`, `x_high`, `extra-high`, `extra high` og `extra_high` mapper til `xhigh`.
  - `highest`, `max` mapper til `high`.
- Udbydernoter:
  - Z.AI (`zai/*`) understøtter kun binær tænkning (`on`/`off`). Ethvert ikke-`off` niveau behandles som `on` (kortlagt til `lav`).

## Opløsningsrækkefølge

1. Inline-direktiv på beskeden (gælder kun den besked).
2. Session override (sat ved at sende en besked, der kun indeholder direktivet).
3. Global standard (`agents.defaults.thinkingDefault` i konfigurationen).
4. Fallback: low for modeller med ræsonneringsevne; ellers off.

## Indstilling af en sessionsstandard

- Send en besked, der er **kun** direktivet (blanke tegn tilladt), f.eks. `/think:medium` eller `/t høj`.
- Det gælder for den aktuelle session (som standard pr. afsender); ryddes af `/think:off` eller session idle-reset.
- Bekræftelse svar sendes (`Thinking level set til high.` / `Thinking disabled.`). Hvis niveauet er ugyldigt (f.eks. `/thinking big`), afvises kommandoen med et vink og sessionstilstanden forbliver uændret.
- Send `/think` (eller `/think:`) uden argument for at se det aktuelle thinking-niveau.

## Anvendelse pr. agent

- **Embedded Pi**: det opløste niveau sendes til Pi-agentens runtime i processen.

## Verbose-direktiver (/verbose eller /v)

- Niveauer: `on` (minimal) | `full` | `off` (standard).
- En besked, der kun indeholder direktivet, slår session verbose til/fra og svarer `Verbose logging enabled.` / `Verbose logging disabled.`; ugyldige niveauer returnerer et hint uden at ændre tilstand.
- `/verbose off` gemmer en eksplicit session override; ryd den via Sessions UI ved at vælge `inherit`.
- Inline-direktiv påvirker kun den besked; session-/globale standarder gælder ellers.
- Send `/verbose` (eller `/verbose:`) uden argument for at se det aktuelle verbose-niveau.
- Når verbose er på, agenter, der udsender strukturerede værktøj resultater (Pi, andre JSON agents) sende hvert værktøj opkald tilbage som sin egen metadata-only besked, prefixed with `<emoji> <tool-name>: <arg>` when available (path/command). Disse værktøj resuméer sendes så snart hvert værktøj starter (separate bobler), ikke som streaming deltas.
- Når verbose er `full`, værktøjsudgange også videresendes efter færdiggørelse (separat boble, afkortet til en sikker længde). Hvis du skifter til `/verbose på fullřoff` mens en kørsel er under flyvning, efterfølgende værktøj bobler ære den nye indstilling.

## Synlighed af ræsonnering (/reasoning)

- Niveauer: `on|off|stream`.
- En besked, der kun indeholder direktivet, slår visning af thinking-blokke i svar til/fra.
- Når aktiveret, sendes ræsonnering som en **separat besked** præfikset med `Reasoning:`.
- `stream` (kun Telegram): streamer ræsonnering ind i Telegram-kladdeboblen, mens svaret genereres, og sender derefter det endelige svar uden ræsonnering.
- Alias: `/reason`.
- Send `/reasoning` (eller `/reasoning:`) uden argument for at se det aktuelle ræsonneringsniveau.

## Relateret

- Dokumentation for Elevated mode findes i [Elevated mode](/tools/elevated).

## Heartbeats

- Hjertebanksonde krop er den konfigurerede hjerteslag prompt (standard: `Læs HEARTBEAT.md hvis det findes (arbejdsområde kontekst). Følg den nøje. Udsæt eller gentag ikke gamle opgaver fra tidligere chats. Hvis intet behøver opmærksomhed, besvar HEARTBEAT_OK.`). Inline direktiver i et hjerteslag besked anvendes som sædvanligt (men undgå at ændre session standarder fra hjerteslag).
- Levering af hjerteslag er som standard kun den endelige nyttelast. For også at sende den separate `Reasoning:` meddelelse (når tilgængelig), sæt `agents.defaults.heartbeat.includeReasoning: true` eller per-agent `agents.list[].heartbeat.includeReasoning: true`.

## Web chat UI

- Webchat-tænkevælgeren afspejler sessionens gemte niveau fra den indgående session store/konfiguration, når siden indlæses.
- Valg af et andet niveau gælder kun for den næste besked (`thinkingOnce`); efter afsendelse springer vælgeren tilbage til det gemte sessionsniveau.
- For at ændre sessionsstandarden skal du sende et `/think:<level>`-direktiv (som før); vælgeren vil afspejle det efter næste genindlæsning.
