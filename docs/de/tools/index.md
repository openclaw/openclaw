---
summary: "„Agenten-Werkzeugoberfläche für OpenClaw (Browser, Canvas, Nodes, Nachrichten, Cron), die veraltete `openclaw-*` Skills ersetzt“"
read_when:
  - Beim Hinzufügen oder Ändern von Agenten-Werkzeugen
  - Beim Außerbetriebnehmen oder Ändern von `openclaw-*` Skills
title: "„Werkzeuge“"
---

# Werkzeuge (OpenClaw)

OpenClaw stellt **erstklassige Agenten-Werkzeuge** für Browser, Canvas, Nodes und Cron bereit.
Diese ersetzen die alten `openclaw-*` Skills: Die Werkzeuge sind typisiert, ohne Shell-Aufrufe,
und der Agent sollte sich direkt auf sie verlassen.

## Werkzeuge deaktivieren

Sie können Werkzeuge global über `tools.allow` / `tools.deny` in `openclaw.json` erlauben/verbieten
(„deny“ gewinnt). Dadurch wird verhindert, dass nicht erlaubte Werkzeuge an Modellanbieter gesendet werden.

```json5
{
  tools: { deny: ["browser"] },
}
```

Hinweise:

- Der Abgleich ist nicht case-sensitiv.
- `*`-Wildcards werden unterstützt (`"*"` bedeutet alle Werkzeuge).
- Wenn `tools.allow` nur auf unbekannte oder nicht geladene Plugin-Werkzeugnamen verweist, protokolliert OpenClaw eine Warnung und ignoriert die Allowlist, sodass Kernwerkzeuge verfügbar bleiben.

## Werkzeugprofile (Basis-Allowlist)

`tools.profile` setzt eine **Basis-Allowlist für Werkzeuge** vor `tools.allow`/`tools.deny`.
Pro-Agent-Override: `agents.list[].tools.profile`.

Profile:

