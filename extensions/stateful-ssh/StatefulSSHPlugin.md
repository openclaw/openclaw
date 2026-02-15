# StatefulSSHPlugin

## Tool-Architektur

### Übersicht

Stellen wir uns das Plugin als eine Art „Garderobe“ vor: Der Agent bekommt nicht einfach nur einen Schlüssel (Passwort), sondern einen eigenen Schrank (Session-Objekt), in dem alles so bleibt, wie er es hinterlassen hat.

Hier ist ein Entwurf, wie wir diese Architektur sinnvoll aufbauen:

Die Architektur des Plugins
Das Plugin besteht aus zwei Teilen:

Der Session-Manager (Backend): Ein unsichtbares Objekt im Hintergrund, das die Verbindungen am Leben hält.

Die Tool-Schnittstellen (Frontend): Drei Funktionen, die der KI zur Verfügung gestellt werden.

### Architektur

1. Der Session-Manager (Das "Gedächtnis" für Verbindungen)
   In OpenClaw (oder jedem Python-basierten Agenten-Framework) werden Tools normalerweise als Funktionen definiert. Damit eine Session über mehrere Tool-Aufrufe hinweg bestehen bleibt, darf das SSH-Objekt nicht innerhalb der Funktion erzeugt und gelöscht werden.

Du benötigst eine globale Registry oder eine Singleton-Klasse innerhalb deines Tool-Moduls:

Python

# Pseudo-Code für die Tool-Logik

class SSHSessionRegistry:
def **init**(self):
self.active_sessions = {} # Speichert { "session_id": ssh_object }

    def open_ssh_session(self, session_id, connection):
        self.active_sessions[session_id] = connection

    def get_session(self, session_id):
        return self.active_sessions.get(session_id)

    def remove_session(self, session_id):
        if session_id in self.active_sessions:
            self.active_sessions[session_id].close()
            del self.active_sessions[session_id]

# Instanz, die während der Laufzeit von OpenClaw existiert

registry = SSHSessionRegistry() 2. Die Tool-Schnittstellen für die KI
Du definierst drei spezifische Tools für die KI. Damit die KI weiß, welche Session sie gerade nutzt, muss sie mit einer session_id arbeiten.

Tool A: open_ssh_session(host, user, password/key)
Logik: Erstellt eine Verbindung mit pexpect oder Paramiko(invoke_shell).

Rückgabe: Eine session_id (z. B. "server_1") und die Bestätigung, dass die Shell bereit ist.

Wichtig: Die KI muss instruiert werden, sich diese ID zu merken.

Tool B: execute_ssh_command(session_id, command)
Logik: Holt das Objekt aus der registry. Sendet den Befehl an den stdin. Wartet, bis der Shell-Prompt (z. B. $) wieder im stdout erscheint.

Vorteil: Verzeichniswechsel (cd) und Umgebungsvariablen bleiben erhalten, da der Prozess im Hintergrund weiterläuft.

Tool C: close_ssh_session(session_id)
Logik: Schließt den Kanal und entfernt die ID aus der registry.

3. Integration in den "Denkprozess" der KI
   Damit das Ganze funktioniert, braucht die KI im System Prompt eine klare Anweisung:

"Wenn du auf einem Server arbeitest, öffne zuerst eine Session mit open_ssh_session. Nutze die erhaltene Session-ID für alle folgenden Befehle. Wenn deine Aufgabe erledigt ist, schließe die Session zwingend mit close_ssh_session, um Ressourcen freizugeben."

4. Das Problem der "verwaisten" Sessions lösen
   KIs vergessen manchmal, aufzuräumen (besonders wenn sie in einen Fehler laufen). In die Integration in OpenClaw solltest du daher Sicherheitsmechanismen einbauen:

Timeout: Wenn eine Session 10 Minuten lang nicht genutzt wurde, schließt die registry sie automatisch (Garbage Collection).

Auto-Cleanup: Beim Beenden des OpenClaw-Prozesses müssen alle aktiven Sessions in active_sessions geschlossen werden.

Session-Limit: Begrenze die Anzahl der gleichzeitigen Sessions (z. B. max. 3), damit der Bot nicht unendlich viele Shells öffnet.

## Code-Vorschlag

