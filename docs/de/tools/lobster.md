---
title: Lobster
summary: "„Typisierte Workflow-Laufzeit für OpenClaw mit fortsetzbaren Genehmigungssperren.“"
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - Sie möchten deterministische, mehrstufige Workflows mit expliziten Genehmigungen
  - Sie müssen einen Workflow fortsetzen, ohne frühere Schritte erneut auszuführen
---

# Lobster

Lobster ist eine Workflow-Shell, mit der OpenClaw mehrstufige Werkzeugsequenzen als einen einzigen, deterministischen Vorgang mit expliziten Genehmigungs-Checkpoints ausführen kann.

## Hook

Ihr Assistent kann die Werkzeuge bauen, mit denen er sich selbst verwaltet. Fragen Sie nach einem Workflow, und 30 Minuten später haben Sie eine CLI plus Pipelines, die als ein Aufruf laufen. Lobster ist das fehlende Puzzleteil: deterministische Pipelines, explizite Genehmigungen und fortsetzbarer Zustand.

## Warum

Heute erfordern komplexe Workflows viele Hin-und-her-Werkzeugaufrufe. Jeder Aufruf kostet Tokens, und das LLM muss jeden Schritt orchestrieren. Lobster verlagert diese Orchestrierung in eine typisierte Laufzeit:

- **Ein Aufruf statt vieler**: OpenClaw führt einen Lobster-Werkzeugaufruf aus und erhält ein strukturiertes Ergebnis.
- **Genehmigungen integriert**: Seiteneffekte (E-Mail senden, Kommentar posten) halten den Workflow an, bis sie explizit genehmigt werden.
- **Fortsetzbar**: Angehaltene Workflows geben ein Token zurück; genehmigen und fortsetzen, ohne alles erneut auszuführen.

## Warum eine DSL statt normaler Programme?

Lobster ist bewusst klein gehalten. Das Ziel ist nicht „eine neue Sprache“, sondern eine vorhersehbare, KI-freundliche Pipeline-Spezifikation mit erstklassigen Genehmigungen und Resume-Tokens.

- **Genehmigen/Fortsetzen ist integriert**: Ein normales Programm kann einen Menschen auffordern, aber es kann nicht _anhalten und mit einem dauerhaften Token fortsetzen_, ohne dass Sie diese Laufzeit selbst erfinden.
- **Determinismus + Auditierbarkeit**: Pipelines sind Daten und daher leicht zu protokollieren, zu vergleichen, erneut abzuspielen und zu prüfen.
- **Begrenzte Oberfläche für KI**: Eine kleine Grammatik + JSON-Pipes reduzieren „kreative“ Codepfade und machen Validierung realistisch.
- **Sicherheitsrichtlinien eingebaut**: Timeouts, Ausgabelimits, Sandbox-Prüfungen und Allowlists werden von der Laufzeit erzwungen, nicht von jedem Skript.
- **Trotzdem programmierbar**: Jeder Schritt kann jede CLI oder jedes Skript aufrufen. Wenn Sie JS/TS möchten, generieren Sie `.lobster`-Dateien aus Code.

## Wie es funktioniert

OpenClaw startet die lokale `lobster`-CLI im **Tool-Modus** und parst einen JSON-Umschlag aus stdout.
Wenn die Pipeline zur Genehmigung pausiert, gibt das Werkzeug ein `resumeToken` zurück, damit Sie später fortfahren können.

## Muster: kleine CLI + JSON-Pipes + Genehmigungen

