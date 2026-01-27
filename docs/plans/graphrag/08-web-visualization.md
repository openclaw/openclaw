# Component 8: Web Visualization UX

An interactive graph explorer and ingestion management interface in the existing Lit-based
control UI, allowing users to visually explore entities, relationships, and their
connections to memory and Overseer goals.

---

## 8A. Graph Explorer Page

**Purpose:** Interactive force-directed graph visualization for exploring the knowledge
graph.

**File:** `ui/src/ui/pages/knowledge-graph.ts` (new Lit component)

### Technology Choice

**Decision:** React Flow for knowledge graph visualization

**Rationale:**
- **Native React Integration:** Clawdbot's web UI is React-based; React Flow provides seamless integration
- **Interactive Features:** Built-in drag-and-drop, zoom, pan, mini-map navigation
- **Developer Experience:** Excellent TypeScript support, comprehensive documentation, active community
- **Performance:** Optimized for graphs with <1000 nodes (typical for knowledge graph visualization)
- **Community:** 23K GitHub stars, 500K weekly NPM downloads, regular updates

**Architecture Note:**
The current UI uses Lit (web components) + Tailwind. React Flow components can be integrated into the existing Lit-based UI via web components or by migrating the knowledge graph section to React.

**React Flow Features Used:**
- Force-directed layout (built-in)
- Custom node components (React components)
- Interactive controls (zoom, fit view)
- Mini-map for navigation
- Background patterns
- Edge types with animations

**When to Reconsider:**
- Graph grows to >2000 visible nodes (consider G6 for better performance)
- Need 3D visualization capabilities
- Need advanced graph algorithms (centrality, community detection)

### Features

**Force-directed layout:**
- Entities rendered as colored circles (color = entity type)
- Relationships rendered as lines (thickness = weight, labeled with type)
- Physics simulation with configurable charge, link distance, collision
- Smooth drag, zoom (scroll wheel), and pan (click-drag background)

**Node interactions:**
- Click: Select entity, show detail panel in sidebar
- Double-click: Expand neighborhood (lazy-load connected nodes not yet visible)
- Right-click: Context menu with options:
  - "Inspect in detail" (opens full entity view)
  - "Find in memory" (runs memory_search for this entity)
  - "Link to goal" (shows related Overseer goals)
  - "Remove from view" (hide node without deleting)

**Edge interactions:**
- Hover: Tooltip with relationship description, keywords, weight
- Click: Show source chunks where this relationship was extracted

**Filtering controls:**
- Entity type checkboxes (person, org, concept, tool, etc.) with color legend
- Relationship type checkboxes
- Source filter dropdown (memory, manual, crawl, or specific source)
- Time range slider (filter by `first_seen` / `last_seen`)
- Search box (highlights matching nodes, auto-centers on results)
- Min-weight slider (hide low-weight relationships)

**Goal overlay toggle:**
- When enabled, Overseer goal/task nodes appear as special shapes (diamonds/hexagons)
- Their relationships to entities are highlighted with distinct edge styles
- This shows how planning goals connect to the broader knowledge graph

**Stats sidebar:**
- Total entities, relationships, sources
- Entity type distribution (horizontal bar chart)
- Most connected entities (hub list, clickable)
- Recent extractions (timeline of `last_seen` updates)

### Wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  Knowledge Graph Explorer                   [Search... ] [Filters] │
├────────────────────────────────────────────┬────────────────────────┤
│                                            │  Entity Detail         │
│                                            │                        │
│         ┌─────┐                            │  Name: Auth Service    │
│        ╱       ╲     ┌──────┐              │  Type: concept         │
│  ┌────┤  OAuth  ├────┤ User │              │  Mentions: 47          │
│  │     ╲ Provider╱   │ Model│              │  First seen: Jan 15    │
│  │      └───┬───┘    └──┬───┘              │  Last seen: Jan 25     │
│  │          │           │                  │  Sources: 12 files     │
│  ▼          ▼           ▼                  │                        │
│ ┌────────┐ ┌────────┐ ┌────────┐           │  Relationships (8)     │
│ │ Google │ │  Auth  │ │ Login  │           │  ─ OAuth Provider      │
│ │ OAuth  │ │Service │ │  Flow  │           │    depends_on (w: 8)   │
│ └────────┘ └────────┘ └────────┘           │  ─ User Model          │
│                                            │    implements (w: 5)   │
│                                            │  ─ Session Store       │
│                                            │    uses (w: 6)         │
│  Entity types:                             │                        │
│  [x] concept  [x] tool  [x] person        │  Source chunks (3)     │
│  [x] org  [x] goal  [ ] file              │  ─ memory/01-15.md:45  │
│                                            │  ─ memory/01-20.md:12  │
│  [Show Goals]  [Show All Sources]          │                        │
│                                            │  [View in Memory]      │
├────────────────────────────────────────────┴────────────────────────┤
│  Entities: 342  │  Relationships: 891  │  Sources: 28  │  Hubs: 10 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 8B. Gateway API Endpoints