Ein konkreter Code-Vorschlag (Scaffold)
Hier ist ein Entwurf für ein solches Modul (nennen wir es stateful_ssh.py), das du als Plugin integrieren kannst.
Ich verwende hier pexpect, da es für "interaktive" Sessions (Warten auf Prompts) deutlich zuverlässiger ist als reines Paramiko.

Python
import pexpect
import uuid

class SSHPlugin:
def **init**(self):

# Hier werden die aktiven Sessions gespeichert: {session_id: pexpect_spawn_object}

self.\_sessions = {}

    def open_ssh_session(self, host, user, password=None):
        """Baut eine persistente Verbindung auf."""
        session_id = str(uuid.uuid4())[:8]
        ssh_command = f"ssh -o StrictHostKeyChecking=no {user}@{host}"

        child = pexpect.spawn(ssh_command, encoding='utf-8', timeout=30)

        # Einfaches Handling für Passwortabfrage
        i = child.expect(['[Pp]assword:', r'(\$|#|>|~)\s*'])
        if i == 0:
            child.sendline(password)
            child.expect(r'(\$|#|>|~)\s*') # Warte auf den Prompt nach Login

        self._sessions[session_id] = child
        return session_id, "Verbindung hergestellt. Prompt erkannt."

    def execute_ssh_command(self, session_id, command):
        """Führt einen Befehl in einer bestehenden Session aus."""
        if session_id not in self._sessions:
            return "Fehler: Session-ID nicht gefunden."

        child = self._sessions[session_id]
        child.sendline(command)

        # Das Herzstück: Wir warten, bis der Prompt wieder erscheint
        # Das signalisiert, dass der Befehl fertig ist.
        child.expect(r'(\$|#|>|~)\s*')

        # Wir geben den Output zurück (ohne den Befehl selbst zu wiederholen)
        return child.before.strip()

    def close_ssh_session(self, session_id):
        """Schließt die Session sauber."""
        if session_id in self._sessions:
            self._sessions[session_id].close()
            del self._sessions[session_id]
            return f"Session {session_id} erfolgreich geschlossen."
        return "Session nicht gefunden."

# Instanz für das Plugin

ssh_manager = SSHPlugin()
Die Integration in OpenClaw
In OpenClaw (oder ähnlichen Frameworks) registrierst du diese Funktionen als Tools. Damit die KI sie korrekt nutzt, ist die Beschreibung (Docstring) entscheidend:

open_ssh_session: "Öffnet eine persistente SSH-Verbindung. Gibt eine session_id zurück. Nutze dies, wenn du mehrere Befehle nacheinander auf demselben Server ausführen willst (z.B. Navigieren, Bearbeiten)."

execute_ssh_command: "Führt einen Befehl in einer offenen Session aus. Der Kontext (Verzeichnis, Variablen) bleibt erhalten."

close_ssh_session: "Beendet die Session. Muss aufgerufen werden, wenn die Arbeit auf dem Server beendet ist, um Ressourcen zu sparen."

Vorteile dieses Plugin-Designs:
Ressourcenschonend: Das Plugin kann einen automatischen Timer (Cleanup-Thread) haben, der Sessions nach X Minuten Inaktivität hart beendet, falls die KI es vergisst.

Multi-Tasking: Die KI könnte theoretisch zwei Sessions zu zwei verschiedenen Servern gleichzeitig offen halten und Daten dazwischen hin- und herschieben.

Sicherheit: Du kannst im Plugin Filter einbauen, die gefährliche Befehle (rm -rf /) blockieren, bevor sie überhaupt an SSH gesendet werden.

## Implementierungsstatus

### ✅ IMPLEMENTIERT (TypeScript)

Das Plugin wurde vollständig in TypeScript für OpenClaw implementiert. Die ursprünglich geplante Python/pexpect-Architektur wurde auf Node.js/TypeScript mit der `ssh2`-Library portiert.

### Dateistruktur

```
extensions/stateful-ssh/
├── index.ts                      # Plugin-Registrierung
├── package.json                  # Abhängigkeiten (ssh2)
├── openclaw.plugin.json          # Plugin-Konfiguration
├── src/
│   ├── session-manager.ts        # SSHSessionManager-Klasse
│   └── ssh-tools.ts             # Tool-Definitionen
└── StatefulSSHPlugin.md         # Diese Dokumentation
```

### Implementierte Tools

