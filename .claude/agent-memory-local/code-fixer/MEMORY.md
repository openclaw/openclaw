# Code-fixer Memory

## Fichiers protégés (NE PAS TOUCHER)

- apps/android/ (3 fichiers) — patches Android
- src/auto-reply/reply/dispatch-from-config.ts — fix WhatsApp
- src/browser/chrome.ts — patch --remote-allow-origins
- src/config/types.whatsapp.ts — fix config
- src/config/zod-schema.providers-whatsapp.ts — fix config

## Conventions du codebase

- Formatter : oxfmt (pas prettier). `pnpm format` = `oxfmt --write`
- Linter : oxlint (pas eslint). `pnpm lint` = `oxlint`
- Type checker : tsgo (pas tsc). `pnpm tsgo` = `tsgo --noEmit`
- Build : `pnpm build` avant check/test
- Tests : Vitest, 898+ tests, 70% coverage minimum
- Commits : `scripts/committer` (scoped messages, fichiers explicites)

## Patterns de fix récurrents

- Neo4j HTTP API: use urllib.request (not bolt), url=http://localhost:7474/db/neo4j/tx/commit, auth=base64 neo4j:openclaw
- Google Maps API key: in ~/.openclaw/config/.env as GOOGLE_MAPS_API_KEY
- Routes API: POST https://routes.googleapis.com/directions/v2:computeRoutes with X-Goog-Api-Key header
- Nuki events: ~/.openclaw/state/nuki-events.jsonl, JSONL format (119k+ events — heavy file, use since filter)
- Neo4j spatial: use point() and point.distance() for geospatial proximity queries
- Python skills: no pnpm build needed, just py_compile check + functional test

## Co-change patterns (skills)

- location-daemon.py + query-graph.py (locations/trips/places/distance commands)
- location-daemon.py + SKILL.md (document new features)
- flow-generate.py + SKILL.md (always update docs when changing selectors)

## Google Flow (gemini-flow-studio) patterns

- Radix UI tabs: id$="-trigger-VALUE" (e.g., -trigger-VIDEO, -trigger-1)
- CRITICAL: Radix dropdown requires Playwright click(force=True), NOT JS el.click()
- Dropdown trigger: bottom-bar button[aria-haspopup="menu"] at y>600
- Output tab IDs: numeric "1","2","3","4" (NOT "x1","x2","x3","x4")
- Frame upload: DIV[aria-haspopup="dialog"]:has-text("Début"/"Fin") → media picker → file_chooser
- Ingredient upload: button[aria-haspopup="dialog"]:has-text("add_2") at y>600
- Project links on landing: a[href*="/project/"]
- Models (Mar 2026): Veo 3.1 Fast, Veo 3.1 Fast [Lower Priority], Veo 3.1 Quality, Veo 2 Fast, Veo 2 Quality

## Mises à jour ARCHITECTURE.md en attente

- Location daemon now has Neo4j KG integration (Place/LocationVisit/Trip nodes) -> add to §9 Skills catalog
- query-graph.py has 4 new commands: locations, trips, places, distance -> add to §9
- stats command now includes Place, LocationVisit, Trip counts
- gemini-flow-studio: refactored for March 2026 Radix UI, 5 models, file chooser upload -> update §9
