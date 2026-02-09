---
summary: "Manifest wtyczki + wymagania schematu JSON (ścisła walidacja konfiguracji)"
read_when:
  - Tworzysz wtyczkę OpenClaw
  - Musisz dostarczyć schemat konfiguracji wtyczki lub debugować błędy walidacji wtyczek
title: "Manifest wtyczki"
---

# Manifest wtyczki (openclaw.plugin.json)

Każda wtyczka **musi** dostarczać plik `openclaw.plugin.json` w **katalogu głównym wtyczki**.
OpenClaw używa tego manifestu do walidacji konfiguracji **bez wykonywania kodu wtyczki**. Brakujący lub nieprawidłowy manifest jest traktowany jako błąd wtyczki i blokuje walidację konfiguracji.

Zobacz pełny przewodnik po systemie wtyczek: [Plugins](/tools/plugin).

## Wymagane pola

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Wymagane klucze:

- `id` (string): kanoniczny identyfikator wtyczki.
- `configSchema` (object): schemat JSON dla konfiguracji wtyczki (inline).

Klucze opcjonalne:

- `kind` (string): typ wtyczki (przykład: `"memory"`).
- `channels` (array): identyfikatory kanałów rejestrowane przez tę wtyczkę (przykład: `["matrix"]`).
- `providers` (array): identyfikatory dostawców rejestrowane przez tę wtyczkę.
- `skills` (array): katalogi Skills do załadowania (względem katalogu głównego wtyczki).
- `name` (string): nazwa wyświetlana wtyczki.
- `description` (string): krótki opis wtyczki.
- `uiHints` (object): etykiety pól konfiguracji / placeholdery / flagi wrażliwości do renderowania w UI.
- `version` (string): wersja wtyczki (informacyjnie).

## Wymagania schematu JSON

- **Każda wtyczka musi dostarczać schemat JSON**, nawet jeśli nie akceptuje żadnej konfiguracji.
- Pusty schemat jest akceptowalny (na przykład `{ "type": "object", "additionalProperties": false }`).
- Schematy są walidowane w czasie odczytu/zapisu konfiguracji, a nie w czasie wykonywania.

## Zachowanie walidacji

- Nieznane klucze `channels.*` są **błędami**, chyba że identyfikator kanału jest zadeklarowany przez manifest wtyczki.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` oraz `plugins.slots.*`
  muszą odwoływać się do **wykrywalnych** identyfikatorów wtyczek. Nieznane identyfikatory są **błędami**.
- Jeśli wtyczka jest zainstalowana, ale ma uszkodzony lub brakujący manifest albo schemat,
  walidacja kończy się niepowodzeniem, a Doctor zgłasza błąd wtyczki.
- Jeśli konfiguracja wtyczki istnieje, ale wtyczka jest **wyłączona**, konfiguracja jest zachowana, a **ostrzeżenie** jest prezentowane w Doctor oraz w logach.

## Uwagi

- Manifest jest **wymagany dla wszystkich wtyczek**, w tym ładowanych z lokalnego systemu plików.
- Runtime nadal ładuje moduł wtyczki oddzielnie; manifest służy wyłącznie do wykrywania i walidacji.
- Jeśli Twoja wtyczka zależy od modułów natywnych, udokumentuj kroki budowania oraz wszelkie wymagania listy dozwolonych menedżera pakietów (na przykład pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