- `minimal`: nur `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: keine Einschränkung (wie nicht gesetzt)

Beispiel (standardmäßig nur Messaging, zusätzlich Slack- und Discord-Werkzeuge erlauben):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Beispiel (Coding-Profil, aber exec/process überall verbieten):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Beispiel (globales Coding-Profil, Support-Agent nur Messaging):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Anbieter­spezifische Werkzeugrichtlinie

Verwenden Sie `tools.byProvider`, um Werkzeuge für bestimmte Anbieter
(oder ein einzelnes `provider/model`) **weiter einzuschränken**, ohne Ihre globalen Standardwerte zu ändern.
Pro-Agent-Override: `agents.list[].tools.byProvider`.

Dies wird **nach** dem Basis-Werkzeugprofil und **vor** Allow/Deny-Listen angewendet,
sodass der Werkzeugsatz nur eingeschränkt werden kann.
Anbieter-Schlüssel akzeptieren entweder `provider` (z. B. `google-antigravity`) oder
`provider/model` (z. B. `openai/gpt-5.2`).

Beispiel (globales Coding-Profil beibehalten, aber minimale Werkzeuge für Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Beispiel (anbieter-/modellspezifische Allowlist für einen instabilen Endpunkt):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Beispiel (agentenspezifischer Override für einen einzelnen Anbieter):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Werkzeuggruppen (Kurzschreibweisen)

Werkzeugrichtlinien (global, Agent, sandbox) unterstützen `group:*`-Einträge, die zu mehreren Werkzeugen expandieren.
Verwenden Sie diese in `tools.allow` / `tools.deny`.

Verfügbare Gruppen:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle integrierten OpenClaw-Werkzeuge (schließt Anbieter-Plugins aus)

Beispiel (nur Datei-Werkzeuge + Browser erlauben):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + Werkzeuge

Plugins können **zusätzliche Werkzeuge** (und CLI-Befehle) über den Kernumfang hinaus registrieren.
Siehe [Plugins](/tools/plugin) für Installation + Konfiguration und [Skills](/tools/skills) dazu,
wie Anleitungen zur Werkzeugnutzung in Prompts eingebettet werden. Einige Plugins liefern eigene Skills
zusammen mit Werkzeugen aus (z. B. das Voice-Call-Plugin).

Optionale Plugin-Werkzeuge:

- [Lobster](/tools/lobster): typisierte Workflow-Laufzeit mit fortsetzbaren Freigaben (erfordert die Lobster CLI auf dem Gateway-Host).
- [LLM Task](/tools/llm-task): reiner JSON-LLM-Schritt für strukturierte Workflow-Ausgaben (optionale Schema-Validierung).

## Werkzeuginventar

### `apply_patch`

Wenden Sie strukturierte Patches auf eine oder mehrere Dateien an. Für Multi-Hunk-Edits verwenden.
Experimentell: aktivieren über `tools.exec.applyPatch.enabled` (nur OpenAI-Modelle).

### `exec`

Shell-Befehle im Workspace ausführen.

Kernparameter:

- `command` (erforderlich)
- `yieldMs` (automatischer Hintergrund nach Timeout, Standard 10000)
- `background` (sofortiger Hintergrund)
- `timeout` (Sekunden; beendet den Prozess bei Überschreitung, Standard 1800)
- `elevated` (Bool; auf dem Host ausführen, wenn erhöhter Modus aktiviert/erlaubt ist; ändert das Verhalten nur, wenn der Agent sandboxed ist)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (Node-ID/-Name für `host=node`)
- Benötigen Sie ein echtes TTY? Setzen Sie `pty: true`.

Hinweise:

- Gibt `status: "running"` mit einer `sessionId` zurück, wenn im Hintergrund.
- Verwenden Sie `process`, um Hintergrund-Sitzungen abzufragen/protokollieren/schreiben/beenden/leeren.
- Wenn `process` nicht erlaubt ist, läuft `exec` synchron und ignoriert `yieldMs`/`background`.
- `elevated` ist durch `tools.elevated` plus einen `agents.list[].tools.elevated`-Override geschützt (beide müssen erlauben) und ist ein Alias für `host=gateway` + `security=full`.
- `elevated` ändert das Verhalten nur, wenn der Agent sandboxed ist (sonst No-op).
- `host=node` kann eine macOS-Companion-App oder einen headless Node-Host adressieren (`openclaw node run`).
- Gateway-/Node-Freigaben und Allowlists: [Exec approvals](/tools/exec-approvals).

### `process`

Verwalten von Hintergrund-Exec Sitzungen.

Kernaktionen:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Hinweise:

- `poll` gibt neue Ausgabe und Exit-Status zurück, wenn abgeschlossen.
- `log` unterstützt zeilenbasierte `offset`/`limit` (lassen Sie `offset` weg, um die letzten N Zeilen zu erhalten).
- `process` ist pro Agent begrenzt; Sitzungen anderer Agenten sind nicht sichtbar.

### `web_search`

Websuche mit der Brave Search API.

Kernparameter:

- `query` (erforderlich)
- `count` (1–10; Standard aus `tools.web.search.maxResults`)

Hinweise:

- Erfordert einen Brave-API-Schlüssel (empfohlen: `openclaw configure --section web`, oder setzen Sie `BRAVE_API_KEY`).
- Aktivieren über `tools.web.search.enabled`.
- Antworten werden gecacht (Standard 15 Min.).
- Siehe [Web tools](/tools/web) für die Einrichtung.

### `web_fetch`

Inhalte von einer URL abrufen und lesbar extrahieren (HTML → Markdown/Text).

Kernparameter:

- `url` (erforderlich)
- `extractMode` (`markdown` | `text`)
- `maxChars` (lange Seiten kürzen)

Hinweise:

- Aktivieren über `tools.web.fetch.enabled`.
- `maxChars` wird durch `tools.web.fetch.maxCharsCap` begrenzt (Standard 50000).
- Antworten werden gecacht (Standard 15 Min.).
- Für JS-lastige Seiten bevorzugen Sie das Browser-Werkzeug.
- Siehe [Web tools](/tools/web) für die Einrichtung.
- Siehe [Firecrawl](/tools/firecrawl) für das optionale Anti-Bot-Fallback.

### `browser`

Den dedizierten, von OpenClaw verwalteten Browser steuern.

Kernaktionen:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (liefert Image-Block + `MEDIA:<path>`)
- `act` (UI-Aktionen: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Profilverwaltung:

- `profiles` — alle Browser-Profile mit Status auflisten
- `create-profile` — neues Profil mit automatisch zugewiesenem Port erstellen (oder `cdpUrl`)
- `delete-profile` — Browser stoppen, Benutzerdaten löschen, aus der Konfiguration entfernen (nur lokal)
- `reset-profile` — verwaisten Prozess auf dem Port des Profils beenden (nur lokal)

Gemeinsame Parameter:

- `profile` (optional; Standard `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optional; wählt eine spezifische Node-ID/-Name)
  Hinweise:
