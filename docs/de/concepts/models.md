---
summary: "„Models-CLI: auflisten, setzen, Aliasse, Fallbacks, scannen, Status“"
read_when:
  - Hinzufügen oder Ändern der Models-CLI (models list/set/scan/aliases/fallbacks)
  - Ändern des Verhaltens von Modell-Fallbacks oder der Auswahl-UX
  - Aktualisieren der Model-Scan-Probes (Tools/Bilder)
title: "„Models-CLI“"
---

# Models-CLI

Siehe [/concepts/model-failover](/concepts/model-failover) für die Rotation von Auth-Profilen,
Cooldowns und wie dies mit Fallbacks interagiert.
Kurzer Anbieter-Überblick + Beispiele: [/concepts/model-providers](/concepts/model-providers).

## Wie die Modellauswahl funktioniert

OpenClaw wählt Modelle in dieser Reihenfolge aus:

1. **Primäres** Modell (`agents.defaults.model.primary` oder `agents.defaults.model`).
2. **Fallbacks** in `agents.defaults.model.fallbacks` (in Reihenfolge).
3. **Anbieter‑Auth‑Failover** findet innerhalb eines Anbieters statt, bevor zum
   nächsten Modell gewechselt wird.

Verwandt:

- `agents.defaults.models` ist die Allowlist/der Katalog der Modelle, die OpenClaw verwenden darf (inklusive Aliasse).
- `agents.defaults.imageModel` wird **nur dann** verwendet, wenn das primäre Modell keine Bilder akzeptieren kann.
- Agent‑spezifische Standardwerte können `agents.defaults.model` über `agents.list[].model` plus Bindings überschreiben (siehe [/concepts/multi-agent](/concepts/multi-agent)).

## Schnelle Modellwahl (anekdotisch)

- **GLM**: etwas besser für Coding/Werkzeugaufrufe.
- **MiniMax**: besser fürs Schreiben und „Vibes“.

## Setup‑Assistent (empfohlen)

Wenn Sie die Konfiguration nicht manuell bearbeiten möchten, starten Sie den Onboarding‑Assistenten:

```bash
openclaw onboard
```

Er kann Modell + Auth für gängige Anbieter einrichten, einschließlich **OpenAI Code (Codex)
Subscription** (OAuth) und **Anthropic** (API‑Schlüssel empfohlen; `claude
setup-token` wird ebenfalls unterstützt).

## Konfigurationsschlüssel (Überblick)