Erstellen Sie kleine Befehle, die JSON sprechen, und verketten Sie sie dann zu einem einzigen Lobster-Aufruf. (Beispiel-Befehlsnamen unten — ersetzen Sie sie durch eigene.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

Wenn die Pipeline eine Genehmigung anfordert, setzen Sie mit dem Token fort:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Die KI triggert den Workflow; Lobster führt die Schritte aus. Genehmigungssperren halten Seiteneffekte explizit und auditierbar.

Beispiel: Eingabeelemente auf Werkzeugaufrufe abbilden:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## JSON-only-LLM-Schritte (llm-task)

Für Workflows, die einen **strukturierten LLM-Schritt** benötigen, aktivieren Sie das optionale
`llm-task`-Plugin-Werkzeug und rufen es aus Lobster auf. So bleibt der Workflow
deterministisch, während Sie dennoch mit einem Modell klassifizieren/zusammenfassen/entwerfen können.

Werkzeug aktivieren:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

In einer Pipeline verwenden:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

Siehe [LLM Task](/tools/llm-task) für Details und Konfigurationsoptionen.

## Workflow-Dateien (.lobster)

Lobster kann YAML/JSON-Workflow-Dateien mit den Feldern `name`, `args`, `steps`, `env`, `condition` und `approval` ausführen. In OpenClaw-Werkzeugaufrufen setzen Sie `pipeline` auf den Dateipfad.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Hinweise:

- `stdin: $step.stdout` und `stdin: $step.json` übergeben die Ausgabe eines vorherigen Schritts.
- `condition` (oder `when`) kann Schritte anhand von `$step.approved` sperren.

## Lobster installieren

Installieren Sie die Lobster-CLI auf demselben **Host**, auf dem das OpenClaw Gateway läuft (siehe das [Lobster-Repo](https://github.com/openclaw/lobster)), und stellen Sie sicher, dass `lobster` in `PATH` enthalten ist.
Wenn Sie einen benutzerdefinierten Speicherort für die Binärdatei verwenden möchten, übergeben Sie im Werkzeugaufruf einen **absoluten** `lobsterPath`.

## Werkzeug aktivieren

Lobster ist ein **optional**es Plugin-Werkzeug (standardmäßig nicht aktiviert).

Empfohlen (additiv, sicher):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

Oder pro Agent:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

Vermeiden Sie die Verwendung von `tools.allow: ["lobster"]`, es sei denn, Sie beabsichtigen, im restriktiven Allowlist-Modus zu laufen.

Hinweis: Allowlists sind für optionale Plugins opt-in. Wenn Ihre Allowlist nur
Plugin-Werkzeuge (wie `lobster`) benennt, hält OpenClaw die Kernwerkzeuge aktiviert. Um Kernwerkzeuge einzuschränken, nehmen Sie die gewünschten Kernwerkzeuge oder -gruppen ebenfalls in die Allowlist auf.

## Beispiel: E-Mail-Triage

Ohne Lobster:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Mit Lobster:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Gibt einen JSON-Umschlag zurück (gekürzt):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

Benutzer genehmigt → fortsetzen:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Ein Workflow. Deterministisch. Sicher.

## Werkzeugparameter

### `run`

Eine Pipeline im Tool-Modus ausführen.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Eine Workflow-Datei mit Argumenten ausführen:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Einen angehaltenen Workflow nach Genehmigung fortsetzen.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Optionale Eingaben

- `lobsterPath`: Absoluter Pfad zur Lobster-Binärdatei (weglassen, um `PATH` zu verwenden).
- `cwd`: Arbeitsverzeichnis für die Pipeline (Standard: aktuelles Arbeitsverzeichnis des Prozesses).
- `timeoutMs`: Subprozess beenden, wenn diese Dauer überschritten wird (Standard: 20000).
- `maxStdoutBytes`: Subprozess beenden, wenn stdout diese Größe überschreitet (Standard: 512000).
- `argsJson`: JSON-String, der an `lobster run --args-json` übergeben wird (nur Workflow-Dateien).

## Ausgabe-Umschlag

Lobster gibt einen JSON-Umschlag mit einem von drei Status zurück:

- `ok` → erfolgreich abgeschlossen
- `needs_approval` → pausiert; `requiresApproval.resumeToken` ist zum Fortsetzen erforderlich
- `cancelled` → explizit abgelehnt oder abgebrochen

Das Werkzeug stellt den Umschlag sowohl in `content` (formatiertes JSON) als auch in `details` (rohes Objekt) bereit.

## Genehmigungen

Wenn `requiresApproval` vorhanden ist, prüfen Sie die Aufforderung und entscheiden Sie:

- `approve: true` → fortsetzen und Seiteneffekte ausführen
- `approve: false` → abbrechen und den Workflow finalisieren

Verwenden Sie `approve --preview-from-stdin --limit N`, um Genehmigungsanfragen eine JSON-Vorschau anzuhängen, ohne benutzerdefiniertes jq/Heredoc-Geklebe. Resume-Tokens sind jetzt kompakt: Lobster speichert den Workflow-Fortsetzungszustand in seinem Zustandsverzeichnis und gibt einen kleinen Token-Schlüssel zurück.

## OpenProse

OpenProse ergänzt Lobster hervorragend: Verwenden Sie `/prose`, um die Multi-Agenten-Vorbereitung zu orchestrieren, und führen Sie anschließend eine Lobster-Pipeline für deterministische Genehmigungen aus. Wenn ein Prose-Programm Lobster benötigt, erlauben Sie das `lobster`-Werkzeug für Sub-Agenten über `tools.subagents.tools`. Siehe [OpenProse](/prose).

## Sicherheit

- **Nur lokaler Subprozess** — keine Netzwerkaufrufe aus dem Plugin selbst.
- **Keine Geheimnisse** — Lobster verwaltet kein OAuth; es ruft OpenClaw-Werkzeuge auf, die dies tun.
- **Sandbox-bewusst** — deaktiviert, wenn der Tool-Kontext sandboxed ist.
- **Gehärtet** — `lobsterPath` muss absolut sein, wenn angegeben; Timeouts und Ausgabelimits werden erzwungen.

## Fehlerbehebung

- **`lobster subprocess timed out`** → erhöhen Sie `timeoutMs` oder teilen Sie eine lange Pipeline auf.
- **`lobster output exceeded maxStdoutBytes`** → erhöhen Sie `maxStdoutBytes` oder reduzieren Sie die Ausgabegröße.
- **`lobster returned invalid JSON`** → stellen Sie sicher, dass die Pipeline im Tool-Modus läuft und nur JSON ausgibt.
- **`lobster failed (code …)`** → führen Sie dieselbe Pipeline im Terminal aus, um stderr zu prüfen.

## Mehr erfahren

- [Plugins](/tools/plugin)
- [Plugin-Werkzeugerstellung](/plugins/agent-tools)

## Fallstudie: Community-Workflows

Ein öffentliches Beispiel: eine „Second-Brain“-CLI + Lobster-Pipelines, die drei Markdown-Tresore (persönlich, Partner, gemeinsam) verwalten. Die CLI gibt JSON für Statistiken, Inbox-Listen und Stale-Scans aus; Lobster verkettet diese Befehle zu Workflows wie `weekly-review`, `inbox-triage`, `memory-consolidation` und `shared-task-sync`, jeweils mit Genehmigungssperren. Die KI übernimmt Urteilsfindung (Kategorisierung), wenn verfügbar, und greift andernfalls auf deterministische Regeln zurück.

- Thread: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
