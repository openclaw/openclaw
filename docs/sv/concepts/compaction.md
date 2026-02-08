---
summary: "Kontextfönster + kompaktering: hur OpenClaw håller sessioner inom modellgränser"
read_when:
  - Du vill förstå autokompaktering och /compact
  - Du felsöker långa sessioner som slår i kontextgränser
title: "Kompaktering"
x-i18n:
  source_path: concepts/compaction.md
  source_hash: e1d6791f2902044b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:53Z
---

# Kontextfönster & kompaktering

Varje modell har ett **kontextfönster** (max antal tokens den kan se). Långvariga chattar samlar på sig meddelanden och verktygsresultat; när fönstret blir trångt **kompakterar** OpenClaw äldre historik för att hålla sig inom gränserna.

## Vad kompaktering är

Kompaktering **sammanfattar äldre konversation** till en kompakt sammanfattningspost och behåller senaste meddelanden intakta. Sammanfattningen lagras i sessionshistoriken, så framtida förfrågningar använder:

- Kompakteringssammanfattningen
- Senaste meddelanden efter kompakteringspunkten

Kompaktering **består** i sessionens JSONL-historik.

## Konfiguration

Se [Kompakteringskonfig & lägen](/concepts/compaction) för inställningarna `agents.defaults.compaction`.

## Autokompaktering (på som standard)

När en session närmar sig eller överskrider modellens kontextfönster utlöser OpenClaw autokompaktering och kan försöka om den ursprungliga begäran med den kompakterade kontexten.

Du ser:

- `🧹 Auto-compaction complete` i utförligt läge
- `/status` som visar `🧹 Compactions: <count>`

Före kompaktering kan OpenClaw köra en **tyst minnesrensning** för att lagra beständiga anteckningar på disk. Se [Minne](/concepts/memory) för detaljer och konfiguration.

## Manuell kompaktering

Använd `/compact` (valfritt med instruktioner) för att tvinga en kompakteringskörning:

```
/compact Focus on decisions and open questions
```

## Källa för kontextfönster

Kontextfönstret är modellspecifikt. OpenClaw använder modelldefinitionen från den konfigurerade leverantörskatalogen för att fastställa gränser.

## Kompaktering vs beskärning

- **Kompaktering**: sammanfattar och **består** i JSONL.
- **Sessionsbeskärning**: trimmar endast gamla **verktygsresultat**, **i minnet**, per begäran.

Se [/concepts/session-pruning](/concepts/session-pruning) för detaljer om beskärning.

## Tips

- Använd `/compact` när sessioner känns stela eller kontexten är uppblåst.
- Stora verktygsutdata trunkeras redan; beskärning kan ytterligare minska ansamling av verktygsresultat.
- Om du behöver ett helt nytt blad, `/new` eller `/reset` startar ett nytt sessions-ID.