**Purpose:** Expose knowledge graph data to the web UI via the existing gateway HTTP API.

### Routes

All routes are prefixed with `/api/knowledge/` and authenticated via the existing gateway
auth mechanism.

```
GET  /api/knowledge/graph/stats
     Returns: GraphStats (entity count, relationship count, distributions)

GET  /api/knowledge/graph/entities?type=&search=&limit=&offset=
     Returns: Paginated entity list with basic relationship counts

GET  /api/knowledge/graph/entity/:entityId
     Returns: Full entity detail with relationships and source chunks

GET  /api/knowledge/graph/entity/:entityId/neighborhood?hops=1&relTypes=
     Returns: GraphSnapshot (entities + relationships within N hops)

GET  /api/knowledge/graph/relationships?sourceId=&targetId=&type=
     Returns: Filtered relationship list

GET  /api/knowledge/graph/subgraph?entityIds=id1,id2,id3
     Returns: GraphSnapshot for the specified entity set

GET  /api/knowledge/graph/sources
     Returns: List of all ingestion sources with metadata

POST /api/knowledge/ingest
     Body: multipart/form-data (file upload) or JSON { url, text, tags }
     Returns: IngestResult

POST /api/knowledge/crawl
     Body: { url, mode, maxPages, tags }
     Returns: { crawlId }

GET  /api/knowledge/crawl/:crawlId
     Returns: CrawlProgress
```

### Response Format

All responses follow the existing gateway API conventions. Entity responses include
computed fields:

```json
{
  "entity": {
    "id": "ent-abc123",
    "name": "Auth Service",
    "type": "concept",
    "description": "Core authentication service...",
    "mentionCount": 47,
    "degree": 8,
    "firstSeen": 1737000000000,
    "lastSeen": 1737800000000,
    "sourceFiles": ["memory/2026-01-15.md", "memory/2026-01-20.md"]
  },
  "relationships": [...]
}
```

### Implementation Notes

- The graph query engine is instantiated per-agent (using the agent's SQLite database)
- Routes delegate to `GraphQueryEngine` methods (same interface as CLI + agent tools)
- File upload uses multipart parsing; files are temporarily written to disk, processed
  through the ingestion pipeline, then cleaned up
- Crawl endpoints return immediately with a `crawlId`; progress is polled via GET

---

## 8C. Ingestion Management UI

**Purpose:** A companion page to the graph explorer for managing knowledge sources.

**File:** `ui/src/ui/pages/knowledge-sources.ts` (new Lit component)

### Features

**Source list table:**

| Column | Description |
|--------|-------------|
| Name | Source name (file name, URL, or label) |
| Type | memory / manual / crawl |
| Tags | User-supplied tags (filterable) |
| Chunks | Number of chunks |
| Entities | Number of entities extracted |
| Updated | Last update timestamp |
| Actions | Delete, re-index, view graph |

**Upload panel:**
- Drag-and-drop zone for file upload
- Supported formats: PDF, DOCX, MD, TXT, HTML, JSON
- Tag input (comma-separated or chip-style)
- Upload button with progress indicator

**Crawl panel:**
- URL input field
- Mode selector (single / sitemap / recursive)
- Max pages input (default 100)
- Tags input
- Start button
- Active crawls list with real-time progress bars (pages crawled, entities extracted)

**Source detail view:**
- Click a source row to expand/navigate to detail view
- Shows all entities extracted from this source
- Shows all relationships
- Link to view this source's subgraph in the graph explorer

---

## Dependencies (ui/)

```json5
{
  "dependencies": {
    "reactflow": "^11.0.0"
  }
}
```

**Note:** React Flow requires React as a peer dependency. The existing UI should already have React installed or can add it without conflicts.

---

## Files to Create

**UI:**
- `ui/src/ui/pages/knowledge-graph.ts` -- graph explorer page
- `ui/src/ui/pages/knowledge-sources.ts` -- ingestion management page
- `ui/src/ui/components/graph-renderer.ts` -- D3-force rendering logic
- `ui/src/ui/components/entity-detail-panel.ts` -- entity detail sidebar
- `ui/src/ui/components/source-upload.ts` -- file upload component
- `ui/src/ui/components/crawl-panel.ts` -- crawl launcher + progress

**Gateway:**
- Gateway route handlers for `/api/knowledge/*` (location depends on gateway router
  structure)
