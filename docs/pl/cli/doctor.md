---
summary: "Referencja CLI dla `openclaw doctor` (kontrole stanu + prowadzone naprawy)"
read_when:
  - Masz problemy z łącznością lub uwierzytelnianiem i chcesz skorzystać z prowadzonego rozwiązywania problemów
  - Zaktualizowałeś system i chcesz wykonać kontrolę poprawności
title: "doctor"
---

# `openclaw doctor`

Kontrole stanu + szybkie poprawki dla gateway (bramy) i kanałów.

Powiązane:

- Rozwiązywanie problemów: [Troubleshooting](/gateway/troubleshooting)
- Audyt bezpieczeństwa: [Security](/gateway/security)

## Przykłady

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Uwagi:

- Interaktywne monity (np. poprawki pęku kluczy/OAuth) uruchamiają się tylko wtedy, gdy stdin jest TTY i `--non-interactive` **nie** jest ustawione. Uruchomienia bez interfejsu (cron, Telegram, brak terminala) pomijają monity.
- `--fix` (alias dla `--repair`) zapisuje kopię zapasową do `~/.openclaw/openclaw.json.bak` i usuwa nieznane klucze konfiguracji, wypisując każde usunięcie.

## macOS: nadpisania zmiennych środowiskowych `launchctl`

Jeśli wcześniej uruchamiałeś `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (lub `...PASSWORD`), ta wartość nadpisuje plik konfiguracji i może powodować uporczywe błędy „unauthorized”.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
