---
summary: "Kontekstvindue + komprimering: hvordan OpenClaw holder sessioner under modellens grænser"
read_when:
  - Du vil forstå auto-komprimering og /compact
  - Du fejlsøger lange sessioner, der rammer kontekstgrænser
title: "Komprimering"
---

# Kontekstvindue & komprimering

Hver model har et \*\* kontekstvindue \*\* (max tokens det kan se). Langvarige chats akkumulerer beskeder og værktøjseresultater; når vinduet er stramt, opsamler OpenClaw \*\* ældre historik for at holde sig inden for grænser.

## Hvad komprimering er

Komprimering **opsummerer ældre samtale** i en kompakt summarisk indgang og holder de seneste meddelelser intakte. Resuméet er gemt i sessionshistorien, så fremtidige anmodninger bruger:

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

Før komprimering kan OpenClaw køre en \*\* tavs hukommelse flush\*\* slå til for at gemme
holdbare noter til disk. Se [Memory](/concepts/memory) for detaljer og config.

## Manuel komprimering

Brug `/compact` (valgfrit med instruktioner) for at gennemtvinge en komprimeringsrunde:

```
/compact Focus on decisions and open questions
```

## Kilde til kontekstvindue

Kontekstvindue er modelspecifikt. OpenClaw bruger modeldefinitionen fra det konfigurerede leverandørkatalog til at bestemme grænser.

## Komprimering vs. beskæring

- **Komprimering**: opsummerer og **bevares** i JSONL.
- **Sessionsbeskæring**: trimmer kun gamle **værktøjsresultater**, **i hukommelsen**, pr. forespørgsel.

Se [/concepts/session-pruning](/concepts/session-pruning) for detaljer om beskæring.

## Tips

- Brug `/compact`, når sessioner føles stagnerede, eller konteksten er oppustet.
- Store værktøjsoutput er allerede trunkeret; beskæring kan yderligere reducere ophobning af værktøjsresultater.
- Hvis du har brug for en helt frisk start, starter `/new` eller `/reset` et nyt sessions-id.
