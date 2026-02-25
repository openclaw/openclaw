# Plan: Setup Wizard Web Dashboard Erweiterung

## Übersicht

Erweiterung des bestehenden Wizard-Systems um einen vollständigen 7-Schritt-Onboarding-Wizard, der im Web-Dashboard als Full-Screen Overlay läuft.

## Aktueller Stand

- **CLI Wizard**: `src/wizard/onboarding.ts` - Terminal-basierter Wizard
- **Gateway Wizard API**: `src/gateway/server-methods/wizard.ts` - WebSocket-basierte Wizard-Methods
- **Wizard Session**: `src/wizard/session.ts` - Session-Management für Wizard-Flows
- **Control UI**: `ui/src/ui/app.ts` - Lit-basierte Web-UI
- **Onboarding Flag**: Bereits vorhanden (`state.onboarding`)

## Geplante Erweiterungen

### 1. Wizard-UI-Komponente (Frontend)

**Datei:** `ui/src/ui/views/onboarding-wizard.ts`

**Funktionalität:**
- Full-Screen Overlay mit dunklem Hintergrund
- Progress-Bar oben (7 Dots/Stepper)
- Schritt-Navigation (Zurück/Weiter Buttons)
- Schritt-spezifische UI-Komponenten

**Schritte:**

**Schritt 1 - Willkommen:**
- Activi Logo groß zentriert (Placeholder-Logo verwenden)
- "Willkommen bei Activi" Headline
- "Dein AI-Agent Command Center" Untertitel
- Button: "Einrichtung starten"

**Schritt 2 - AI Model / API Key:**
- Dropdown: Anthropic (empfohlen), OpenAI, Custom Provider
- Input-Feld für API Key (Show/Hide Toggle)
- Auto-Detection ob Key gültig ist (grüner Haken / roter Fehler)
- Info-Text: "Dein Key bleibt lokal, wird nie übertragen"

**Schritt 3 - Workspace:**
- Pfad-Auswahl für Arbeitsordner
- Default: `~/.activi/workspace` (Branding: Activi)
- Browse-Button oder manueller Pfad
- Info-Text: "Hier speichert Activi Sessions, Configs und Agent-Daten"

**Schritt 4 - Gateway Konfiguration:**
- Port (Default: 18789)
- Bind: Loopback (nur lokal) / LAN / Tailscale
- Auth: Token (auto-generiert) oder Passwort
- Toggle: "Remote-Zugriff erlauben" (aus = sicherer Default)

**Schritt 5 - Channels verbinden:**
- Karten-Layout, je eine Karte pro Channel
- WhatsApp (QR-Code Scan), Telegram (Bot Token), Discord (Bot Token), Slack (OAuth), Signal, iMessage, etc.
- Jede Karte: Icon + Name + "Verbinden" Button + Status-Badge
- Optional: "Später einrichten" Link

**Schritt 6 - Team / Agents:**
- **Modus-Auswahl** (Radio-Buttons oder Tabs):
  - **Einzel-Agent-Modus**: Ein Agent wird erstellt/konfiguriert
  - **Team-Modus**: Mehrere Agents werden erstellt + Master-Admin-Setup
- **Bei Team-Modus:**
  - **Master-Admin-Setup:**
    - Info-Box: "Du wirst als Master-Admin eingerichtet"
    - "Master-Admin hat dauerhaft volle Kontrolle über das Team via Web UI"
    - Gateway-Token wird als Master-Admin-Token gespeichert
    - `operator.admin` + `operator.pairing` Scopes werden zugewiesen
  - **Agent-Anzahl:**
    - Input-Feld: "Wie viele Agents?" (Zahl, z.B. 3, 5, 10)
    - Validierung: Min 2, Max z.B. 20
    - Info-Text: "Activi erstellt automatisch Placeholder-Agents"
  - **Unter-User-Setup:**
    - Checkbox: "Unter-User-Verwaltung aktivieren"
    - Info: "Du kannst später weitere User/Agents über das Web UI hinzufügen"
- **Agent-Erstellung:**
  - **Einzel-Agent**: Name-Eingabe, Workspace-Pfad, Model-Auswahl
  - **Team-Modus**: Automatische Erstellung von Placeholder-Agents
    - Format: `agent-1`, `agent-2`, `agent-3`, etc.
    - Workspace: `~/.activi/workspace/agent-1`, etc.
    - Standard-Model aus Schritt 2 verwenden
    - Jeder Agent erhält eingeschränkte Permissions (kein Admin)
- **Nach Erstellung:**
  - Übersicht der erstellten Agents als Karten-Grid
  - Avatar-Placeholder + Name + Status
  - Master-Admin-Badge beim aktuellen User
  - Toggle: Aktiv/Inaktiv (optional)
  - Button: "Weitere Agents hinzufügen" (nur für Master-Admin)

**Schritt 7 - Fertig:**
- Zusammenfassung aller Einstellungen als kompakte Liste
- Buttons: "Dashboard öffnen" / "Terminal nutzen"
- Confetti-Animation oder dezenter Erfolgs-Indikator
- "Activi ist bereit."

