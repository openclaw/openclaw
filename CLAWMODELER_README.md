# ClawModeler

ClawModeler is an OpenClaw-powered transportation modeling workbench. It is designed to let local agents help a planner go from raw transportation data to reproducible scenario outputs, QA-gated evidence, and report-ready narratives.

The long-term goal is an installable OpenClaw transportation edition where agents can inspect local tools, select the right modeling method, run the workflow, validate the outputs, and explain every limitation.

For the big-picture roadmap and scope guardrails, see `docs/clawmodeler-roadmap.md`.

## What It Does

ClawModeler coordinates:

- data intake for zones, socioeconomic tables, GTFS, project lists, and model handoff files,
- method selection based on available data and installed tools,
- scenario transforms for baseline and alternatives,
- accessibility analysis,
- VMT and climate screening,
- transit schedule metrics,
- project scoring,
- bridge exports for heavier transportation models,
- reproducibility manifests,
- fact-block evidence,
- QA-gated report export.

Current analysis outputs are intentionally labeled as screening-level when proxy methods are used. The stack is built so detailed engines can replace or augment those proxy methods without changing the user-facing workflow.

## Quick Start

Check the local modeling lab:

```bash
python3 -m pip install -e .
openclaw clawmodeler doctor
openclaw clawmodeler tools
clawmodeler-engine --help
```

Run the built-in demo:

```bash
openclaw clawmodeler init --workspace ./demo-workspace
openclaw clawmodeler demo --workspace ./demo-workspace
```

Run the sidecar tests:

```bash
pnpm clawmodeler:test
```

Run a workspace:

```bash
openclaw clawmodeler workflow full \
  --workspace ./demo-workspace \
  --inputs zones.geojson socio.csv network_edges.csv projects.csv feed.zip \
  --question question.json \
  --run-id demo \
  --scenarios baseline scenario-a

openclaw clawmodeler workflow demo-full \
  --workspace ./demo-workspace \
  --run-id demo

openclaw clawmodeler workflow report-only \
  --workspace ./demo-workspace \
  --run-id demo

openclaw clawmodeler workflow diagnose \
  --workspace ./demo-workspace
```

Or run each stage manually:

```bash
openclaw clawmodeler intake \
  --workspace ./demo-workspace \
  --inputs zones.geojson socio.csv projects.csv feed.zip

openclaw clawmodeler plan \
  --workspace ./demo-workspace \
  --question question.json

openclaw clawmodeler run \
  --workspace ./demo-workspace \
  --run-id demo \
  --scenarios baseline scenario-a

openclaw clawmodeler export \
  --workspace ./demo-workspace \
  --run-id demo \
  --format md

openclaw clawmodeler bridge sumo prepare \
  --workspace ./demo-workspace \
  --run-id demo

openclaw clawmodeler bridge sumo validate \
  --workspace ./demo-workspace \
  --run-id demo

openclaw clawmodeler bridge matsim prepare \
  --workspace ./demo-workspace \
  --run-id demo

openclaw clawmodeler bridge urbansim prepare \
  --workspace ./demo-workspace \
  --run-id demo

openclaw clawmodeler bridge prepare-all \
  --workspace ./demo-workspace \
  --run-id demo

openclaw clawmodeler bridge validate \
  --workspace ./demo-workspace \
  --run-id demo
```

Prepare an OSMnx graph cache when the standard profile is installed:

```bash
openclaw clawmodeler graph osmnx \
  --workspace ./demo-workspace \
  --place "Davis, California, USA" \
  --network-type drive \
  --graph-id davis-drive

openclaw clawmodeler graph map-zones \
  --workspace ./demo-workspace
```

Direct sidecar access is also available:

```bash
python3 -m clawmodeler_engine --help
```

## Agent Workflow

Agents should follow this sequence:

1. Run `openclaw clawmodeler doctor --json`.
2. Run `openclaw clawmodeler tools --json`.
3. Inspect available runtimes, Python modules, local engine source trees, model inventory, profiles, and method policy.
4. Choose the strongest defensible method available.
5. Prefer `workflow full` when the user wants the whole job handled end to end.
6. Use `workflow diagnose` when data, tools, or next steps are unclear.
7. Otherwise run intake validation.
8. Write a `question.json` that records scenarios and assumptions.
9. Run planning and modeling.
10. Prepare bridge packages with `bridge prepare-all`, or use specific commands such as `bridge sumo prepare`, `bridge matsim prepare`, or `bridge urbansim prepare`.
11. Validate bridge packages with commands such as `bridge sumo validate` or `bridge validate`.
12. Inspect `qa_report.json`.
13. Export only if QA passes.
14. Summarize outputs by citing artifacts and limitations.

Agents must not invent data, silently bypass QA, or present screening-level outputs as detailed engineering forecasts.

## Inputs

Useful inputs include:

- GeoJSON zones with `properties.zone_id`,
- socioeconomic CSV with `zone_id`, `population`, and `jobs`,
- candidate project CSV with `project_id`, `name`, `safety`, `equity`, `climate`, and `feasibility`,
- optional network edge CSV with `from_zone_id`, `to_zone_id`, and `minutes`,
- optional zone-to-node map CSV with `zone_id` and `node_id` for GraphML networks,
- GTFS zip feeds,
- optional OSM/network inputs,
- optional OD matrices,
- optional local model handoff files.