- `agents.defaults.model.primary` und `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` und `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (Allowlist + Aliasse + Anbieter‑Parameter)
- `models.providers` (benutzerdefinierte Anbieter, geschrieben in `models.json`)

Model‑Refs werden auf Kleinbuchstaben normalisiert. Anbieter‑Aliasse wie `z.ai/*` normalisieren
zu `zai/*`.

Beispiele für Anbieter‑Konfigurationen (einschließlich OpenCode Zen) finden Sie unter
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## „Model is not allowed“ (und warum Antworten stoppen)

Wenn `agents.defaults.models` gesetzt ist, wird es zur **Allowlist** für `/model` und für
Sitzungs‑Overrides. Wählt ein Benutzer ein Modell, das nicht in dieser Allowlist ist,
gibt OpenClaw zurück:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Dies passiert **bevor** eine normale Antwort erzeugt wird, daher kann es sich so anfühlen,
als hätte es „nicht geantwortet“. Die Lösung ist entweder:

- Das Modell zu `agents.defaults.models` hinzufügen, oder
- Die Allowlist leeren ( `agents.defaults.models` entfernen), oder
- Ein Modell aus `/model list` auswählen.

Beispiel‑Allowlist‑Konfiguration:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Modelle im Chat wechseln (`/model`)

Sie können Modelle für die aktuelle Sitzung wechseln, ohne neu zu starten:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Hinweise:

- `/model` (und `/model list`) ist eine kompakte, nummerierte Auswahl (Modellfamilie + verfügbare Anbieter).
- `/model <#>` wählt aus dieser Auswahl.
- `/model status` ist die Detailansicht (Auth‑Kandidaten und – sofern konfiguriert – Anbieter‑Endpoint `baseUrl` + `api`‑Modus).
- Model‑Refs werden durch Trennen am **ersten** `/` geparst. Verwenden Sie `provider/model` beim Tippen von `/model <ref>`.
- Wenn die Modell‑ID selbst `/` enthält (OpenRouter‑Stil), müssen Sie das Anbieter‑Präfix angeben (Beispiel: `/model openrouter/moonshotai/kimi-k2`).
- Wenn Sie den Anbieter weglassen, behandelt OpenClaw die Eingabe als Alias oder als Modell für den **Standardanbieter** (funktioniert nur, wenn es kein `/` in der Modell‑ID gibt).

Vollständiges Befehlsverhalten/Konfiguration: [Slash commands](/tools/slash-commands).

## CLI‑Befehle

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (ohne Unterbefehl) ist eine Abkürzung für `models status`.

### `models list`

Zeigt standardmäßig konfigurierte Modelle an. Nützliche Flags:

- `--all`: vollständiger Katalog
- `--local`: nur lokale Anbieter
- `--provider <name>`: nach Anbieter filtern
- `--plain`: ein Modell pro Zeile
- `--json`: maschinenlesbare Ausgabe

### `models status`

Zeigt das aufgelöste primäre Modell, Fallbacks, Bildmodell und eine Auth‑Übersicht
der konfigurierten Anbieter. Außerdem wird der OAuth‑Ablaufstatus für im Auth‑Store
gefundene Profile angezeigt (standardmäßig Warnung innerhalb von 24 Std.). `--plain` gibt nur das
aufgelöste primäre Modell aus.
Der OAuth‑Status wird immer angezeigt (und ist in der Ausgabe von `--json` enthalten). Wenn ein konfigurierter
Anbieter keine Anmeldedaten hat, gibt `models status` einen Abschnitt **Missing auth** aus.
JSON enthält `auth.oauth` (Warnfenster + Profile) und `auth.providers`
(effektive Auth pro Anbieter).
Verwenden Sie `--check` für Automatisierung (Exit `1` bei fehlend/abgelaufen, `2` bei bald ablaufend).

Bevorzugte Anthropic‑Auth ist das Claude Code CLI setup-token (überall ausführbar; bei Bedarf auf dem Gateway‑Host einfügen):

```bash
claude setup-token
openclaw models status
```

## Scannen (OpenRouter‑Gratis‑Modelle)

`openclaw models scan` untersucht den **kostenlosen Modellkatalog** von OpenRouter und kann
optional Modelle auf Tool‑ und Bild‑Support prüfen.

Wichtige Flags:

- `--no-probe`: Live‑Probes überspringen (nur Metadaten)
- `--min-params <b>`: minimale Parametergröße (Milliarden)
- `--max-age-days <days>`: ältere Modelle überspringen
- `--provider <name>`: Anbieter‑Präfix‑Filter
- `--max-candidates <n>`: Größe der Fallback‑Liste
- `--set-default`: `agents.defaults.model.primary` auf die erste Auswahl setzen
- `--set-image`: `agents.defaults.imageModel.primary` auf die erste Bild‑Auswahl setzen

Probing erfordert einen OpenRouter‑API‑Schlüssel (aus Auth‑Profilen oder
`OPENROUTER_API_KEY`). Ohne Schlüssel verwenden Sie `--no-probe`, um nur Kandidaten aufzulisten.

Scan‑Ergebnisse werden gerankt nach:

1. Bild‑Support
2. Tool‑Latenz
3. Kontextgröße
4. Parameteranzahl

Eingabe

- OpenRouter‑`/models`‑Liste (Filter `:free`)
- Erfordert einen OpenRouter‑API‑Schlüssel aus Auth‑Profilen oder `OPENROUTER_API_KEY` (siehe [/environment](/help/environment))
- Optionale Filter: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Probe‑Steuerungen: `--timeout`, `--concurrency`

Bei Ausführung in einem TTY können Sie Fallbacks interaktiv auswählen. Im nicht‑interaktiven
Modus übergeben Sie `--yes`, um Standardwerte zu akzeptieren.

## Modelle‑Registry (`models.json`)

Benutzerdefinierte Anbieter in `models.providers` werden unter dem Agent‑Verzeichnis
(standardmäßig `~/.openclaw/agents/<agentId>/models.json`) in `models.json` geschrieben. Diese Datei
wird standardmäßig zusammengeführt, sofern `models.mode` nicht auf `replace` gesetzt ist.