### 2. Wizard-Controller (Frontend)

**Datei:** `ui/src/ui/controllers/onboarding-wizard.ts`

**Funktionalität:**
- Wizard-State-Management
- Gateway-WebSocket-Integration (`wizard.start`, `wizard.next`, `wizard.cancel`)
- Schritt-Validierung
- API-Key-Validierung
- Channel-Setup-Integration
- Master-Admin-Setup (Gateway-Token mit Admin-Scopes)
- Team-Agent-Erstellung (Loop über Anzahl)

### 3. Wizard-Steps (Backend)

**Erweiterung:** `src/wizard/onboarding.ts`

**Neue Wizard-Steps:**
- `welcome` - Willkommens-Schritt
- `ai-model` - AI Model/API Key Auswahl
- `workspace` - Workspace-Pfad-Auswahl
- `gateway-config` - Gateway-Konfiguration
- `channels` - Channel-Verbindung
- `agent-mode` - Agent-Modus-Auswahl (Einzel vs Team)
- `agent-single` - Einzel-Agent-Konfiguration (Name, Workspace, Model)
- `agent-team` - Team-Modus (Anzahl-Eingabe, Placeholder-Erstellung)
- `agents-overview` - Übersicht erstellter Agents
- `complete` - Abschluss-Schritt

### 4. Wizard-Step-Types (Backend)

**Erweiterung:** `src/gateway/protocol/schema/wizard.ts`

**Neue Step-Types:**
- `welcome` - Willkommens-Schritt mit Logo
- `api-key` - API-Key-Input mit Validierung
- `workspace-path` - Pfad-Auswahl
- `gateway-config` - Gateway-Konfiguration
- `channel-cards` - Channel-Karten-Layout
- `agent-mode-select` - Agent-Modus-Auswahl (Einzel vs Team)
- `agent-single-form` - Einzel-Agent-Formular (Name, Workspace, Model)
- `agent-team-count` - Team-Anzahl-Eingabe
- `agent-grid` - Agent-Grid-Layout (Übersicht)
- `summary` - Zusammenfassung

### 5. Integration in Control UI

**Datei:** `ui/src/ui/app-render.ts`

**Änderungen:**
- Onboarding-Wizard-Overlay rendern wenn `state.onboarding === true`
- Wizard-Overlay über alles andere legen (z-index)
- Wizard-State aus Gateway-Wizard-Session laden

**Datei:** `ui/src/ui/app.ts`

**Änderungen:**
- Wizard-State-Management hinzufügen
- Wizard-Controller integrieren
- Onboarding-Mode-Detection erweitern

### 6. Styling

**Datei:** `ui/src/ui/styles/onboarding-wizard.css` (neu)

**Styling:**
- Full-Screen Overlay (dunkler Hintergrund)
- Wizard-Card (helle Karte, zentriert)
- Progress-Bar (7 Dots/Stepper)
- Schritt-Icons
- Channel-Karten-Layout
- Agent-Grid-Layout
- Confetti-Animation (optional)

## Implementierungs-Schritte

1. **Wizard-Step-Types erweitern** (`src/gateway/protocol/schema/wizard.ts`)
   - Neue Step-Types hinzufügen
   - Schema für API-Key-Validierung
   - Schema für Channel-Cards
   - Schema für Agent-Grid

2. **Wizard-Backend erweitern** (`src/wizard/onboarding.ts`)
   - Neue Wizard-Steps implementieren
   - API-Key-Validierung hinzufügen
   - Workspace-Pfad-Validierung
   - Gateway-Config-Steps
   - Channel-Setup-Integration
   - Agent-Modus-Auswahl (Einzel vs Team)
   - Einzel-Agent-Erstellung (`agents.create` API nutzen)
   - Team-Modus: Master-Admin-Setup
     - Gateway-Token mit `operator.admin` + `operator.pairing` Scopes
     - Token in Config speichern (`gateway.auth.token`)
     - Master-Admin-Flag setzen (für späteres Team-Management)
   - Team-Modus: Placeholder-Agents erstellen
     - Loop über Anzahl
     - `agents.create` für jeden Agent aufrufen
     - Format: `agent-1`, `agent-2`, etc.
     - Workspace: `{workspaceDir}/agent-{n}`
     - Standard-Model verwenden
     - Eingeschränkte Permissions (kein Admin-Scope)

3. **Wizard-UI-Komponente erstellen** (`ui/src/ui/views/onboarding-wizard.ts`)
   - Full-Screen Overlay
   - Progress-Bar
   - Schritt-Rendering
   - Navigation (Zurück/Weiter)

4. **Wizard-Controller erstellen** (`ui/src/ui/controllers/onboarding-wizard.ts`)
   - Gateway-WebSocket-Integration
   - State-Management
   - Schritt-Validierung
   - API-Key-Validierung

