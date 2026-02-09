---
summary: "Wie OpenClaw Auth‑Profile rotiert und zwischen Modellen zurückfällt"
read_when:
  - Diagnose der Rotation von Auth‑Profilen, Cooldowns oder des Modell‑Fallback‑Verhaltens
  - Aktualisierung von Failover‑Regeln für Auth‑Profile oder Modelle
title: "Modell‑Failover"
---

# Modell‑Failover

OpenClaw behandelt Ausfälle in zwei Stufen:

1. **Rotation von Auth‑Profilen** innerhalb des aktuellen Anbieters.
2. **Modell‑Fallback** zum nächsten Modell in `agents.defaults.model.fallbacks`.

Dieses Dokument erläutert die Laufzeitregeln und die zugrunde liegenden Daten.

## Auth‑Speicher (Schlüssel + OAuth)

OpenClaw verwendet **Auth‑Profile** sowohl für API‑Schlüssel als auch für OAuth‑Tokens.

- Geheimnisse liegen in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (Legacy: `~/.openclaw/agent/auth-profiles.json`).
- Konfiguration `auth.profiles` / `auth.order` ist **nur Metadaten + Routing** (keine Geheimnisse).
- Legacy‑OAuth‑Datei nur für den Import: `~/.openclaw/credentials/oauth.json` (beim ersten Gebrauch in `auth-profiles.json` importiert).

Mehr Details: [/concepts/oauth](/concepts/oauth)

Anmeldedatentypen:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` für einige Anbieter)

## Profil‑IDs

OAuth‑Anmeldungen erstellen unterschiedliche Profile, sodass mehrere Konten koexistieren können.

- Standard: `provider:default`, wenn keine E‑Mail verfügbar ist.
- OAuth mit E‑Mail: `provider:<email>` (zum Beispiel `google-antigravity:user@gmail.com`).

Profile liegen in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` unter `profiles`.

## Rotationsreihenfolge

Wenn ein Anbieter mehrere Profile hat, wählt OpenClaw die Reihenfolge wie folgt:

1. **Explizite Konfiguration**: `auth.order[provider]` (falls gesetzt).
2. **Konfigurierte Profile**: `auth.profiles`, nach Anbieter gefiltert.
3. **Gespeicherte Profile**: Einträge in `auth-profiles.json` für den Anbieter.

Wenn keine explizite Reihenfolge konfiguriert ist, verwendet OpenClaw eine Round‑Robin‑Reihenfolge:

- **Primärschlüssel:** Profiltyp (**OAuth vor API‑Schlüsseln**).
- **Sekundärschlüssel:** `usageStats.lastUsed` (älteste zuerst, innerhalb jedes Typs).
- **Profile in Cooldown/deaktiviert** werden ans Ende verschoben, sortiert nach dem frühesten Ablauf.

### Sitzungs‑Stickiness (cache‑freundlich)

OpenClaw **pinnt das gewählte Auth‑Profil pro Sitzung**, um Provider‑Caches warm zu halten.
Es rotiert **nicht** bei jeder Anfrage. Das gepinnte Profil wird wiederverwendet, bis:

- die Sitzung zurückgesetzt wird (`/new` / `/reset`)
- eine Kompaktierung abgeschlossen ist (Kompaktierungszähler erhöht sich)
- das Profil im Cooldown ist oder deaktiviert wurde

Die manuelle Auswahl über `/model …@<profileId>` setzt eine **Benutzerüberschreibung** für diese Sitzung
und wird nicht automatisch rotiert, bis eine neue Sitzung beginnt.

Automatisch gepinnte Profile (vom Sitzungs‑Router ausgewählt) gelten als **Präferenz**:
Sie werden zuerst versucht, aber OpenClaw kann bei Ratenlimits/Timeouts zu einem anderen Profil rotieren.
Benutzer‑gepinnte Profile bleiben auf dieses Profil gesperrt; wenn es fehlschlägt und Modell‑Fallbacks
konfiguriert sind, wechselt OpenClaw zum nächsten Modell statt die Profile zu wechseln.

### Warum OAuth „verloren wirken“ kann

Wenn Sie sowohl ein OAuth‑Profil als auch ein API‑Schlüssel‑Profil für denselben Anbieter haben, kann Round‑Robin zwischen ihnen über Nachrichten hinweg wechseln, sofern sie nicht gepinnt sind. Um ein einzelnes Profil zu erzwingen:

- Pinnen mit `auth.order[provider] = ["provider:profileId"]`, oder
- Verwenden Sie eine sitzungsbezogene Überschreibung über `/model …` mit einer Profil‑Überschreibung (sofern von Ihrer UI/Chat‑Oberfläche unterstützt).

## Cooldowns

Wenn ein Profil aufgrund von Auth‑/Ratenlimit‑Fehlern (oder eines Timeouts, das wie Ratenlimitierung aussieht) fehlschlägt, markiert OpenClaw es mit einem Cooldown und wechselt zum nächsten Profil.
Format‑/Invalid‑Request‑Fehler (zum Beispiel Validierungsfehler der Tool‑Call‑ID von Cloud Code Assist) gelten als failover‑würdig und verwenden dieselben Cooldowns.

Cooldowns verwenden exponentielles Backoff:

- 1 Minute
- 5 Minuten
- 25 Minuten
- 1 Stunde (Obergrenze)

Der Zustand wird in `auth-profiles.json` unter `usageStats` gespeichert:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Abrechnungsbedingte Deaktivierungen

Abrechnungs‑/Guthabenfehler (zum Beispiel „insufficient credits“ / „credit balance too low“) gelten als failover‑würdig, sind aber meist nicht transient. Statt eines kurzen Cooldowns markiert OpenClaw das Profil als **deaktiviert** (mit längerem Backoff) und rotiert zum nächsten Profil/Anbieter.

Der Zustand wird in `auth-profiles.json` gespeichert:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Standards:

- Das Abrechnungs‑Backoff beginnt bei **5 Stunden**, verdoppelt sich pro Abrechnungsfehler und ist bei **24 Stunden** gedeckelt.
- Backoff‑Zähler werden zurückgesetzt, wenn das Profil **24 Stunden** lang nicht fehlgeschlagen ist (konfigurierbar).

## Modell‑Fallback

Wenn alle Profile für einen Anbieter fehlschlagen, wechselt OpenClaw zum nächsten Modell in
`agents.defaults.model.fallbacks`. Dies gilt für Auth‑Fehler, Ratenlimits und
Timeouts, die die Profilrotation ausgeschöpft haben (andere Fehler führen nicht zu einem Fallback‑Fortschritt).

Wenn ein Lauf mit einer Modell‑Überschreibung (Hooks oder CLI) startet, enden Fallbacks dennoch bei
`agents.defaults.model.primary`, nachdem alle konfigurierten Fallbacks versucht wurden.

## Verwandte Konfiguration

Siehe [Gateway‑Konfiguration](/gateway/configuration) für:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel`‑Routing

Siehe [Modelle](/concepts/models) für den umfassenderen Überblick zur Modellauswahl und zu Fallbacks.
