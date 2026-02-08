---
summary: "Direktivsyntaks for /think + /verbose og hvordan de påvirker modellens ræsonnering"
read_when:
  - Justering af parsing eller standarder for thinking- eller verbose-direktiver
title: "Thinking-niveauer"
x-i18n:
  source_path: tools/thinking.md
  source_hash: 0ae614147675be32
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:49Z
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
  - Z.AI (`zai/*`) understøtter kun binær thinking (`on`/`off`). Ethvert ikke-`off`-niveau behandles som `on` (mapper til `low`).

## Opløsningsrækkefølge

1. Inline-direktiv på beskeden (gælder kun den besked).
2. Session override (sat ved at sende en besked, der kun indeholder direktivet).
3. Global standard (`agents.defaults.thinkingDefault` i konfigurationen).
4. Fallback: low for modeller med ræsonneringsevne; ellers off.

## Indstilling af en sessionsstandard

- Send en besked, der **kun** er direktivet (whitespace er tilladt), f.eks. `/think:medium` eller `/t high`.
- Det gælder for den aktuelle session (som standard pr. afsender); ryddes af `/think:off` eller session idle-reset.
- En bekræftelsessvar sendes (`Thinking level set to high.` / `Thinking disabled.`). Hvis niveauet er ugyldigt (f.eks. `/thinking big`), afvises kommandoen med et hint, og sessionens tilstand forbliver uændret.
- Send `/think` (eller `/think:`) uden argument for at se det aktuelle thinking-niveau.

## Anvendelse pr. agent

- **Embedded Pi**: det opløste niveau sendes til Pi-agentens runtime i processen.

## Verbose-direktiver (/verbose eller /v)

- Niveauer: `on` (minimal) | `full` | `off` (standard).
- En besked, der kun indeholder direktivet, slår session verbose til/fra og svarer `Verbose logging enabled.` / `Verbose logging disabled.`; ugyldige niveauer returnerer et hint uden at ændre tilstand.
- `/verbose off` gemmer en eksplicit session override; ryd den via Sessions UI ved at vælge `inherit`.
- Inline-direktiv påvirker kun den besked; session-/globale standarder gælder ellers.
- Send `/verbose` (eller `/verbose:`) uden argument for at se det aktuelle verbose-niveau.
- Når verbose er slået til, sender agenter, der udsender strukturerede værktøjsresultater (Pi, andre JSON-agenter), hvert værktøjskald tilbage som sin egen metadata-only-besked, præfikset med `<emoji> <tool-name>: <arg>` når tilgængeligt (sti/kommando). Disse værktøjsopsummeringer sendes, så snart hvert værktøj starter (separate bobler), ikke som streaming-deltaer.
- Når verbose er `full`, videresendes værktøjsoutput også efter afslutning (separat boble, afkortet til en sikker længde). Hvis du skifter `/verbose on|full|off`, mens et run er i gang, følger efterfølgende værktøjsbobler den nye indstilling.

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

- Heartbeat-probe-body er den konfigurerede heartbeat-prompt (standard: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Inline-direktiver i en heartbeat-besked anvendes som normalt (men undgå at ændre sessionsstandarder fra heartbeats).
- Heartbeat-levering er som standard kun den endelige payload. For også at sende den separate `Reasoning:`-besked (når tilgængelig), sæt `agents.defaults.heartbeat.includeReasoning: true` eller pr. agent `agents.list[].heartbeat.includeReasoning: true`.

## Web chat UI

- Webchat-tænkevælgeren afspejler sessionens gemte niveau fra den indgående session store/konfiguration, når siden indlæses.
- Valg af et andet niveau gælder kun for den næste besked (`thinkingOnce`); efter afsendelse springer vælgeren tilbage til det gemte sessionsniveau.
- For at ændre sessionsstandarden skal du sende et `/think:<level>`-direktiv (som før); vælgeren vil afspejle det efter næste genindlæsning.
