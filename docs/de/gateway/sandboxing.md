---
summary: "„Wie OpenClaw-Sandboxing funktioniert: Modi, Geltungsbereiche, Workspace-Zugriff und Images“"
title: Sandboxing
read_when: "„Sie möchten eine dedizierte Erklärung zu Sandboxing oder müssen agents.defaults.sandbox feinjustieren.“"
status: active
---

# Sandboxing

OpenClaw kann **Werkzeuge innerhalb von Docker-Containern ausführen**, um den Schadensradius zu reduzieren.
Dies ist **optional** und wird über die Konfiguration gesteuert (`agents.defaults.sandbox` oder
`agents.list[].sandbox`). Ist Sandboxing deaktiviert, laufen Werkzeuge auf dem Host.
Das Gateway verbleibt auf dem Host; die Werkzeugausführung läuft bei Aktivierung in einer isolierten Sandbox.

Dies ist keine perfekte Sicherheitsgrenze, begrenzt jedoch den Zugriff auf Dateisystem und Prozesse erheblich, wenn das Modell etwas Unkluges tut.

## Was wird sandboxed

- Werkzeugausführung (`exec`, `read`, `write`, `edit`, `apply_patch`, `process` usw.).
- Optionaler sandboxed Browser (`agents.defaults.sandbox.browser`).
  - Standardmäßig startet der Sandbox-Browser automatisch (stellt sicher, dass CDP erreichbar ist), wenn das Browser-Werkzeug ihn benötigt.
    Konfiguration über `agents.defaults.sandbox.browser.autoStart` und `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` erlaubt es sandboxed Sitzungen, explizit den Host-Browser anzusteuern.
  - Optionale Allowlists begrenzen `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Nicht sandboxed:

- Der Gateway-Prozess selbst.
- Jedes Werkzeug, das explizit erlaubt ist, auf dem Host zu laufen (z. B. `tools.elevated`).
  - **Erhöhte Ausführung läuft auf dem Host und umgeht Sandboxing.**
  - Ist Sandboxing deaktiviert, ändert `tools.elevated` die Ausführung nicht (bereits auf dem Host). Siehe [Elevated Mode](/tools/elevated).

## Modi

`agents.defaults.sandbox.mode` steuert, **wann** Sandboxing verwendet wird:

- `"off"`: kein Sandboxing.
- `"non-main"`: Sandbox nur für **nicht‑Haupt**‑Sitzungen (Standard, wenn normale Chats auf dem Host laufen sollen).
- `"all"`: jede Sitzung läuft in einer Sandbox.
  Hinweis: `"non-main"` basiert auf `session.mainKey` (Standard `"main"`), nicht auf der Agent‑ID.
  Gruppen-/Kanal‑Sitzungen verwenden eigene Schlüssel, zählen daher als nicht‑Haupt und werden sandboxed.

## Geltungsbereich

`agents.defaults.sandbox.scope` steuert, **wie viele Container** erstellt werden:

- `"session"` (Standard): ein Container pro Sitzung.
- `"agent"`: ein Container pro Agent.
- `"shared"`: ein Container, der von allen sandboxed Sitzungen geteilt wird.

## Workspace-Zugriff

`agents.defaults.sandbox.workspaceAccess` steuert, **was die Sandbox sehen kann**:

- `"none"` (Standard): Werkzeuge sehen einen Sandbox‑Workspace unter `~/.openclaw/sandboxes`.
- `"ro"`: bindet den Agent‑Workspace schreibgeschützt unter `/agent` ein (deaktiviert `write`/`edit`/`apply_patch`).
- `"rw"`: bindet den Agent‑Workspace mit Lese-/Schreibzugriff unter `/workspace` ein.

Eingehende Medien werden in den aktiven Sandbox‑Workspace kopiert (`media/inbound/*`).
Hinweis zu Skills: Das Werkzeug `read` ist auf die Sandbox‑Root ausgerichtet. Mit `workspaceAccess: "none"`
spiegelt OpenClaw geeignete Skills in den Sandbox‑Workspace (`.../skills`), sodass
sie gelesen werden können. Mit `"rw"` sind Workspace‑Skills lesbar unter
`/workspace/skills`.

## Benutzerdefinierte Bind-Mounts

`agents.defaults.sandbox.docker.binds` bindet zusätzliche Host‑Verzeichnisse in den Container ein.
Format: `host:container:mode` (z. B. `"/home/user/source:/source:rw"`).

Globale und agentenspezifische Binds werden **zusammengeführt** (nicht ersetzt). Unter `scope: "shared"` werden agentenspezifische Binds ignoriert.

Beispiel (schreibgeschützte Quelle + Docker‑Socket):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Sicherheitshinweise:

- Binds umgehen das Sandbox‑Dateisystem: Sie legen Host‑Pfade mit dem von Ihnen gesetzten Modus offen (`:ro` oder `:rw`).
- Sensible Mounts (z. B. `docker.sock`, Secrets, SSH‑Schlüssel) sollten `:ro` sein, sofern nicht absolut erforderlich.
- Kombinieren Sie dies mit `workspaceAccess: "ro"`, wenn Sie nur Lesezugriff auf den Workspace benötigen; Bind‑Modi bleiben unabhängig.
- Siehe [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) dazu, wie Binds mit Werkzeugrichtlinien und erhöhter Ausführung interagieren.

## Images + Setup

Standard‑Image: `openclaw-sandbox:bookworm-slim`

Einmal bauen:

```bash
scripts/sandbox-setup.sh
```

Hinweis: Das Standard‑Image enthält **kein** Node. Benötigt ein Skill Node (oder
andere Runtimes), backen Sie entweder ein eigenes Image oder installieren Sie über
`sandbox.docker.setupCommand` (erfordert Netzwerk‑Egress + schreibbare Root +
Root‑Benutzer).

Sandboxed Browser‑Image:

```bash
scripts/sandbox-browser-setup.sh
```

Standardmäßig laufen Sandbox‑Container **ohne Netzwerk**.
Überschreiben Sie dies mit `agents.defaults.sandbox.docker.network`.

Docker‑Installationen und das containerisierte Gateway finden Sie hier:
[Docker](/install/docker)

## setupCommand (einmaliges Container‑Setup)

`setupCommand` wird **einmal** nach der Erstellung des Sandbox‑Containers ausgeführt (nicht bei jedem Lauf).
Die Ausführung erfolgt im Container über `sh -lc`.

Pfad:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Pro Agent: `agents.list[].sandbox.docker.setupCommand`

Häufige Fallstricke:

- Standard `docker.network` ist `"none"` (kein Egress), daher schlagen Paketinstallationen fehl.
- `readOnlyRoot: true` verhindert Schreibzugriffe; setzen Sie `readOnlyRoot: false` oder backen Sie ein eigenes Image.
- `user` muss Root sein für Paketinstallationen (lassen Sie `user` weg oder setzen Sie `user: "0:0"`).
- Sandbox‑Ausführung erbt **nicht** die Host‑`process.env`. Verwenden Sie
  `agents.defaults.sandbox.docker.env` (oder ein eigenes Image) für Skill‑API‑Schlüssel.

## Werkzeugrichtlinie + Escape‑Hatches

Werkzeug‑Allow/Deny‑Richtlinien gelten weiterhin vor den Sandbox‑Regeln. Ist ein Werkzeug
global oder pro Agent verboten, bringt Sandboxing es nicht zurück.

`tools.elevated` ist eine explizite Escape‑Hatch, die `exec` auf dem Host ausführt.
`/exec`‑Direktiven gelten nur für autorisierte Absender und bleiben pro Sitzung bestehen; um
`exec` hart zu deaktivieren, verwenden Sie eine Werkzeugrichtlinien‑Sperre (siehe [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debugging:

- Verwenden Sie `openclaw sandbox explain`, um den effektiven Sandbox‑Modus, die Werkzeugrichtlinie und Fix‑it‑Konfigurationsschlüssel zu prüfen.
- Siehe [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) für das mentale Modell „Warum ist das blockiert?“
  Halten Sie es strikt abgesichert.
  Halten Sie es gesperrt.

## Multi‑Agent‑Overrides

Jeder Agent kann Sandbox + Werkzeuge überschreiben:
`agents.list[].sandbox` und `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` für die Sandbox‑Werkzeugrichtlinie).
Siehe [Multi‑Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) zur Priorität.

## Minimales Aktivierungsbeispiel

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Verwandte Dokumente

- [Sandbox‑Konfiguration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi‑Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Sicherheit](/gateway/security)
