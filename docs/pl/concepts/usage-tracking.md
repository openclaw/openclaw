---
summary: "Powierzchnie śledzenia użycia oraz wymagania dotyczące poświadczeń"
read_when:
  - Podczas podłączania powierzchni użycia/limitów dostawców
  - Gdy trzeba wyjaśnić zachowanie śledzenia użycia lub wymagania uwierzytelniania
title: "Śledzenie użycia"
x-i18n:
  source_path: concepts/usage-tracking.md
  source_hash: 6f6ed2a70329b2a6
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:05Z
---

# Śledzenie użycia

## Czym to jest

- Pobiera użycie/limity dostawcy bezpośrednio z ich punktów końcowych użycia.
- Brak szacowanych kosztów; wyłącznie okna raportowane przez dostawcę.

## Gdzie się pojawia

- `/status` w czatach: karta stanu bogata w emoji z tokenami sesji + szacowany koszt (tylko klucz API). Użycie dostawcy jest wyświetlane dla **bieżącego dostawcy modelu**, gdy jest dostępne.
- `/usage off|tokens|full` w czatach: stopka użycia dla każdej odpowiedzi (OAuth pokazuje tylko tokeny).
- `/usage cost` w czatach: lokalne podsumowanie kosztów agregowane z dzienników sesji OpenClaw.
- CLI: `openclaw status --usage` drukuje pełne zestawienie na dostawcę.
- CLI: `openclaw channels list` drukuje ten sam migawkowy widok użycia obok konfiguracji dostawcy (użyj `--no-usage`, aby pominąć).
- Pasek menu macOS: sekcja „Usage” w obszarze Kontekst (tylko jeśli dostępna).

## Dostawcy + poświadczenia

- **Anthropic (Claude)**: tokeny OAuth w profilach uwierzytelniania.
- **GitHub Copilot**: tokeny OAuth w profilach uwierzytelniania.
- **Gemini CLI**: tokeny OAuth w profilach uwierzytelniania.
- **Antigravity**: tokeny OAuth w profilach uwierzytelniania.
- **OpenAI Codex**: tokeny OAuth w profilach uwierzytelniania (gdy obecne, używane jest accountId).
- **MiniMax**: klucz API (klucz planu coding; `MINIMAX_CODE_PLAN_KEY` lub `MINIMAX_API_KEY`); używa 5‑godzinnego okna planu coding.
- **z.ai**: klucz API przez env/konfigurację/magazyn uwierzytelniania.

Użycie jest ukryte, jeśli nie istnieją pasujące poświadczenia OAuth/API.
