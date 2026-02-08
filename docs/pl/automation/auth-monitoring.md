---
summary: "Monitorowanie wygaśnięcia OAuth dla dostawców modeli"
read_when:
  - Konfigurowanie monitorowania wygaśnięcia uwierzytelniania lub alertów
  - Automatyzowanie sprawdzania odświeżania OAuth w Claude Code / Codex
title: "Monitorowanie uwierzytelniania"
x-i18n:
  source_path: automation/auth-monitoring.md
  source_hash: eef179af9545ed7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:46Z
---

# Monitorowanie uwierzytelniania

OpenClaw udostępnia stan zdrowia wygaśnięcia OAuth poprzez `openclaw models status`. Użyj tego do
automatyzacji i alertów; skrypty są opcjonalnymi dodatkami do przepływów na telefonie.

## Preferowane: sprawdzenie CLI (przenośne)

```bash
openclaw models status --check
```

Kody wyjścia:

- `0`: OK
- `1`: wygasłe lub brakujące poświadczenia
- `2`: wkrótce wygasa (w ciągu 24 h)

Działa to w cron/systemd i nie wymaga żadnych dodatkowych skryptów.

## Skrypty opcjonalne (operacje / przepływy na telefonie)

Znajdują się w `scripts/` i są **opcjonalne**. Zakładają dostęp SSH do
hosta gateway (hosta bramy) i są dostrojone pod systemd + Termux.

- `scripts/claude-auth-status.sh` korzysta teraz z `openclaw models status --json` jako
  jedynego źródła prawdy (z przejściem awaryjnym do bezpośrednich odczytów plików, jeśli CLI jest niedostępne),
  więc utrzymuj `openclaw` na `PATH` dla timerów.
- `scripts/auth-monitor.sh`: cel timera cron/systemd; wysyła alerty (ntfy lub telefon).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: timer użytkownika systemd.
- `scripts/claude-auth-status.sh`: sprawdzanie uwierzytelniania Claude Code + OpenClaw (pełne/json/proste).
- `scripts/mobile-reauth.sh`: prowadzony proces ponownego uwierzytelniania przez SSH.
- `scripts/termux-quick-auth.sh`: widżet stanu jednym dotknięciem + otwarcie URL uwierzytelniania.
- `scripts/termux-auth-widget.sh`: pełny, prowadzony przepływ widżetu.
- `scripts/termux-sync-widget.sh`: synchronizacja poświadczeń Claude Code → OpenClaw.

Jeśli nie potrzebujesz automatyzacji na telefonie ani timerów systemd, pomiń te skrypty.
