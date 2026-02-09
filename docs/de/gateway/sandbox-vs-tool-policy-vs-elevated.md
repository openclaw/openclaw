---
title: Sandbox vs. Tool-Policy vs. Erhöht
summary: "„Warum ein Werkzeug blockiert ist: Sandbox-Laufzeit, Tool-Allow/Deny-Policy und erhöhte Exec-Gates“"
read_when: "„Wenn Sie auf ‚Sandbox-Gefängnis‘ stoßen oder eine Tool-/Elevated-Verweigerung sehen und den exakten Konfigurationsschlüssel ändern möchten.“"
status: active
---

# Sandbox vs. Tool-Policy vs. Erhöht

OpenClaw hat drei zusammenhängende (aber unterschiedliche) Kontrollmechanismen:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) entscheidet, **wo Werkzeuge ausgeführt werden** (Docker vs. Host).
2. **Tool-Policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) entscheidet, **welche Werkzeuge verfügbar/zulässig sind**.
3. **Erhöht** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) ist eine **reine Exec-Ausnahme**, um bei aktivierter Sandbox auf dem Host auszuführen.

## Schnelle Fehlersuche

Verwenden Sie den Inspector, um zu sehen, was OpenClaw _tatsächlich_ tut:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Es druckt:

- effektiven Sandbox-Modus/Scope/Workspace-Zugriff
- ob die Sitzung aktuell sandboxed ist (Hauptsitzung vs. Nicht‑Hauptsitzung)
- effektive Sandbox-Tool-Allow/Deny (und ob es von Agent/Global/Default stammt)
- Elevated-Gates und Fix‑it‑Schlüsselpfade

## Sandbox: wo Werkzeuge laufen

Sandboxing wird über `agents.defaults.sandbox.mode` gesteuert:

- `"off"`: alles läuft auf dem Host.
- `"non-main"`: nur Nicht‑Hauptsitzungen sind sandboxed (häufige „Überraschung“ für Gruppen/Kanäle).
- `"all"`: alles ist sandboxed.

Siehe [Sandboxing](/gateway/sandboxing) für die vollständige Matrix (Scope, Workspace-Mounts, Images).

### Bind-Mounts (Sicherheits‑Quickcheck)

- `docker.binds` _durchstößt_ das Sandbox-Dateisystem: Alles, was Sie mounten, ist im Container mit dem von Ihnen gesetzten Modus sichtbar (`:ro` oder `:rw`).
- Standard ist Lesen/Schreiben, wenn Sie den Modus weglassen; bevorzugen Sie `:ro` für Quellcode/Secrets.
- `scope: "shared"` ignoriert agentenspezifische Binds (es gelten nur globale Binds).
- Das Binden von `/var/run/docker.sock` übergibt effektiv Host‑Kontrolle an die Sandbox; tun Sie dies nur bewusst.
- Workspace‑Zugriff (`workspaceAccess: "ro"`/`"rw"`) ist unabhängig von Bind‑Modi.

## Tool-Policy: welche Werkzeuge existieren/aufrufbar sind

Zwei Ebenen sind relevant:

- **Tool-Profil**: `tools.profile` und `agents.list[].tools.profile` (Basis‑Allowlist)
- **Provider‑Tool‑Profil**: `tools.byProvider[provider].profile` und `agents.list[].tools.byProvider[provider].profile`
- **Globale/agentenspezifische Tool‑Policy**: `tools.allow`/`tools.deny` und `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider‑Tool‑Policy**: `tools.byProvider[provider].allow/deny` und `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox‑Tool‑Policy** (gilt nur bei aktiver Sandbox): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` und `agents.list[].tools.sandbox.tools.*`

Faustregeln:

- `deny` gewinnt immer.
- Wenn `allow` nicht leer ist, wird alles andere als blockiert behandelt.
- Die Tool‑Policy ist der harte Stopp: `/exec` kann ein verweigertes `exec`‑Werkzeug nicht überschreiben.
- `/exec` ändert nur Sitzungs‑Defaults für autorisierte Absender; es gewährt keinen Tool‑Zugriff.
  Provider‑Tool‑Schlüssel akzeptieren entweder `provider` (z. B. `google-antigravity`) oder `provider/model` (z. B. `openai/gpt-5.2`).

### Tool‑Gruppen (Kurzschreibweisen)

Tool‑Policies (global, Agent, Sandbox) unterstützen `group:*`‑Einträge, die zu mehreren Werkzeugen expandieren:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Verfügbare Gruppen:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle integrierten OpenClaw‑Werkzeuge (ohne Provider‑Plugins)

## Erhöht: reines Exec‑„auf dem Host ausführen“

Erhöht gewährt **keine** zusätzlichen Werkzeuge; es betrifft nur `exec`.

- Wenn Sie sandboxed sind, führt `/elevated on` (oder `exec` mit `elevated: true`) auf dem Host aus (Freigaben können weiterhin erforderlich sein).
- Verwenden Sie `/elevated full`, um Exec‑Freigaben für die Sitzung zu überspringen.
- Wenn Sie bereits direkt ausführen, ist „erhöht“ effektiv ein No‑op (weiterhin gated).
- Erhöht ist **nicht** skill‑gebunden und überschreibt **keine** Tool‑Allow/Deny‑Regeln.
- `/exec` ist von „erhöht“ getrennt. Es passt nur sitzungsweise Exec‑Defaults für autorisierte Absender an.

Gates:

- Aktivierung: `tools.elevated.enabled` (und optional `agents.list[].tools.elevated.enabled`)
- Absender‑Allowlists: `tools.elevated.allowFrom.<provider>` (und optional `agents.list[].tools.elevated.allowFrom.<provider>`)

Siehe [Elevated Mode](/tools/elevated).

## Häufige „Sandbox‑Gefängnis“-Fixes

### „Werkzeug X durch Sandbox‑Tool‑Policy blockiert“

Fix‑it‑Schlüssel (wählen Sie einen):

- Sandbox deaktivieren: `agents.defaults.sandbox.mode=off` (oder agentenspezifisch `agents.list[].sandbox.mode=off`)
- Werkzeug innerhalb der Sandbox erlauben:
  - aus `tools.sandbox.tools.deny` entfernen (oder agentenspezifisch `agents.list[].tools.sandbox.tools.deny`)
  - oder zu `tools.sandbox.tools.allow` hinzufügen (oder agentenspezifische Allow)

### „Ich dachte, das sei ‚main‘ – warum ist es sandboxed?“

Im Modus `"non-main"` sind Gruppen-/Kanal‑Schlüssel _nicht_ „main“. Verwenden Sie den Hauptsitzungs‑Schlüssel (angezeigt durch `sandbox explain`) oder wechseln Sie den Modus zu `"off"`.
