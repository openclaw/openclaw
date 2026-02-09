---
summary: "„Anthropic Claude über API-Schlüssel oder Setup-Token in OpenClaw verwenden“"
read_when:
  - Sie möchten Anthropic-Modelle in OpenClaw verwenden
  - Sie möchten ein Setup-Token anstelle von API-Schlüsseln verwenden
title: "„Anthropic“"
---

# Anthropic (Claude)

Anthropic entwickelt die **Claude**-Modellfamilie und stellt den Zugriff über eine API bereit.
In OpenClaw können Sie sich mit einem API-Schlüssel oder einem **Setup-Token** authentifizieren.

## Option A: Anthropic API-Schlüssel

**Am besten geeignet für:** Standard-API-Zugriff und nutzungsbasierte Abrechnung.
Erstellen Sie Ihren API-Schlüssel in der Anthropic Console.

### CLI-Einrichtung

```bash
openclaw onboard
# choose: Anthropic API key

# or non-interactive
openclaw onboard --anthropic-api-key "$ANTHROPIC_API_KEY"
```

### Konfigurationsausschnitt

```json5
{
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Prompt-Caching (Anthropic API)

OpenClaw unterstützt die Prompt-Caching-Funktion von Anthropic. Dies ist **nur für die API** verfügbar; eine Abonnement-Authentifizierung berücksichtigt Cache-Einstellungen nicht.

### Konfiguration

Verwenden Sie den Parameter `cacheRetention` in Ihrer Modellkonfiguration:

| Wert    | Cache-Dauer  | Beschreibung                                               |
| ------- | ------------ | ---------------------------------------------------------- |
| `none`  | Kein Caching | Prompt-Caching deaktivieren                                |
| `short` | 5 Minuten    | Standard für API-Schlüssel-Auth                            |
| `long`  | 1 Stunde     | Erweiterter Cache (erfordert Beta-Flag) |

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": {
          params: { cacheRetention: "long" },
        },
      },
    },
  },
}
```

### Standardwerte

Bei Verwendung der Anthropic-API-Schlüssel-Authentifizierung wendet OpenClaw automatisch `cacheRetention: "short"` (5-Minuten-Cache) für alle Anthropic-Modelle an. Sie können dies überschreiben, indem Sie `cacheRetention` explizit in Ihrer Konfiguration setzen.

### Legacy-Parameter

Der ältere Parameter `cacheControlTtl` wird aus Gründen der Abwärtskompatibilität weiterhin unterstützt:

- `"5m"` entspricht `short`
- `"1h"` entspricht `long`

Wir empfehlen die Migration auf den neuen Parameter `cacheRetention`.

OpenClaw enthält das `extended-cache-ttl-2025-04-11`-Beta-Flag für Anthropic-API-Anfragen; behalten Sie es bei, wenn Sie Provider-Header überschreiben (siehe [/gateway/configuration](/gateway/configuration)).

## Option B: Claude Setup-Token

**Am besten geeignet für:** die Nutzung Ihres Claude-Abonnements.

### Wo Sie ein Setup-Token erhalten

Setup-Tokens werden von der **Claude Code CLI** erstellt, nicht von der Anthropic Console. Sie können dies auf **jedem Rechner** ausführen:

```bash
claude setup-token
```

Fügen Sie das Token in OpenClaw ein (Assistent: **Anthropic token (setup-token einfügen)**), oder führen Sie es auf dem Gateway-Host aus:

```bash
openclaw models auth setup-token --provider anthropic
```

Wenn Sie das Token auf einem anderen Rechner generiert haben, fügen Sie es ein:

```bash
openclaw models auth paste-token --provider anthropic
```

### CLI-Einrichtung (Setup-Token)

```bash
# Paste a setup-token during onboarding
openclaw onboard --auth-choice setup-token
```

### Konfigurationsausschnitt (Setup-Token)

```json5
{
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
}
```

## Hinweise

- Erstellen Sie das Setup-Token mit `claude setup-token` und fügen Sie es ein, oder führen Sie `openclaw models auth setup-token` auf dem Gateway-Host aus.
- Wenn bei einem Claude-Abonnement „OAuth token refresh failed …“ angezeigt wird, authentifizieren Sie sich erneut mit einem Setup-Token. Siehe [/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription](/gateway/troubleshooting#oauth-token-refresh-failed-anthropic-claude-subscription).
- Authentifizierungsdetails und Wiederverwendungsregeln finden Sie unter [/concepts/oauth](/concepts/oauth).

## Fehlerbehebung

**401-Fehler / Token plötzlich ungültig**

- Die Authentifizierung für das Claude-Abonnement kann ablaufen oder widerrufen werden. Führen Sie `claude setup-token` erneut aus
  und fügen Sie es auf dem **Gateway-Host** ein.
- Wenn die Claude-CLI-Anmeldung auf einem anderen Rechner erfolgt ist, verwenden Sie
  `openclaw models auth paste-token --provider anthropic` auf dem Gateway-Host.

**Kein API-Schlüssel für Anbieter „anthropic“ gefunden**

- Die Authentifizierung erfolgt **pro Agent**. Neue Agenten übernehmen die Schlüssel des Hauptagenten nicht.
- Führen Sie das Onboarding für diesen Agenten erneut aus oder fügen Sie ein Setup-Token / einen API-Schlüssel auf dem
  Gateway-Host ein und prüfen Sie anschließend mit `openclaw models status`.

**Keine Anmeldedaten für Profil `anthropic:default` gefunden**

- Führen Sie `openclaw models status` aus, um zu sehen, welches Authentifizierungsprofil aktiv ist.
- Führen Sie das Onboarding erneut aus oder fügen Sie ein Setup-Token / einen API-Schlüssel für dieses Profil ein.

**Kein verfügbares Authentifizierungsprofil (alle in Cooldown/nicht verfügbar)**

- Prüfen Sie `openclaw models status --json` auf `auth.unusableProfiles`.
- Fügen Sie ein weiteres Anthropic-Profil hinzu oder warten Sie den Cooldown ab.

Mehr: [/gateway/troubleshooting](/gateway/troubleshooting) und [/help/faq](/help/faq).
