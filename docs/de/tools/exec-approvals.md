---
summary: "Exec Genehmigungen, Zulassungen und Sandbox Escape-Eingabeaufforderungen"
read_when:
  - Konfigurieren von Exec Genehmigungen oder Zulassungslisten
  - Implementierung der Exec-Freigabe-UX in der macOS-App
  - Überprüfung von Sandbox-Escape-Prompts und deren Auswirkungen
title: "Exec Genehmigungen"
---

# Exec-Genehmigungen

Exec-Freigaben sind die **Companion-App-/Node-Host-Schutzmaßnahme**, um einem in einer Sandbox laufenden Agenten das Ausführen von
Befehlen auf einem echten Host zu erlauben (`gateway` oder `node`). Stellen Sie sich dies wie eine Sicherheitsverriegelung vor:
Befehle werden nur zugelassen, wenn Richtlinie + Allowlist + (optionale) Benutzerfreigabe übereinstimmen.
Exec-Freigaben gelten **zusätzlich** zur Tool-Richtlinie und zum Elevated-Gating (außer wenn Elevated auf `full` gesetzt ist, wodurch Freigaben übersprungen werden).
Die wirksame Richtlinie ist die **strengere** aus `tools.exec.*` und den Standardwerten der Freigaben; wenn ein Freigabefeld ausgelassen wird, wird der Wert `tools.exec` verwendet.

Wenn die Companion-App-UI **nicht verfügbar** ist, wird jede Anfrage, die eine Abfrage erfordert,
durch den **Ask-Fallback** aufgelöst (Standard: verweigern).

## Wo es zutrifft

Exec-Freigaben werden lokal auf dem Ausführungshost durchgesetzt:

- **Gateway-Host** → `openclaw`-Prozess auf der Gateway-Maschine
- **Node-Host** → Node-Runner (macOS-Companion-App oder Headless-Node-Host)

macOS-Aufteilung:

- **Node-Host-Service** leitet `system.run` über lokales IPC an die **macOS-App** weiter.
- **macOS-App** setzt Freigaben durch und führt den Befehl im UI-Kontext aus.

## Einstellungen und Speicherung

Freigaben liegen in einer lokalen JSON-Datei auf dem Ausführungshost:

`~/.openclaw/exec-approvals.json`

Beispielschema:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Richtlinienoptionen

### Sicherheit (`exec.security`)

- **deny**: alle Host-Exec-Anfragen blockieren.
- **allowlist**: nur allowlistete Befehle zulassen.
- **full**: alles zulassen (entspricht Elevated).

### Ask (`exec.ask`)

- **off**: niemals nachfragen.
- **on-miss**: nur nachfragen, wenn die Allowlist nicht passt.
- **always**: bei jedem Befehl nachfragen.

### Ask-Fallback (`askFallback`)

Wenn eine Abfrage erforderlich ist, aber keine UI erreichbar ist, entscheidet der Fallback:

- **deny**: blockieren.
- **allowlist**: nur zulassen, wenn die Allowlist passt.
- **full**: zulassen.

## Allowlist (pro Agent)

Allowlists sind **pro Agent**. Wenn mehrere Agenten existieren, wechseln Sie in der
macOS-App den Agenten, den Sie bearbeiten. Muster sind **groß-/kleinschreibungsunabhängige Glob-Matches**.
Muster sollten zu **Binärpfaden** aufgelöst werden (Einträge nur mit Basename werden ignoriert).
Legacy-`agents.default`-Einträge werden beim Laden zu `agents.main` migriert.

Beispiele:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Jeder Allowlist-Eintrag erfasst:

- **id** stabile UUID für die UI-Identität (optional)
- **last used** Zeitstempel
- **last used command**
- **last resolved path**

## Auto-Allow für Skill-CLIs

Wenn **Auto-Allow für Skill-CLIs** aktiviert ist, werden von bekannten Skills referenzierte
ausführbare Dateien auf Nodes (macOS-Node oder Headless-Node-Host) als allowlistet behandelt. Dies verwendet
`skills.bins` über Gateway-RPC, um die Skill-Bin-Liste abzurufen. Deaktivieren Sie dies, wenn Sie strikte manuelle Allowlists wünschen.

## Sichere Bins (nur stdin)

`tools.exec.safeBins` definiert eine kleine Liste von **stdin-only**-Binärdateien (z. B. `jq`),
die im Allowlist-Modus **ohne** explizite Allowlist-Einträge ausgeführt werden dürfen. Sichere Bins verwerfen
positionale Dateiargumente und pfadähnliche Token, sodass sie nur auf dem eingehenden Stream arbeiten können.
Shell-Verkettungen und Umleitungen werden im Allowlist-Modus nicht automatisch erlaubt.

