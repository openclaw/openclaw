---
summary: "„Manuelle Logins für Browser-Automatisierung + Posten auf X/Twitter“"
read_when:
  - Sie müssen sich für Browser-Automatisierung bei Websites anmelden
  - Sie möchten Updates auf X/Twitter posten
title: "„Browser-Login“"
---

# Browser-Login + X/Twitter-Posting

## Manueller Login (empfohlen)

Wenn eine Website eine Anmeldung erfordert, **melden Sie sich manuell** im **Host**-Browserprofil an (dem OpenClaw-Browser).

Geben Sie dem Modell **keine** Zugangsdaten. Automatisierte Logins lösen häufig Anti-Bot-Abwehrmechanismen aus und können das Konto sperren.

Zurück zur Hauptdokumentation des Browsers: [Browser](/tools/browser).

## Welches Chrome-Profil wird verwendet?

OpenClaw steuert ein **dediziertes Chrome-Profil** (mit dem Namen `openclaw`, orangefarbene Benutzeroberfläche). Dieses ist von Ihrem täglichen Browserprofil getrennt.

Zwei einfache Möglichkeiten, darauf zuzugreifen:

1. **Bitten Sie den Agenten, den Browser zu öffnen**, und melden Sie sich anschließend selbst an.
2. **Öffnen Sie ihn über die CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

Wenn Sie mehrere Profile haben, übergeben Sie `--browser-profile <name>` (der Standard ist `openclaw`).

## X/Twitter: empfohlener Ablauf

- **Lesen/Suchen/Threads:** Verwenden Sie den **Host**-Browser (manueller Login).
- **Updates posten:** Verwenden Sie den **Host**-Browser (manueller Login).

## Sandboxing + Zugriff auf den Host-Browser

Sandboxed Browser-Sitzungen lösen **mit höherer Wahrscheinlichkeit** Bot-Erkennung aus. Für X/Twitter (und andere restriktive Websites) bevorzugen Sie den **Host**-Browser.

Wenn der Agent sandboxed ist, verwendet das Browser-Werkzeug standardmäßig die Sandbox. Um die Steuerung des Hosts zu erlauben:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Richten Sie anschließend den Host-Browser aus:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Oder deaktivieren Sie Sandboxing für den Agenten, der Updates postet.
