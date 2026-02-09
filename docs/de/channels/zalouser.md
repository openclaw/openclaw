---
summary: "Unterstützung für persönliche Zalo-Konten über zca-cli (QR-Login), Funktionen und Konfiguration"
read_when:
  - Einrichten von Zalo Personal für OpenClaw
  - Debugging von Zalo-Personal-Login oder Nachrichtenfluss
title: "Zalo Personal"
---

# Zalo Personal (inoffiziell)

Status: experimentell. Diese Integration automatisiert ein **persönliches Zalo-Konto** über `zca-cli`.

> **Warnung:** Dies ist eine inoffizielle Integration und kann zu einer Sperrung oder einem Bann des Kontos führen. Nutzung auf eigenes Risiko.

## Erforderliches Plugin

Zalo Personal wird als Plugin bereitgestellt und ist nicht im Kerninstallationspaket enthalten.

- Installation über die CLI: `openclaw plugins install @openclaw/zalouser`
- Oder aus einem Source-Checkout: `openclaw plugins install ./extensions/zalouser`
- Details: [Plugins](/tools/plugin)

## Voraussetzung: zca-cli

Auf der Gateway-Maschine muss die Binärdatei `zca` unter `PATH` verfügbar sein.

- Prüfen: `zca --version`
- Falls nicht vorhanden, installieren Sie zca-cli (siehe `extensions/zalouser/README.md` oder die Upstream-zca-cli-Dokumentation).

## Schnellstart (Einsteiger)

1. Installieren Sie das Plugin (siehe oben).
2. Login (QR, auf der Gateway-Maschine):
   - `openclaw channels login --channel zalouser`
   - Scannen Sie den QR-Code im Terminal mit der Zalo-Mobil-App.
3. Aktivieren Sie den Kanal:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Starten Sie das Gateway neu (oder schließen Sie das Onboarding ab).
5. Der DM-Zugriff ist standardmäßig auf Pairing gesetzt; bestätigen Sie beim ersten Kontakt den Pairing-Code.

## Was es ist

- Verwendet `zca listen`, um eingehende Nachrichten zu empfangen.
- Verwendet `zca msg ...`, um Antworten zu senden (Text/Medien/Links).
- Entwickelt für Anwendungsfälle mit „persönlichen Konten“, bei denen die Zalo Bot API nicht verfügbar ist.

## Benennung

Die Channel-ID ist `zalouser`, um explizit zu machen, dass hier ein **persönliches Zalo-Benutzerkonto** (inoffiziell) automatisiert wird. `zalo` bleibt für eine mögliche zukünftige offizielle Zalo-API-Integration reserviert.

## IDs finden (Verzeichnis)

Verwenden Sie die Verzeichnis-CLI, um Peers/Gruppen und deren IDs zu ermitteln:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Einschränkungen

- Ausgehender Text wird in Blöcke von ca. 2000 Zeichen aufgeteilt (Beschränkungen des Zalo-Clients).
- Streaming ist standardmäßig blockiert.

## Zugriffskontrolle (DMs)

`channels.zalouser.dmPolicy` unterstützt: `pairing | allowlist | open | disabled` (Standard: `pairing`).
`channels.zalouser.allowFrom` akzeptiert Benutzer-IDs oder Namen. Der Assistent löst Namen, wenn verfügbar, über `zca friend find` zu IDs auf.

Freigabe über:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Gruppenzugriff (optional)

- Standard: `channels.zalouser.groupPolicy = "open"` (Gruppen erlaubt). Verwenden Sie `channels.defaults.groupPolicy`, um den Standard zu überschreiben, wenn nicht gesetzt.
- Beschränken Sie auf eine Allowlist mit:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (Schlüssel sind Gruppen-IDs oder -Namen)
- Alle Gruppen blockieren: `channels.zalouser.groupPolicy = "disabled"`.
- Der Konfigurationsassistent kann nach Gruppen-Allowlists fragen.
- Beim Start löst OpenClaw Gruppen-/Benutzernamen in Allowlists zu IDs auf und protokolliert die Zuordnung; nicht auflösbare Einträge bleiben unverändert erhalten.

Beispiel:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Mehrere Konten

Konten werden auf zca-Profile abgebildet. Beispiel:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Fehlerbehebung

**`zca` nicht gefunden:**

- Installieren Sie zca-cli und stellen Sie sicher, dass es für den Gateway-Prozess unter `PATH` verfügbar ist.

**Login bleibt nicht bestehen:**

- `openclaw channels status --probe`
- Erneut anmelden: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
