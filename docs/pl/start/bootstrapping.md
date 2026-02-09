---
summary: "Rytuał inicjalnego uruchomienia agenta, który zasiewa obszar roboczy oraz pliki tożsamości"
read_when:
  - Zrozumienie, co dzieje się przy pierwszym uruchomieniu agenta
  - Wyjaśnianie gdzie są pliki bootstrapping na żywo
  - Debugowanie konfiguracji tożsamości podczas onboardingu
title: "Inicjalizacja agenta"
sidebarTitle: "Bootstrapping"
---

# Inicjalizacja agenta

Inicjalizacja to rytuał **pierwszego uruchomienia**, który przygotowuje obszar roboczy agenta i
zbiera szczegóły tożsamości. Zachodzi po onboardingu, gdy agent uruchamia się po raz pierwszy.

## Co robi bootstrapping

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
