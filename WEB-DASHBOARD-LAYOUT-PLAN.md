# Plan: Web Dashboard Drei-Spalten-Layout

## Übersicht

Umgestaltung des Control UI zu einem Drei-Spalten-Layout mit:
- **Sidebar (links, ~240px)**: Navigation + Agent-Liste + Gateway-Status
- **Hauptbereich (mitte)**: Content-Area mit verschiedenen Ansichten
- **Rechtes Panel (optional, ~300px, klappbar)**: Details, Config, Actions

## Aktueller Stand

- **Layout**: Zwei-Spalten (Sidebar + Content)
- **Sidebar**: Navigation mit Tab-Gruppen, kollabierbar
- **Content**: Verschiedene Views (Chat, Agents, Channels, etc.)
- **Styling**: `ui/src/styles/layout.css`

## Geplante Erweiterungen

### 1. Sidebar Erweiterung (links)

**Aktuelle Struktur:**
- Header: Logo + Branding
- Navigation: Tab-Gruppen (chat, control, agent, settings)
- Footer: Docs-Link + Version

**Neue Struktur:**
- **Header**: Activi Logo (klein) + "Activi" Text
- **Navigation** (Icons + Labels):
  - Chat (Sprechblase) ✓ vorhanden
  - Agents (Personen-Gruppe) ✓ vorhanden
  - Broadcast (Megafon) **NEU**
  - Sessions (Liste) ✓ vorhanden
  - Cron Jobs (Uhr) ✓ vorhanden
  - Skills (Puzzle) ✓ vorhanden
  - Team Management (Shield/Users) **NEU** (nur für Master-Admin sichtbar)
  - Config (Zahnrad) ✓ vorhanden
  - Monitoring (Herz-Puls) **NEU**
- **Agent-Liste** (scrollbar, unterhalb der Nav): **NEU**
  - Jeder Agent: Avatar + Name + Status-Dot (grün=online, rot=offline)
  - Gruppiert nach Team mit klappbaren Headern
  - Aktuell ausgewählter Agent = hervorgehoben
- **Footer**: Gateway-Status (grüner/roter Dot + "Running" / "Stopped") **ERWEITERN**

### 2. Hauptbereich (mitte)

**Aktuelle Views:**
- Chat ✓
- Agents ✓
- Channels ✓
- Sessions ✓
- Cron ✓
- Skills ✓
- Config ✓
- Overview ✓
- Usage ✓
- Nodes ✓
- Debug ✓
- Logs ✓

**Neue Views:**

**Broadcast-Ansicht:**
- Gruppe auswählen (Dropdown oder Chips)
- Nachricht eingeben (großes Textfeld)
- Vorschau: Welche Agents empfangen
- Senden-Button
- Ergebnis-Tabelle: Agent | Antwort | Status | Dauer

**Team-Management-Ansicht** (nur für Master-Admin): **NEU**
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

**Monitoring-Ansicht:**
- Gateway Health: Uptime, PID, Port, Latenz
- Agent-Aktivität: Timeline/Graph der letzten Stunden
- Log-Viewer: Live-Tail mit Filter (Error, Warn, Info)
- Token-Verbrauch: Pro Agent und gesamt

**Verbesserte Views:**

**Chat-Ansicht:**
- Chat-Verlauf (Nachrichten-Bubbles):
  - User: rechts, helle Farbe ✓
  - Agent: links, dunklere Farbe + Agent-Avatar + Name ✓
  - Tool-Calls: klappbare Karten mit Code-Output ✓
  - Streaming: Live-Text-Anzeige während Generierung ✓
- Input-Bereich unten:
  - Mehrzeiliges Textfeld ✓
  - Send-Button (oder Enter) ✓
  - Attachment-Button (Dateien senden) ✓
  - Agent-Switcher Dropdown (schnell Agent wechseln) ✓
  - Abort-Button (während Generierung) ✓

**Agents-Ansicht:**
- Grid oder Tabelle aller Agents ✓
- Spalten: Name, Team, Status, Heartbeat, Model, Last Session, Workspace
- Aktionen: Starten, Stoppen, Konfigurieren, Löschen
- Filter nach Team (Tabs oder Dropdown)
- Bulk-Aktionen: Alle starten, Alle stoppen, Team starten

**Sessions-Ansicht:**
- Liste aller aktiven/vergangenen Sessions ✓
- Pro Session: Agent, Alter, Token-Verbrauch, Model
- Klick öffnet Session-Verlauf
- Löschen/Exportieren Buttons

**Cron Jobs:**
- Tabelle: Name, Agent, Schedule (Cron-Syntax), Letzter Lauf, Status ✓
- Erstellen/Bearbeiten Modal
- History pro Job

**Skills:**
- Karten-Grid aller verfügbaren Skills ✓
- Pro Skill: Icon + Name + Beschreibung + Aktiv-Toggle ✓
- Filter: Aktiv / Inaktiv / Alle
- Install-Button für neue Skills

**Config:**
- JSON-Editor mit Syntax-Highlighting ✓
- Schema-basierte Formular-Ansicht als Alternative ✓
- Speichern + Gateway-Restart Button ✓
- Backup/Restore

### 3. Rechtes Panel (optional, ~300px, klappbar)

**Funktionalität:**
- Zeigt Details zum aktuell ausgewählten Element:
  - **Agent-Details**: Config, IDENTITY.md, Workspace-Pfad
  - **Session-Details**: Tokens, Model, Thinking-Level
  - **Quick-Actions**: Restart, Config ändern, Heartbeat toggle
