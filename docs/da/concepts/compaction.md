---
summary: "Kontekstvindue + komprimering: hvordan OpenClaw holder sessioner under modellens grænser"
read_when:
  - Du vil forstå auto-komprimering og /compact
  - Du fejlsøger lange sessioner, der rammer kontekstgrænser
title: "Komprimering"
x-i18n:
  source_path: concepts/compaction.md
  source_hash: e1d6791f2902044b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:08Z
---

# Kontekstvindue & komprimering

Hver model har et **kontekstvindue** (maks. antal tokens, den kan se). Langvarige chats ophober beskeder og værktøjsresultater; når vinduet bliver snævert, **komprimerer** OpenClaw ældre historik for at blive inden for grænserne.

## Hvad komprimering er

Komprimering **opsummerer ældre samtale** i en kompakt opsummeringspost og bevarer de seneste beskeder intakte. Opsummeringen gemmes i sessionshistorikken, så fremtidige forespørgsler bruger:

- Komprimeringsopsummeringen
- Seneste beskeder efter komprimeringspunktet

Komprimering **bevares** i sessionens JSONL-historik.

## Konfiguration

Se [Compaction config & modes](/concepts/compaction) for indstillingerne `agents.defaults.compaction`.

## Auto-komprimering (slået til som standard)

Når en session nærmer sig eller overskrider modellens kontekstvindue, udløser OpenClaw auto-komprimering og kan genforsøge den oprindelige forespørgsel med den komprimerede kontekst.

Du vil se:

- `🧹 Auto-compaction complete` i udførlig tilstand
- `/status` som viser `🧹 Compactions: <count>`

Før komprimering kan OpenClaw køre en **stille hukommelsesrydning** for at gemme
holdbare noter på disk. Se [Memory](/concepts/memory) for detaljer og konfiguration.

## Manuel komprimering

Brug `/compact` (valgfrit med instruktioner) for at gennemtvinge en komprimeringsrunde:

```
/compact Focus on decisions and open questions
```

## Kilde til kontekstvindue

Kontekstvinduet er modelspecifikt. OpenClaw bruger modeldefinitionen fra den konfigurerede udbyderkatalog til at fastlægge grænser.

## Komprimering vs. beskæring

- **Komprimering**: opsummerer og **bevares** i JSONL.
- **Sessionsbeskæring**: trimmer kun gamle **værktøjsresultater**, **i hukommelsen**, pr. forespørgsel.

Se [/concepts/session-pruning](/concepts/session-pruning) for detaljer om beskæring.

## Tips

- Brug `/compact`, når sessioner føles stagnerede, eller konteksten er oppustet.
- Store værktøjsoutput er allerede trunkeret; beskæring kan yderligere reducere ophobning af værktøjsresultater.
- Hvis du har brug for en helt frisk start, starter `/new` eller `/reset` et nyt sessions-id.