1. **open_ssh_session**
   - Öffnet eine persistente SSH-Verbindung
   - Unterstützt Passwort- und Private-Key-Authentifizierung
   - Gibt eine `session_id` zurück (8-stellige UUID)
   - Wartet auf Shell-Prompt bevor die Session als "ready" gilt

2. **execute_ssh_command**
   - Führt Befehle in einer bestehenden Session aus
   - Erhält den Kontext (Verzeichnis, Umgebungsvariablen)
   - Wartet auf Shell-Prompt zur Erkennung des Befehls-Endes
   - Filtert Command-Echo und Prompt aus der Ausgabe
   - Akzeptiert einen optionalen `timeout_ms` Parameter, um das Standard-Timeout zu überschreiben

3. **close_ssh_session**
   - Schließt eine Session sauber
   - Entfernt die Session aus der Registry
   - Sollte IMMER aufgerufen werden, wenn die Arbeit beendet ist

4. **list_ssh_sessions** (Bonus)
   - Listet alle aktiven Sessions auf
   - Zeigt Host, Username und letzte Aktivität
   - Hilfreich zum Debuggen und Session-Management

### Konfiguration

Das Plugin kann über `openclaw.plugin.json` konfiguriert werden:

```json
{
  "maxSessions": 5, // Max. gleichzeitige Sessions (Default: 5)
  "sessionTimeoutMs": 600000, // Idle-Timeout in ms (Default: 10 Min)
  "commandTimeoutMs": 300000 // Command-Timeout in ms (Default: 5 Min)
}
```

### Sicherheitsmechanismen

✅ **Session-Limit**: Maximal 5 gleichzeitige Sessions (konfigurierbar)
✅ **Idle-Timeout**: Sessions werden nach 10 Minuten Inaktivität automatisch geschlossen
✅ **Auto-Cleanup**: Bei Prozessbeendigung (SIGINT/SIGTERM) werden alle Sessions geschlossen
✅ **Command-Timeout**: Befehle haben ein Timeout von 5 Minuten, das pro Befehl überschrieben werden kann
✅ **Sandbox-Mode**: Tools sind in sandboxed Kontexten deaktiviert

### Technische Details

**SSH-Library**: `ssh2` (Node.js)

- Robuste, weit verbreitete SSH-Implementierung
- Unterstützt Shell-Sessions mit Streaming
- Unterstützt verschiedene Authentifizierungsmethoden

**Prompt-Erkennung**: RegExp `/[\$#>]\s*$/`

- Erkennt gängige Shell-Prompts ($, #, >)
- Signalisiert, dass ein Befehl abgeschlossen ist

**Session-ID**: 8-stellige UUID

- Kurz genug für die KI zum Merken
- Eindeutig genug für praktische Nutzung

### Nutzungshinweise für die KI

**System-Prompt-Ergänzung**:

"Wenn du auf einem Remote-Server arbeiten musst, nutze die SSH-Tools in dieser Reihenfolge:

1. **open_ssh_session**: Öffne eine Session und MERKE DIR die session_id
2. **execute_ssh_command**: Führe alle benötigten Befehle aus (cd, ls, etc.)
3. **close_ssh_session**: Schließe die Session IMMER am Ende

Die Session behält ihren Zustand bei (Verzeichnis, Umgebungsvariablen). Du kannst `cd` verwenden und der nächste Befehl wird im neuen Verzeichnis ausgeführt.

WICHTIG: Vergiss nicht, die Session zu schließen!"

### TODO

- [ ] Unit-Tests schreiben
- [ ] Integration-Tests mit echtem SSH-Server
- [ ] Error-Handling für Netzwerk-Timeouts verbessern
- [ ] Optionale Command-Blacklist implementieren (rm -rf / etc.)
- [ ] Reconnect-Logik bei Verbindungsabbruch
- [ ] Custom Prompt-Pattern pro Session

### DONE

- [x] Session-Manager implementiert
- [x] Alle 4 Tools implementiert
- [x] Plugin-Registrierung erstellt
- [x] Konfiguration über openclaw.plugin.json
- [x] Auto-Cleanup bei Prozessbeendigung
- [x] Idle-Session-Cleanup
- [x] Session-Limit
- [x] TypeScript-Typisierung
- [x] Dokumentation aktualisiert

---

_Letzte Aktualisierung: 2026-02-11_
