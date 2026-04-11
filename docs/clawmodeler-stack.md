# ClawModeler Stack

ClawModeler is a local-first transportation sketch-planning stack. The current implementation centers on the Python sidecar `clawmodeler-engine`, which stages inputs, chooses a screening engine, runs local analysis, writes reproducibility artifacts, gates report export, and prepares handoff folders for heavier transportation modeling engines.

For the product-level overview, start with `CLAWMODELER_README.md`. For the sequencing plan and rabbit-hole guardrails, see `docs/clawmodeler-roadmap.md`.

## Sidecar Commands

Run the sidecar through the package scripts:

```bash
pnpm clawmodeler:engine --version
pnpm clawmodeler:test
```

Run it through OpenClaw:

```bash
openclaw clawmodeler doctor
openclaw clawmodeler tools
openclaw clawmodeler init --workspace ./demo
openclaw clawmodeler demo --workspace ./demo
openclaw clawmodeler workflow full --workspace ./demo --inputs zones.geojson socio.csv --question question.json --run-id demo
openclaw clawmodeler workflow demo-full --workspace ./demo --run-id demo
openclaw clawmodeler workflow report-only --workspace ./demo --run-id demo
openclaw clawmodeler workflow diagnose --workspace ./demo
openclaw clawmodeler intake --workspace ./demo --inputs zones.geojson socio.csv
openclaw clawmodeler plan --workspace ./demo --question question.json
openclaw clawmodeler run --workspace ./demo --run-id demo --scenarios baseline scenario-a
openclaw clawmodeler export --workspace ./demo --run-id demo --format md
openclaw clawmodeler bridge sumo prepare --workspace ./demo --run-id demo
openclaw clawmodeler bridge sumo validate --workspace ./demo --run-id demo
openclaw clawmodeler bridge matsim prepare --workspace ./demo --run-id demo
openclaw clawmodeler bridge urbansim prepare --workspace ./demo --run-id demo
openclaw clawmodeler bridge prepare-all --workspace ./demo --run-id demo
openclaw clawmodeler bridge validate --workspace ./demo --run-id demo
openclaw clawmodeler graph osmnx --workspace ./demo --place "Davis, California, USA"
openclaw clawmodeler graph map-zones --workspace ./demo
```

The sidecar also runs directly:

```bash
python3 -m clawmodeler_engine intake --workspace /path/to/workspace --inputs zones.geojson socio.csv
python3 -m clawmodeler_engine plan --workspace /path/to/workspace --question question.json
python3 -m clawmodeler_engine run --workspace /path/to/workspace --run-id demo --scenarios baseline scenario-a
python3 -m clawmodeler_engine export --workspace /path/to/workspace --run-id demo --format md
```

## Internal Structure

The CLI and end-to-end workflows share the same core stage functions:

- `clawmodeler_engine/orchestration.py` owns intake, planning, engine selection, run manifest creation, QA-gated export, and report writing.
- `clawmodeler_engine/workflow.py` composes those shared stages into full, demo, report-only, and diagnose workflows.
- `clawmodeler_engine/cli.py` parses command-line arguments and prints concise JSON command results.
- `clawmodeler_engine/report.py` renders Markdown reports from manifests and fact-block artifacts.

New workflow behavior should be added to the shared orchestration layer first, then exposed through CLI or workflow wrappers. This keeps manual commands and `workflow full` aligned.

## Workspace Contract

Each workspace follows the plan contract:

- `inputs/` contains staged user inputs.
- `cache/graphs/` is reserved for OSMnx GraphML caches.
- `cache/gtfs/` is reserved for transit feed cache material.
- `runs/{run_id}/manifest.json` records inputs, hashes, methods, assumptions, scenarios, outputs, and engine selection.
- `runs/{run_id}/qa_report.json` records export gate status.
- `runs/{run_id}/outputs/tables/` contains CSV and JSONL outputs.
- `runs/{run_id}/outputs/bridges/` contains external engine handoff manifests.
- `reports/` contains exported reports.

Core JSON artifacts are versioned with `schema_version` and `artifact_type`. The sidecar validates these contracts in `clawmodeler_engine/contracts.py` before writing or loading key artifacts. Current contract-covered artifacts include:

- `question`
- `intake_receipt`
- `analysis_plan`
- `engine_selection`
- `run_manifest`
- `qa_report`
- `bridge_manifest`
- `bridge_prepare_report`
- `bridge_validation_report`
- `workflow_report`
- `workflow_diagnosis`