Shell-Verkettung (`&&`, `||`, `;`) ist erlaubt, wenn jedes Top-Level-Segment die Allowlist erfüllt
(einschließlich sicherer Bins oder Skill-Auto-Allow). Umleitungen bleiben im Allowlist-Modus nicht unterstützt.
Befehlsersetzung (`$()` / Backticks) wird während der Allowlist-Analyse abgelehnt, auch innerhalb
doppelter Anführungszeichen; verwenden Sie einfache Anführungszeichen, wenn Sie wörtlichen `$()`-Text benötigen.

Standardmäßige sichere Bins: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Bearbeitung über die Control UI

Verwenden Sie die Karte **Control UI → Nodes → Exec-Freigaben**, um Standardwerte, agentenspezifische
Überschreibungen und Allowlists zu bearbeiten. Wählen Sie einen Geltungsbereich (Standardwerte oder einen Agenten),
passen Sie die Richtlinie an, fügen Sie Allowlist-Muster hinzu oder entfernen Sie sie und klicken Sie dann auf **Save**. Die UI zeigt **last used**-Metadaten pro Muster an, damit Sie die Liste übersichtlich halten können.

Der Zielselektor wählt **Gateway** (lokale Freigaben) oder einen **Node**. Nodes
müssen `system.execApprovals.get/set` bewerben (macOS-App oder Headless-Node-Host).
Wenn ein Node noch keine Exec-Freigaben bewirbt, bearbeiten Sie dessen lokale
`~/.openclaw/exec-approvals.json` direkt.

CLI: `openclaw approvals` unterstützt die Bearbeitung von Gateway oder Node (siehe [Approvals CLI](/cli/approvals)).

## Genehmigungsfluss

Wenn eine Abfrage erforderlich ist, sendet das Gateway `exec.approval.requested` an Operator-Clients.
Die Control UI und die macOS-App lösen dies über `exec.approval.resolve` auf, anschließend leitet das Gateway die
freigegebene Anfrage an den Node-Host weiter.

Wenn Freigaben erforderlich sind, gibt das Exec-Tool sofort mit einer Freigabe-ID zurück. Verwenden Sie diese ID, um
spätere Systemereignisse zu korrelieren (`Exec finished` / `Exec denied`). Trifft vor Ablauf des
Timeouts keine Entscheidung ein, wird die Anfrage als Freigabe-Timeout behandelt und als Ablehnungsgrund angezeigt.

Der Bestätigungsdialog enthält:

- Befehl + Argumente
- cwd
- Agent-ID
- aufgelöster Pfad der ausführbaren Datei
- Host- und Richtlinienmetadaten

Aktionen:

- **Allow once** → jetzt ausführen
- **Always allow** → zur Allowlist hinzufügen + ausführen
- **Deny** → blockieren

## Weiterleitung von Freigaben an Chat-Kanäle

Sie können Exec-Freigabe-Prompts an jeden Chat-Kanal (einschließlich Plugin-Kanälen) weiterleiten und
sie mit `/approve` freigeben. Dies verwendet die normale Outbound-Delivery-Pipeline.

Konfiguration:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Antwort im Chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### macOS-IPC-Ablauf

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Sicherheitshinweise:

- Unix-Socket-Modus `0600`, Token gespeichert in `exec-approvals.json`.
- Same-UID-Peer-Prüfung.
- Challenge/Response (Nonce + HMAC-Token + Request-Hash) + kurze TTL.

## Systemereignisse

Der Exec-Lebenszyklus wird als Systemmeldungen ausgegeben:

- `Exec running` (nur wenn der Befehl die Laufzeit-Benachrichtigungsschwelle überschreitet)
- `Exec finished`
- `Exec denied`

Diese werden in der Sitzung des Agenten gepostet, nachdem der Node das Ereignis gemeldet hat.
Exec-Freigaben auf dem Gateway-Host geben dieselben Lebenszyklusereignisse aus, wenn der Befehl beendet ist (und optional, wenn er länger als die Schwelle läuft).
Freigabe-gebundene Execs verwenden die Freigabe-ID als `runId` in diesen Meldungen zur einfachen Korrelation.

## Implikationen

- **voll** ist mächtig; bevorzugen Sie Zulassungslisten wenn möglich.
- **ask** hält Sie eingebunden und ermöglicht dennoch schnelle Freigaben.
- Pro-Agent-Allowlists verhindern, dass Freigaben eines Agenten auf andere übergreifen.
- Freigaben gelten nur für Host-Exec-Anfragen von **autorisierten Absendern**. Nicht autorisierte Absender können `/exec` nicht ausführen.
- `/exec security=full` ist eine sitzungsweite Komfortfunktion für autorisierte Operatoren und überspringt Freigaben bewusst.
  Um Host-Exec hart zu blockieren, setzen Sie die Freigabe-Sicherheit auf `deny` oder verweigern Sie das Werkzeug `exec` über die Tool-Richtlinie.

Verwandt:

- [Exec-Tool](/tools/exec)
- [Elevated-Modus](/tools/elevated)
- [Skills](/tools/skills)
