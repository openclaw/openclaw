---
summary: "Rytuał inicjalnego uruchomienia agenta, który zasiewa obszar roboczy oraz pliki tożsamości"
read_when:
  - Zrozumienie, co dzieje się przy pierwszym uruchomieniu agenta
  - Wyjaśnienie, gdzie znajdują się pliki inicjalizacji
  - Debugowanie konfiguracji tożsamości podczas onboardingu
title: "Inicjalizacja agenta"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:37Z
---

# Inicjalizacja agenta

Inicjalizacja to rytuał **pierwszego uruchomienia**, który przygotowuje obszar roboczy agenta i
zbiera szczegóły tożsamości. Zachodzi po onboardingu, gdy agent uruchamia się po raz pierwszy.

## Co robi inicjalizacja

Przy pierwszym uruchomieniu agenta OpenClaw inicjalizuje obszar roboczy (domyślnie
`~/.openclaw/workspace`):

- Zasiewa `AGENTS.md`, `BOOTSTRAP.md`, `IDENTITY.md`, `USER.md`.
- Uruchamia krótki rytuał pytań i odpowiedzi (jedno pytanie na raz).
- Zapisuje tożsamość i preferencje do `IDENTITY.md`, `USER.md`, `SOUL.md`.
- Po zakończeniu usuwa `BOOTSTRAP.md`, aby proces uruchomił się tylko raz.

## Gdzie jest uruchamiana

Inicjalizacja zawsze działa na **hoście gateway (hoście bramy)**. Jeśli aplikacja na macOS łączy się
ze zdalnym Gateway, obszar roboczy oraz pliki inicjalizacji znajdują się na tej zdalnej
maszynie.

<Note>
Gdy Gateway działa na innej maszynie, edytuj pliki obszaru roboczego na hoście gateway
(na przykład `user@gateway-host:~/.openclaw/workspace`).
</Note>

## Powiązana dokumentacja

- Onboarding aplikacji na macOS: [Onboarding](/start/onboarding)
- Układ obszaru roboczego: [Agent workspace](/concepts/agent-workspace)
