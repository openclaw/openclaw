---
summary: "Referenz: anbieterspezifische Regeln zur Bereinigung und Reparatur von Transkripten"
read_when:
  - Sie debuggen Anbieter-Ablehnungen von Anfragen, die mit der Struktur des Transkripts zusammenhängen
  - Sie ändern die Bereinigung von Transkripten oder die Reparaturlogik für Tool-Aufrufe
  - Sie untersuchen Inkonsistenzen von Tool-Call-IDs über Anbieter hinweg
title: "Transkript-Hygiene"
---

# Transkript-Hygiene (Anbieter-Fixups)

Dieses Dokument beschreibt **anbieterspezifische Korrekturen**, die vor einem Run
(Erstellung des Modellkontexts) auf Transkripte angewendet werden. Dabei handelt es sich um **In-Memory**-Anpassungen, um strenge
Anbieteranforderungen zu erfüllen. Diese Hygieneschritte schreiben das gespeicherte JSONL-Transkript
auf der Festplatte **nicht** um; ein separater Reparaturlauf für Sitzungsdateien kann jedoch
fehlerhafte JSONL-Dateien reparieren, indem ungültige Zeilen verworfen werden, bevor die Sitzung
geladen wird. Wenn eine Reparatur erfolgt, wird die Originaldatei neben der Sitzungsdatei gesichert.

Der Umfang umfasst:

- Bereinigung von Tool-Call-IDs
- Validierung von Tool-Call-Eingaben
- Reparatur der Zuordnung von Tool-Ergebnissen
- Validierung/Sortierung von Turns
- Bereinigung von Thought-Signaturen
- Bereinigung von Bild-Payloads

Wenn Sie Details zur Transkriptspeicherung benötigen, siehe:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Wo dies ausgeführt wird

Die gesamte Transkript-Hygiene ist im eingebetteten Runner zentralisiert:

- Richtlinienauswahl: `src/agents/transcript-policy.ts`
- Anwendung von Bereinigung/Reparatur: `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`

Die Richtlinie verwendet `provider`, `modelApi` und `modelId`, um zu entscheiden, was angewendet wird.

Getrennt von der Transkript-Hygiene werden Sitzungsdateien (falls erforderlich) vor dem Laden repariert:

- `repairSessionFileIfNeeded` in `src/agents/session-file-repair.ts`
- Aufgerufen von `run/attempt.ts` und `compact.ts` (eingebetteter Runner)

---

## Globale Regel: Bildbereinigung

Bild-Payloads werden immer bereinigt, um Anbieter-seitige Ablehnungen aufgrund von Größenbeschränkungen
zu verhindern (Herunterskalieren/Neukomprimieren übergroßer Base64-Bilder).

Implementierung:

- `sanitizeSessionMessagesImages` in `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` in `src/agents/tool-images.ts`

---

## Globale Regel: fehlerhafte Tool-Aufrufe

Assistant-Tool-Call-Blöcke, denen sowohl `input` als auch `arguments` fehlen, werden verworfen,
bevor der Modellkontext erstellt wird. Dies verhindert Anbieter-Ablehnungen durch teilweise
persistierte Tool-Aufrufe (zum Beispiel nach einem Rate-Limit-Fehler).

Implementierung:

- `sanitizeToolCallInputs` in `src/agents/session-transcript-repair.ts`
- Angewendet in `sanitizeSessionHistory` in `src/agents/pi-embedded-runner/google.ts`

---

## Anbieter-Matrix (aktuelles Verhalten)

**OpenAI / OpenAI Codex**

- Nur Bildbereinigung.
- Beim Modellwechsel zu OpenAI Responses/Codex werden verwaiste Reasoning-Signaturen verworfen (eigenständige Reasoning-Elemente ohne nachfolgenden Content-Block).
- Keine Bereinigung von Tool-Call-IDs.
- Keine Reparatur der Zuordnung von Tool-Ergebnissen.
- Keine Turn-Validierung oder -Neusortierung.
- Keine synthetischen Tool-Ergebnisse.
- Kein Entfernen von Thought-Signaturen.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Bereinigung von Tool-Call-IDs: strikt alphanumerisch.
- Reparatur der Zuordnung von Tool-Ergebnissen und synthetische Tool-Ergebnisse.
- Turn-Validierung (Gemini-typische Turn-Alternation).
- Google-Turn-Reihenfolge-Fixup (Voranstellen eines kleinen User-Bootstraps, wenn die Historie mit dem Assistant beginnt).
- Antigravity Claude: Normalisierung von Thinking-Signaturen; Entfernen nicht signierter Thinking-Blöcke.

**Anthropic / Minimax (Anthropic-kompatibel)**

- Reparatur der Zuordnung von Tool-Ergebnissen und synthetische Tool-Ergebnisse.
- Turn-Validierung (Zusammenführen aufeinanderfolgender User-Turns, um strikte Alternation zu erfüllen).

**Mistral (einschließlich modell-id-basierter Erkennung)**

- Bereinigung von Tool-Call-IDs: strict9 (alphanumerische Länge 9).

**OpenRouter Gemini**

- Bereinigung von Thought-Signaturen: Entfernen nicht-base64 `thought_signature`-Werte (Base64 beibehalten).

**Alles andere**

- Nur Bildbereinigung.

---

## Historisches Verhalten (vor 2026.1.22)

Vor dem Release 2026.1.22 wendete OpenClaw mehrere Ebenen der Transkript-Hygiene an:

- Eine **Transcript-Sanitize-Extension** lief bei jeder Kontexterstellung und konnte:
  - Die Zuordnung von Tool-Nutzung/Ergebnissen reparieren.
  - Tool-Call-IDs bereinigen (einschließlich eines nicht-strikten Modus, der `_`/`-` beibehielt).
- Der Runner führte außerdem anbieterspezifische Bereinigung durch, was Arbeit duplizierte.
- Zusätzliche Mutationen erfolgten außerhalb der Anbieter-Richtlinie, einschließlich:
  - Entfernen von `<final>`-Tags aus Assistant-Text vor der Persistierung.
  - Verwerfen leerer Assistant-Fehler-Turns.
  - Kürzen von Assistant-Inhalten nach Tool-Aufrufen.

Diese Komplexität verursachte providerübergreifende Regressionen (insbesondere bei der Zuordnung von `openai-responses`
`call_id|fc_id`). Die Bereinigung 2026.1.22 entfernte die Extension, zentralisierte die Logik
im Runner und machte OpenAI über die Bildbereinigung hinaus **no-touch**.