When the Python `duckdb` module is installed, the sidecar creates `project.duckdb` with the planned starter tables. If DuckDB is absent, it writes an explicit missing-dependency note beside the database path and continues with file-backed artifacts.

## Implemented Analysis Modules

The current stack implements these plan modules:

- Intake: stages GeoJSON, CSV, GTFS zip, Shapefile placeholders, and unknown files for audit.
- Model Brain: writes `analysis_plan.json` and `engine_selection.json`.
- Scenario Lab: applies scenario-level population and jobs multipliers plus per-zone deltas.
- Accessibility Engine: writes 15, 30, and 45 minute cumulative jobs-accessible outputs using a Euclidean proxy travel-time method.
- Accessibility Engine: uses staged `network_edges.csv` shortest paths when available, then `cache/graphs/*.graphml`, otherwise falls back to Euclidean proxy travel times.
- VMT & Climate: writes screening VMT and CO2e estimates using explicit per-capita and emissions-factor assumptions.
- Transit Analyzer: validates GTFS core files and writes route span, trip count, and frequency metrics.
- Project Scoring: writes weighted safety, equity, climate, and feasibility scores.
- Narrative Engine: exports Markdown only when QA confirms manifest and fact-block evidence are present.
- Bridge Exports: creates MATSim, SUMO, UrbanSim, DTALite, and TBEST handoff manifests.
- SUMO Bridge: generates and validates SUMO plain node, edge, trip, config, and shell script files from staged zone-level network and demand inputs.
- MATSim Bridge: generates MATSim network, population, config, and shell script files from staged zone-level network and demand inputs.
- UrbanSim Bridge: generates zone, household, job, building, and config tables from staged zone-level socioeconomic inputs.
- DTALite Bridge: generates node, link, demand, and settings files from staged zone-level network and demand inputs.
- TBEST Bridge: generates stop, route, service, and config tables from staged GTFS inputs.
- Bridge Prepare All: prepares every applicable bridge package and records skipped packages with reasons.
- Bridge Validation: writes a combined bridge validation report across prepared external-engine packages.

The accessibility and VMT modules are intentionally labeled as screening-level. They are ready to be replaced or augmented with OSMnx/NetworkX, R5, MOVES, and detailed engine outputs without changing the CLI contract.

When OSMnx is installed, `openclaw clawmodeler graph osmnx` can build a GraphML cache in `cache/graphs/`. The accessibility engine can consume GraphML cache files with edge `minutes`, `travel_time_min`, `travel_time_minutes`, OSMnx-style `travel_time` seconds, or `length` plus `speed_kph` values. Run `openclaw clawmodeler graph map-zones` after intake to generate and register `inputs/zone_node_map.csv` from staged zones and GraphML node coordinates, or stage a CSV with `zone_id,node_id` columns when a custom mapping is required.

## Max Toolbox

`clawmodeler_toolbox.json` is the machine-readable inventory agents use to decide what they can run. It includes runtime, GIS, routing, transit, simulation, optimization, ML, reporting, and packaging tools.

Use:

```bash
openclaw clawmodeler tools
openclaw clawmodeler tools --json
openclaw clawmodeler doctor --json
```

Install profiles are declared as requirement files:

- `clawmodeler-requirements-light.txt`
- `clawmodeler-requirements-standard.txt`
- `clawmodeler-requirements-full.txt`
- `clawmodeler-requirements-gpu.txt`

Install one with:

```bash
bash scripts/clawmodeler/install-profile.sh standard
```

The `gpu` profile includes PyTorch and other ML tooling. It should be used for validated or exploratory ML-assisted modeling, not as a substitute for calibrated transportation model evidence.

## Local Modeling Engines

These local directories are intentional modeling resources for agents:

- `matsim-libs/`: MATSim bridge target for agent-based simulation exports.
- `sumo/`: SUMO bridge target for microscopic operations simulation.
- `urbansim/`: UrbanSim bridge target for land-use and transportation interaction workflows.
- `DTALite/`: DTALite bridge target for dynamic traffic assignment workflows.
- `tbest-tools/`: TBEST bridge target for stop-level transit ridership workflows.

Do not delete or treat these directories as accidental untracked files. The sidecar records their presence in `runs/{run_id}/outputs/bridges/*/bridge_manifest.json`.

## QA Gate

Report export is blocked unless:

- `manifest.json` exists,
- `fact_blocks.jsonl` exists,
- at least one fact-block is present,
- narrative claim coverage is zero-missing.

Blocked exports write `reports/{run_id}_export_blocked.md` and exit with code `40`.
