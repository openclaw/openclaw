---
summary: "„Zaloguj się do GitHub Copilot z OpenClaw, korzystając z przepływu urządzenia”"
read_when:
  - Chcesz używać GitHub Copilot jako dostawcy modeli
  - Potrzebujesz przepływu `openclaw models auth login-github-copilot`
title: "GitHub Copilot"
---

# GitHub Copilot

## Czym jest GitHub Copilot?

GitHub Copilot to asystent programowania oparty na AI od GitHub. Zapewnia dostęp do
modeli Copilot dla Twojego konta i planu GitHub. OpenClaw może używać Copilot jako
dostawcy modeli na dwa różne sposoby.

## Dwa sposoby użycia Copilot w OpenClaw

### 1. Wbudowany dostawca GitHub Copilot (`github-copilot`)

Użyj natywnego przepływu logowania urządzenia, aby uzyskać token GitHub, a następnie
wymień go na tokeny API Copilot podczas działania OpenClaw. Jest to **domyślna**
i najprostsza ścieżka, ponieważ nie wymaga VS Code.

### 2. Wtyczka Copilot Proxy (`copilot-proxy`)

Użyj rozszerzenia VS Code **Copilot Proxy** jako lokalnego mostu. OpenClaw komunikuje się
z punktem końcowym `/v1` proxy i używa listy modeli skonfigurowanej w tym miejscu. Wybierz tę opcję, jeśli już korzystasz z Copilot Proxy w VS Code lub musisz przez niego
routować ruch.
Musisz włączyć wtyczkę i utrzymywać uruchomione rozszerzenie VS Code.

Użyj GitHub Copilot jako dostawcy modeli (`github-copilot`). Polecenie logowania uruchamia
przepływ urządzenia GitHub, zapisuje profil uwierzytelniania i aktualizuje konfigurację,
aby korzystać z tego profilu.

## Konfiguracja CLI

```bash
openclaw models auth login-github-copilot
```

Zostaniesz poproszony o odwiedzenie adresu URL i wprowadzenie jednorazowego kodu. Pozostaw terminal otwarty do momentu zakończenia procesu.

### Opcjonalne flagi

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## Ustawienie domyślnego modelu

```bash
openclaw models set github-copilot/gpt-4o
```

### Fragment konfiguracji

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## Uwagi

- Wymaga interaktywnego TTY; uruchamiaj bezpośrednio w terminalu.
- Dostępność modeli Copilot zależy od Twojego planu; jeśli model zostanie odrzucony,
  spróbuj innego identyfikatora (na przykład `github-copilot/gpt-4.1`).
- Logowanie zapisuje token GitHub w magazynie profili uwierzytelniania i wymienia go
  na token API Copilot podczas działania OpenClaw.