- Toggle-Button zum Ein-/Ausblenden
- Resizable (ähnlich wie Sidebar-Resizer)

## Implementierungs-Schritte

### Phase 1: Sidebar Erweiterung

1. **Agent-Liste in Sidebar** (`ui/src/ui/views/sidebar-agents.ts` - NEU)
   - Agent-Liste aus Gateway laden
   - Team-Gruppierung
   - Status-Dots (online/offline)
   - Auswahl-Highlighting
   - Klick → Agent auswählen

2. **Gateway-Status im Footer** (`ui/src/ui/app-render.ts`)
   - Gateway-Status aus `state.hello` lesen
   - Status-Dot (grün/rot)
   - "Running" / "Stopped" Text

3. **Navigation Icons aktualisieren** (`ui/src/ui/navigation.ts`)
   - Broadcast-Icon hinzufügen
   - Monitoring-Icon hinzufügen

### Phase 2: Rechtes Panel

1. **Panel-Komponente** (`ui/src/ui/views/right-panel.ts` - NEU)
   - Panel-State (geöffnet/geschlossen)
   - Resizable
   - Content basierend auf Auswahl

2. **Panel-Content** (`ui/src/ui/views/right-panel-content.ts` - NEU)
   - Agent-Details
   - Session-Details
   - Quick-Actions

3. **Panel-Integration** (`ui/src/ui/app-render.ts`)
   - Panel rendern wenn geöffnet
   - State-Management

### Phase 3: Neue Views

1. **Broadcast-View** (`ui/src/ui/views/broadcast.ts` - NEU)
   - Gruppe-Auswahl
   - Nachricht-Input
   - Vorschau
   - Ergebnis-Tabelle

2. **Team-Management-View** (`ui/src/ui/views/team-management.ts` - NEU)
   - Master-Admin-Dashboard
   - Unter-User-Verwaltung
   - Agent-Verwaltung
   - Permissions-Verwaltung
   - Nutzt neue Gateway-API (`team.*` Methods)

3. **Monitoring-View** (`ui/src/ui/views/monitoring.ts` - NEU)
   - Gateway Health
   - Agent-Aktivität (Timeline/Graph)
   - Log-Viewer
   - Token-Verbrauch

### Phase 4: Layout & Styling

1. **CSS-Grid-Layout** (`ui/src/styles/layout.css`)
   - Drei-Spalten-Grid
   - Sidebar: ~240px
   - Content: flex
   - Right Panel: ~300px (optional)

2. **Responsive Verhalten**
   - Right Panel klappbar
   - Sidebar kollabierbar (bereits vorhanden)

## Dateien

**Neu:**
- `ui/src/ui/views/sidebar-agents.ts` - Agent-Liste in Sidebar
- `ui/src/ui/views/right-panel.ts` - Rechtes Panel
- `ui/src/ui/views/right-panel-content.ts` - Panel-Content
- `ui/src/ui/views/broadcast.ts` - Broadcast-View
- `ui/src/ui/views/team-management.ts` - Team-Management-View (Master-Admin)
- `ui/src/ui/views/monitoring.ts` - Monitoring-View
- `ui/src/ui/controllers/agents-sidebar.ts` - Agent-Liste Controller
- `ui/src/ui/controllers/team-management.ts` - Team-Management Controller
- `ui/src/ui/styles/right-panel.css` - Panel-Styling

**Änderungen:**
- `ui/src/ui/app-render.ts` - Layout-Struktur, Sidebar-Erweiterung, Panel-Integration
- `ui/src/ui/app.ts` - Panel-State, Agent-Auswahl
- `ui/src/ui/navigation.ts` - Neue Tabs (broadcast, monitoring)
- `ui/src/ui/app-view-state.ts` - Panel-State, Selected Agent
- `ui/src/styles/layout.css` - Drei-Spalten-Layout
- `ui/src/ui/views/agents.ts` - Verbesserungen (Bulk-Aktionen, Team-Filter)
- `ui/src/ui/views/sessions.ts` - Verbesserungen (Export, Details)

## Abhängigkeiten

- Gateway WebSocket API für Agent-Status
- Gateway RPC für Broadcast-Funktionalität
- Gateway Logs API für Monitoring
- Gateway Usage API für Token-Verbrauch
- Gateway Role/Scope-System (`operator.admin`, `operator.pairing`) für Master-Admin
- Device-Pairing-System für Unter-User-Verwaltung
- Team-Management-API (`team.*` Methods) - **NEU zu implementieren**

## Entscheidungen

1. **Broadcast-API**: ✅ Bereits vorhanden (`message.send` mit Broadcast-Params)
2. **Agent-Teams**: ✅ Werden im Wizard erstellt (Team-Modus)
3. **Monitoring-Daten**: ✅ APIs vorhanden (Health, Logs, Usage)
4. **Right Panel**: Optional, klappbar (nur bei Bedarf)
5. **Master-Admin**: ✅ **Wichtig** - Wizard-Ersteller wird Master-Admin
6. **Team-Management**: ✅ Post-Wizard über Web UI verfügbar
7. **Unter-User**: ✅ Können über Web UI hinzugefügt werden (nur Master-Admin)

## Nächste Schritte

1. Sidebar Agent-Liste implementieren
2. Gateway-Status im Footer erweitern
3. Rechtes Panel erstellen
4. Broadcast-View implementieren
5. Monitoring-View implementieren
6. Layout-Styling anpassen
7. Testing