- Erfordert `browser.enabled=true` (Standard `true`; setzen Sie `false`, um zu deaktivieren).
- Alle Aktionen akzeptieren den optionalen Parameter `profile` für Multi-Instanz-Unterstützung.
- Wenn `profile` fehlt, wird `browser.defaultProfile` verwendet (Standard „chrome“).
- Profilnamen: nur Kleinbuchstaben, alphanumerisch + Bindestriche (max. 64 Zeichen).
- Portbereich: 18800–18899 (~100 Profile max.).
- Remote-Profile sind nur „attach-only“ (kein Start/Stopp/Reset).
- Wenn eine browserfähige Node verbunden ist, kann das Werkzeug automatisch dorthin routen (außer Sie fixieren `target`).
- `snapshot` verwendet standardmäßig `ai`, wenn Playwright installiert ist; verwenden Sie `aria` für den Accessibility-Tree.
- `snapshot` unterstützt auch Role-Snapshot-Optionen (`interactive`, `compact`, `depth`, `selector`), die Refs wie `e12` zurückgeben.
- `act` erfordert `ref` aus `snapshot` (numerische `12` aus AI-Snapshots oder `e12` aus Role-Snapshots); verwenden Sie `evaluate` für seltene CSS-Selektor-Fälle.
- Vermeiden Sie standardmäßig `act` → `wait`; nur in Ausnahmefällen verwenden (keine verlässliche UI-State, auf die gewartet werden kann).
- `upload` kann optional eine `ref` übergeben, um nach dem Scharfstellen automatisch zu klicken.
- `upload` unterstützt auch `inputRef` (aria ref) oder `element` (CSS-Selektor), um `<input type="file">` direkt zu setzen.

### `canvas`

Das Node-Canvas steuern (present, eval, snapshot, A2UI).

