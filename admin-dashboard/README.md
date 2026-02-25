# Activi Admin Dashboard

Admin-Dashboard für das Activi Team Management mit Health Monitoring, Skill-Verwaltung und Team-Konfiguration.

## Features

### 1. Health Monitoring
- Dashboard-Seite mit einer Card pro Team-Mitglied (7 Personen + 2 DS-Teams)
- Jede Card zeigt: Name, Subdomain, Sprache, Online/Offline-Status aller 5 Agenten
- Health-Check via `GET https://{subdomain}.activi.io/api/health` (alle 30 Sekunden Polling)
- Swarm-Status via `GET https://{subdomain}.activi.io/api/swarm/status`
- Farbige Status-Dots: grün=online, gelb=loading, rot=offline
- Übersichts-Header: "X/Y Agenten online", "X/Y Teams aktiv"

### 2. Skill Install / Delete
- Pro Team-Mitglied: Liste installierter Skills/Agenten
- Button "Skill installieren" → Modal mit Skill-Katalog
- Button "Skill entfernen" → Bestätigung → DELETE Call
- Batch-Operation: "Skill für ALLE installieren" / "Skill für ALLE entfernen"

### 3. Multi-Select Team Setup
- Checkbox-Auswahl: mehrere Teams gleichzeitig selektieren
- Action-Dropdown: "Deploy Config", "Install Skill", "Remove Skill", "Update Agents", "Restart"
- Ausführen auf allen selektierten Teams gleichzeitig (parallel fetch)
- Progress-Bar mit Einzelstatus pro Team

### 4. Team Config
- Team-Daten (aus SUBDOMAIN_MAP): Name, Subdomain, Sprache, Tailscale-Tags
- Bearbeiten/Hinzufügen/Löschen von Team-Einträgen
- Tailscale-Subnetz-Visualisierung: Wer hat auf wen Zugriff (Graph/Matrix)

## Tech Stack

- **Next.js 15** App Router
- **Tailwind CSS** + **shadcn/ui** Komponenten
- **API Routes** als Proxy zu Cloudflare Worker Endpoints
- **Zustand** für State Management
- **React Query** für Server State + Polling

## Installation

```bash
cd admin-dashboard
npm install
npm run dev
```

Das Dashboard läuft dann auf `http://localhost:3000`

## API Endpoints

Die folgenden Endpoints sind bereits verfügbar:

- `GET https://{sub}.activi.io/api/health` - Health Status
- `GET https://{sub}.activi.io/api/swarm/status` - Swarm Status
- `GET https://{sub}.activi.io/api/i18n?lang={lang}` - i18n
- `POST https://{sub}.activi.io/api/contact` - Contact

## Team Daten

Die Team-Daten sind in `lib/teams.ts` definiert:

```typescript
{
  teams: [
    {"subdomain": "aai", "owner": "DS", "lang": "de", "tags": ["ds-laptop","ds-phone"]},
    {"subdomain": "as", "owner": "Arnela Selmanovic", "lang": "bs", "tags": ["arnela","arnela-agents"]},
    // ...
  ],
  crossAccess: {
    "arnela": ["mersiha-agents", "hase-agents"],
    "armaan": ["mersiha-agents", "hase-agents"]
  }
}
```

## Seiten

- `/` - Haupt-Dashboard mit Health Monitoring
- `/teams` - Team-Konfiguration

## Entwicklung

```bash
# Development Server
npm run dev

# Build
npm run build

# Production Server
npm start
```

## Komponenten

- `components/header.tsx` - Übersichts-Header
- `components/team-card.tsx` - Team-Card mit Health-Status
- `components/skill-management.tsx` - Skill-Install/Delete
- `components/multi-select-actions.tsx` - Batch-Aktionen

## Nächste Schritte

- [ ] Tailscale-Subnetz-Visualisierung
- [ ] Config-Deploy-Funktionalität
- [ ] Agent-Update-Funktionalität
- [ ] Erweiterte Filterung und Suche
- [ ] Export-Funktionalität