5. **Control UI Integration** (`ui/src/ui/app-render.ts`, `ui/src/ui/app.ts`)
   - Wizard-Overlay rendern
   - Wizard-State integrieren
   - Onboarding-Mode-Detection

6. **Styling** (`ui/src/ui/styles/onboarding-wizard.css`)
   - Full-Screen Overlay
   - Wizard-Card
   - Progress-Bar
   - Channel-Karten
   - Agent-Grid

7. **Testing**
   - Wizard-Flow testen
   - API-Key-Validierung testen
   - Channel-Setup testen
   - Agent-Config testen

## Dateien

**Backend:**
- `src/wizard/onboarding.ts` - Wizard-Logik erweitern
- `src/gateway/protocol/schema/wizard.ts` - Step-Types erweitern
- `src/wizard/session.ts` - Session-Management (bereits vorhanden)

**Frontend:**
- `ui/src/ui/views/onboarding-wizard.ts` - **NEU** - Wizard-UI-Komponente
- `ui/src/ui/controllers/onboarding-wizard.ts` - **NEU** - Wizard-Controller
- `ui/src/ui/app-render.ts` - Wizard-Overlay integrieren
- `ui/src/ui/app.ts` - Wizard-State integrieren
- `ui/src/ui/styles/onboarding-wizard.css` - **NEU** - Wizard-Styling

## Abhängigkeiten

- Gateway WebSocket API (`wizard.start`, `wizard.next`, `wizard.cancel`)
- Channel-Plugin-System für Channel-Setup
- Agent-Config-System für Agent-Setup
- Config-System für Gateway-Konfiguration
- Gateway Role/Scope-System (`operator.admin`, `operator.pairing`)
- Device-Pairing-System für Unter-User-Verwaltung

## Team-Management (Post-Wizard)

**Nach Wizard-Abschluss im Web UI:**

### Team-Management-Ansicht (NEU)

**Datei:** `ui/src/ui/views/team-management.ts` (NEU)

**Funktionalität:**
- **Master-Admin-Dashboard:**
  - Übersicht aller Team-Mitglieder (Agents + User)
  - Master-Admin-Badge beim aktuellen User
  - Status-Anzeige (Online/Offline)
- **Unter-User-Verwaltung:**
  - Button: "Unter-User hinzufügen"
  - Formular: Name, Email (optional), Permissions
  - Device-Pairing für neue User
  - Token-Generierung für Unter-User
- **Agent-Verwaltung:**
  - Liste aller Agents im Team
  - Agent hinzufügen/bearbeiten/löschen
  - Permissions pro Agent setzen
  - Workspace-Verwaltung
- **Permissions-Verwaltung:**
  - Scope-Verwaltung (`operator.read`, `operator.write`, `operator.admin`)
  - Agent-spezifische Permissions
  - Bulk-Aktionen (Permissions für mehrere Agents setzen)

### Gateway-API-Erweiterungen

**Neue Methods (Backend):**
- `team.members.list` - Liste aller Team-Mitglieder
- `team.member.add` - Unter-User hinzufügen
- `team.member.remove` - Unter-User entfernen
- `team.member.update` - Permissions aktualisieren
- `team.agents.list` - Liste aller Team-Agents
- `team.agents.add` - Agent zum Team hinzufügen
- `team.agents.remove` - Agent aus Team entfernen

**Dateien:**
- `src/gateway/server-methods/team.ts` - **NEU** - Team-Management-Handlers
- `src/gateway/protocol/schema/team.ts` - **NEU** - Team-Schemas

## Entscheidungen

1. **Branding**: ✅ **"Activi"** (nicht Activi)
2. **Logo**: Placeholder-Logo verwenden (später durch echtes Activi-Logo ersetzen)
3. **Workspace-Pfad**: ✅ `~/.activi/workspace` (Activi-Branding)
4. **Agent-Erstellung**: 
   - Einzel-Agent: Manuelle Eingabe (Name, Workspace, Model)
   - Team-Modus: Automatische Placeholder-Erstellung (`agent-1`, `agent-2`, etc.)
   - Nutzt bestehende `agents.create` Gateway-API
5. **Master-Admin**: ✅ **Wichtig**
   - Wizard-Ersteller wird automatisch Master-Admin
   - Gateway-Token erhält `operator.admin` + `operator.pairing` Scopes
   - Dauerhafte Kontrolle über Team via Web UI
   - Kann Unter-User und weitere Agents hinzufügen
6. **Team-Management**: ✅ **Post-Wizard**
   - Team-Management-Ansicht im Web UI
   - Unter-User-Verwaltung über Web UI
   - Permissions-Verwaltung für Team-Mitglieder
   - Nutzt Device-Pairing-System für neue User

## Nächste Schritte

1. Offene Fragen klären (Branding, Logo, Agents)
2. Wizard-Step-Types erweitern
3. Wizard-Backend erweitern
4. Wizard-UI-Komponente erstellen
5. Integration in Control UI
6. Styling hinzufügen
7. Testing