Kernaktionen:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (liefert Image-Block + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Hinweise:

- Verwendet unter der Haube Gateway-`node.invoke`.
- Wenn kein `node` angegeben ist, wählt das Werkzeug einen Standard (einzelne verbundene Node oder lokaler Mac-Node).
- A2UI ist nur v0.8 (kein `createSurface`); die CLI lehnt v0.9-JSONL mit Zeilenfehlern ab.
- Schneller Smoke-Test: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Gekoppelte Nodes entdecken und adressieren; Benachrichtigungen senden; Kamera/Bildschirm erfassen.

Kernaktionen:

- `status`, `describe`
- `pending`, `approve`, `reject` (Pairing)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Hinweise:

- Kamera-/Bildschirmbefehle erfordern, dass die Node-App im Vordergrund ist.
- Bilder liefern Image-Blöcke + `MEDIA:<path>`.
- Videos liefern `FILE:<path>` (mp4).
- Standort liefert ein JSON-Payload (lat/lon/accuracy/timestamp).
- `run`-Parameter: `command` argv-Array; optional `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Beispiel (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Ein Bild mit dem konfigurierten Bildmodell analysieren.

Kernparameter:

- `image` (erforderlicher Pfad oder URL)
- `prompt` (optional; Standard „Describe the image.“)
- `model` (optionaler Override)
- `maxBytesMb` (optionale Größenbegrenzung)

Hinweise:

- Nur verfügbar, wenn `agents.defaults.imageModel` konfiguriert ist (primär oder Fallbacks) oder wenn ein implizites Bildmodell aus Ihrem Standardmodell + konfigurierter Auth abgeleitet werden kann (Best-Effort-Paarung).
- Verwendet das Bildmodell direkt (unabhängig vom Haupt-Chatmodell).

### `message`

Nachrichten und Kanalaktionen über Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams senden.

Kernaktionen:

- `send` (Text + optionale Medien; MS Teams unterstützt zusätzlich `card` für Adaptive Cards)
- `poll` (WhatsApp/Discord/MS-Teams-Umfragen)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Hinweise:

- `send` routet WhatsApp über das Gateway; andere Kanäle gehen direkt.
- `poll` verwendet das Gateway für WhatsApp und MS Teams; Discord-Umfragen gehen direkt.
- Wenn ein Nachrichten-Werkzeugaufruf an eine aktive Chat-Sitzung gebunden ist, sind Sendungen auf das Ziel dieser Sitzung beschränkt, um Kontext-Leaks zu vermeiden.

### `cron`

Gateway-Cron-Jobs und Wakeups verwalten.

Kernaktionen:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (Systemereignis einreihen + optionaler sofortiger Heartbeat)

Hinweise:

- `add` erwartet ein vollständiges Cron-Job-Objekt (gleiches Schema wie `cron.add` RPC).
- `update` verwendet `{ jobId, patch }` (`id` wird aus Kompatibilitätsgründen akzeptiert).

### `gateway`

Den laufenden Gateway-Prozess neu starten oder Updates anwenden (in-place).

Kernaktionen:

- `restart` (autorisiert + sendet `SIGUSR1` für In-Process-Restart; `openclaw gateway` Neustart in-place)
- `config.get` / `config.schema`
- `config.apply` (validieren + Konfiguration schreiben + Neustart + Wake)
- `config.patch` (partielles Update zusammenführen + Neustart + Wake)
- `update.run` (Update ausführen + Neustart + Wake)

Hinweise:

- Verwenden Sie `delayMs` (Standard 2000), um eine laufende Antwort nicht zu unterbrechen.
- `restart` ist standardmäßig deaktiviert; aktivieren Sie es mit `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Sitzungen auflisten, Transkriptverlauf prüfen oder an eine andere Sitzung senden.

Kernparameter:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = keine)
- `sessions_history`: `sessionKey` (oder `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (oder `sessionId`), `message`, `timeoutSeconds?` (0 = Fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (Standard aktuell; akzeptiert `sessionId`), `model?` (`default` löscht den Override)

Hinweise:

- `main` ist der kanonische Direkt-Chat-Schlüssel; global/unbekannt sind ausgeblendet.
- `messageLimit > 0` ruft die letzten N Nachrichten pro Sitzung ab (Werkzeugnachrichten gefiltert).
- `sessions_send` wartet auf den finalen Abschluss, wenn `timeoutSeconds > 0`.
- Zustellung/Ankündigung erfolgt nach Abschluss und ist Best-Effort; `status: "ok"` bestätigt, dass der Agentenlauf beendet ist, nicht dass die Ankündigung zugestellt wurde.
- `sessions_spawn` startet einen Sub-Agent-Lauf und postet eine Ankündigungsantwort zurück in den anfragenden Chat.
- `sessions_spawn` ist nicht blockierend und gibt sofort `status: "accepted"` zurück.
- `sessions_send` führt ein Reply-back-Pingpong aus (Antwort `REPLY_SKIP`, um zu stoppen; max. Züge über `session.agentToAgent.maxPingPongTurns`, 0–5).
- Nach dem Pingpong führt der Ziel-Agent einen **Ankündigungsschritt** aus; antworten Sie mit `ANNOUNCE_SKIP`, um die Ankündigung zu unterdrücken.

### `agents_list`

Agent-IDs auflisten, die die aktuelle Sitzung mit `sessions_spawn` adressieren darf.

Hinweise:

- Das Ergebnis ist auf Pro-Agent-Allowlists beschränkt (`agents.list[].subagents.allowAgents`).
- Wenn `["*"]` konfiguriert ist, enthält das Werkzeug alle konfigurierten Agenten und markiert `allowAny: true`.

## Parameter (gemeinsam)

Gateway-gestützte Werkzeuge (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (Standard `ws://127.0.0.1:18789`)
- `gatewayToken` (falls Auth aktiviert)
- `timeoutMs`

Hinweis: Wenn `gatewayUrl` gesetzt ist, geben Sie `gatewayToken` explizit an. Werkzeuge erben keine Konfiguration
oder Umgebungs-Credentials für Overrides; fehlende explizite Credentials sind ein Fehler.

Browser-Werkzeug:

- `profile` (optional; Standard `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (optional; spezifische Node-ID/-Name fixieren)

## Empfohlene Agentenabläufe

Browser-Automatisierung:

1. `browser` → `status` / `start`
2. `snapshot` (ai oder aria)
3. `act` (click/type/press)
4. `screenshot` bei Bedarf zur visuellen Bestätigung

Canvas-Rendern:

1. `canvas` → `present`
2. `a2ui_push` (optional)
3. `snapshot`

Node-Targeting:

1. `nodes` → `status`
2. `describe` auf der gewählten Node
3. `notify` / `run` / `camera_snap` / `screen_record`

## Sicherheit

- Vermeiden Sie direktes `system.run`; verwenden Sie `nodes` → `run` nur mit ausdrücklicher Zustimmung des Nutzers.
- Respektieren Sie die Zustimmung des Nutzers für Kamera-/Bildschirmaufnahmen.
- Verwenden Sie `status/describe`, um Berechtigungen sicherzustellen, bevor Medienbefehle aufgerufen werden.

## Wie Werkzeuge dem Agenten präsentiert werden

Werkzeuge werden in zwei parallelen Kanälen bereitgestellt:

1. **System-Prompt-Text**: eine menschenlesbare Liste + Anleitung.
2. **Werkzeug-Schema**: die strukturierten Funktionsdefinitionen, die an die Modell-API gesendet werden.

Das bedeutet, der Agent sieht sowohl „welche Werkzeuge existieren“ als auch „wie man sie aufruft“. Wenn ein Werkzeug
weder im System-Prompt noch im Schema erscheint, kann das Modell es nicht aufrufen.
