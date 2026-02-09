---
summary: "CLI-referens för `openclaw doctor` (hälsokontroller + guidade reparationer)"
read_when:
  - Du har anslutnings-/autentiseringsproblem och vill ha guidade lösningar
  - Du har uppdaterat och vill göra en rimlighetskontroll
title: "doctor"
---

# `openclaw doctor`

Hälsokontroller + snabba åtgärder för gateway (nätverksgateway) och kanaler.

Relaterat:

- Felsökning: [Felsökning](/gateway/troubleshooting)
- Säkerhetsgranskning: [Säkerhet](/gateway/security)

## Exempel

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Noteringar:

- Interaktiva uppmaningar (som keychain/OAuth fixar) körs bara när stdin är en TTY och `--non-interactive` är **inte** satt. Huvudlösa körningar (cron, Telegram, ingen terminal) kommer att hoppa över uppmaningar.
- `--fix` (alias för `--repair`) skriver en säkerhetskopia till `~/.openclaw/openclaw.json.bak` och tar bort okända konfig-nycklar, med listning av varje borttagning.

## macOS: `launchctl` miljövariabel-överskrivningar

Om du tidigare körde `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (eller `...PASSWORD`) åsidosätter det värdet din konfigfil och kan orsaka återkommande ”unauthorized”-fel.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