If required data is missing, ClawModeler should either run a reduced analysis with explicit limitations or ask for the missing data.

## Workspace Layout

Each workspace follows this contract:

```text
workspace/
  project.duckdb
  inputs/
  cache/
    graphs/
    gtfs/
  runs/
    <run_id>/
      manifest.json
      qa_report.json
      outputs/
        tables/
        maps/
        figures/
        bridges/
  reports/
  logs/
```

The manifest records inputs, hashes, methods, scenarios, assumptions, output artifacts, and engine selection. The QA report records whether export is allowed.

## Max Toolbox

The toolbox is declared in `clawmodeler_toolbox.json` and surfaced through:

```bash
openclaw clawmodeler tools
openclaw clawmodeler tools --json
openclaw clawmodeler doctor --json
```

It includes:

- runtimes: Python, Java, Docker,
- GIS: DuckDB, GDAL/OGR, GeoPandas, Shapely, pyproj,
- routing: NetworkX, OSMnx,
- transit: GTFS tooling, R5 bridge target, TBEST tools,
- simulation: SUMO, MATSim,
- assignment: DTALite,
- land use: UrbanSim,
- optimization: OR-Tools, CVXPY, PuLP,
- ML: scikit-learn, PyTorch, XGBoost, LightGBM, transformers,
- reporting: Pandoc, Graphviz, Office/PDF helpers.

The local transportation model directories are intentional resources:

```text
matsim-libs/
sumo/
urbansim/
DTALite/
tbest-tools/
```

Do not delete them as accidental untracked files. Agents should treat them as local modeling engines or bridge targets.

## Install Profiles

Python dependency profiles are provided:

```text
clawmodeler-requirements-light.txt
clawmodeler-requirements-standard.txt
clawmodeler-requirements-full.txt
clawmodeler-requirements-gpu.txt
```

Install a profile:

```bash
bash scripts/clawmodeler/install-profile.sh standard
```

Profiles:

- `light`: fast screening, DuckDB, table handling, basic geometry, report templating.
- `standard`: GIS, OSM routing, GTFS, plotting, Excel/Word/PDF helpers.
- `full`: simulation, matrix, optimization, bridge libraries, SUMO Python tooling.
- `gpu`: full plus PyTorch and ML libraries.

The GPU profile is optional. ML tools are powerful, but they require training data, validation, and clear limitations before their outputs can support planning claims.

## Method Policy

ClawModeler agents should choose methods like this:

- Quick screening or incomplete data: use DuckDB/GIS/NetworkX/OSMnx when available, otherwise use proxy screening and label limitations.
- Transit accessibility with GTFS: prefer R5 and Java when available; otherwise compute GTFS route metrics and stop-access proxies.
- Corridor or intersection operations: prefer SUMO; otherwise create a SUMO bridge export.
- Agent-based simulation: prefer MATSim and Java; otherwise create a MATSim bridge export.
- Land-use interaction: prefer UrbanSim; otherwise create a bridge export and request development inputs.
- Dynamic traffic assignment: use DTALite bridge workflows when OD matrices and network inputs exist.
- Emissions: use VMT screening for early planning and create a MOVES export for defensible detailed emissions work.
- ML: use only as exploratory or validated modeling when training and validation data exist.

## QA Rules

Report export is blocked unless:

- `manifest.json` exists,
- `qa_report.json` exists,
- `fact_blocks.jsonl` exists,
- at least one fact-block is present,
- narrative claims are grounded.

Blocked exports write:

```text
reports/<run_id>_export_blocked.md
```

## Current Status

Implemented now:

- OpenClaw CLI surface: `openclaw clawmodeler ...`,
- sidecar CLI commands: `doctor`, `tools`, `demo`, `intake`, `plan`, `run`, `export`,
- one-command demo workspace generation and report export,
- network edge CSV shortest-path accessibility with a built-in Dijkstra fallback,
- GraphML cache shortest-path accessibility from `cache/graphs/*.graphml`,
- OSMnx-style GraphML parsing for `travel_time` seconds and `length`/`speed_kph`,
- OSMnx GraphML cache builder command,
- GraphML zone-to-node mapping command,
- workspace folder creation,
- input staging and validation,
- scenario transforms,
- proxy accessibility metrics,
- VMT and CO2e screening,
- GTFS route metrics,
- project scoring,
- fact-block generation,
- QA-gated Markdown export,
- bridge manifests for SUMO, MATSim, UrbanSim, DTALite, and TBEST,
- toolbox inventory and install profiles.

Still to build:

- Tauri/React ClawModeler UI,
- real DuckDB spatial ingestion path as the default,
- OSMnx/NetworkX graph routing,
- R5 transit accessibility execution,
- SUMO network/demand conversion and execution,
- MATSim population/plans conversion,
- UrbanSim scenario adapter,
- DTALite assignment adapter,
- MOVES export package,
- PDF/DOCX report rendering,
- packaged install profiles for desktop and containers.

## Verification

Useful checks:

```bash
pnpm clawmodeler:test
node scripts/run-vitest.mjs run --config test/vitest/vitest.unit-fast.config.ts src/cli/clawmodeler-cli.test.ts
pnpm openclaw clawmodeler doctor --json
pnpm openclaw clawmodeler tools
```
