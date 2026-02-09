---
summary: "Jak przychodzące audio/notatki głosowe są pobierane, transkrybowane i wstrzykiwane do odpowiedzi"
read_when:
  - Zmiana transkrypcji audio lub obsługi multimediów
title: "Audio i notatki głosowe"
---

# Audio / Voice Notes — 2026-01-17

## Co działa

- **Rozumienie mediów (audio)**: Jeśli rozumienie audio jest włączone (lub wykryte automatycznie), OpenClaw:
  1. Lokalizuje pierwsze załączone audio (ścieżka lokalna lub URL) i w razie potrzeby pobiera je.
  2. Wymusza `maxBytes` przed wysłaniem do każdego wpisu modelu.
  3. Uruchamia pierwszy kwalifikujący się wpis modelu w kolejności (dostawca lub CLI).
  4. Jeśli się nie powiedzie lub zostanie pominięty (rozmiar/timeout), próbuje następnego wpisu.
  5. Po sukcesie zastępuje `Body` blokiem `[Audio]` i ustawia `{{Transcript}}`.
- **Parsowanie poleceń**: Gdy transkrypcja się powiedzie, `CommandBody`/`RawBody` są ustawiane na transkrypt, dzięki czemu polecenia slash nadal działają.
- **Szczegółowe logowanie**: W `--verbose` logujemy moment uruchomienia transkrypcji oraz zastąpienia treści.

## Automatyczne wykrywanie (domyślne)

Jeśli **nie skonfigurujesz modeli** i `tools.media.audio.enabled` **nie** jest ustawione na `false`,
OpenClaw wykrywa automatycznie w tej kolejności i zatrzymuje się na pierwszej działającej opcji:

1. **Lokalne CLI** (jeśli zainstalowane)
   - `sherpa-onnx-offline` (wymaga `SHERPA_ONNX_MODEL_DIR` z encoder/decoder/joiner/tokens)
   - `whisper-cli` (z `whisper-cpp`; używa `WHISPER_CPP_MODEL` lub dołączonego modelu tiny)
   - `whisper` (CLI w Pythonie; automatycznie pobiera modele)
2. **Gemini CLI** (`gemini`) używając `read_many_files`
3. **Klucze dostawców** (OpenAI → Groq → Deepgram → Google)

Aby wyłączyć automatyczne wykrywanie, ustaw `tools.media.audio.enabled: false`.
Aby dostosować, ustaw `tools.media.audio.models`.
Uwaga: Wykrywanie binariów jest „best‑effort” na macOS/Linux/Windows; upewnij się, że CLI jest w `PATH` (rozwijamy `~`), lub ustaw jawny model CLI z pełną ścieżką polecenia.

## Przykłady konfiguracji

### Dostawca + zapasowe CLI (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### Tylko dostawca z bramkowaniem zakresu

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### Tylko dostawca (Deepgram)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Uwagi i limity

- Uwierzytelnianie dostawców podąża za standardową kolejnością uwierzytelniania modeli (profile uwierzytelniania, zmienne środowiskowe, `models.providers.*.apiKey`).
- Deepgram przejmuje `DEEPGRAM_API_KEY`, gdy używany jest `provider: "deepgram"`.
- Szczegóły konfiguracji Deepgram: [Deepgram (transkrypcja audio)](/providers/deepgram).
- Dostawcy audio mogą nadpisywać `baseUrl`, `headers` i `providerOptions` poprzez `tools.media.audio`.
- Domyślny limit rozmiaru to 20 MB (`tools.media.audio.maxBytes`). Zbyt duże audio jest pomijane dla danego modelu i próbowany jest następny wpis.
- Domyślne `maxChars` dla audio jest **nieustawione** (pełny transkrypt). Ustaw `tools.media.audio.maxChars` lub per‑wpis `maxChars`, aby przyciąć wynik.
- Domyślne ustawienie OpenAI to `gpt-4o-mini-transcribe`; ustaw `model: "gpt-4o-transcribe"` dla wyższej dokładności.
- Użyj `tools.media.audio.attachments` do przetwarzania wielu notatek głosowych (`mode: "all"` + `maxAttachments`).
- Transkrypt jest dostępny dla szablonów jako `{{Transcript}}`.
- Stdout CLI jest limitowany (5 MB); utrzymuj zwięzłość wyjścia CLI.

## Gotchas

- Zasady zakresu działają na zasadzie „pierwsze dopasowanie wygrywa”. `chatType` jest normalizowane do `direct`, `group` lub `room`.
- Upewnij się, że Twoje CLI kończy działanie kodem 0 i wypisuje zwykły tekst; JSON wymaga obróbki przez `jq -r .text`.
- Utrzymuj rozsądne timeouty (`timeoutSeconds`, domyślnie 60 s), aby nie blokować kolejki odpowiedzi.
