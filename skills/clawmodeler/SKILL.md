# ClawModeler

Use this skill when a user asks OpenClaw to perform transportation planning, transportation demand modeling, accessibility analysis, VMT/climate screening, transit analysis, project scoring, or report/grant narrative generation with ClawModeler.

## Goal

Operate ClawModeler as a governed transportation modeling workflow. Agents should take the user from raw local data to reproducible scenario outputs and evidence-linked reports while clearly labeling screening-level methods and limitations.

## Primary Commands

Prefer the OpenClaw command surface:

```bash
openclaw clawmodeler doctor
openclaw clawmodeler tools
openclaw clawmodeler init --workspace <workspace>
openclaw clawmodeler demo --workspace <workspace>
openclaw clawmodeler workflow full --workspace <workspace> --inputs <files...> --question <question.json> --run-id <run_id> --scenarios <scenario_ids...>
openclaw clawmodeler workflow demo-full --workspace <workspace> --run-id <run_id>
openclaw clawmodeler workflow report-only --workspace <workspace> --run-id <run_id>
openclaw clawmodeler workflow diagnose --workspace <workspace>
openclaw clawmodeler intake --workspace <workspace> --inputs <files...>
openclaw clawmodeler plan --workspace <workspace> --question <question.json>
openclaw clawmodeler run --workspace <workspace> --run-id <run_id> --scenarios <scenario_ids...>
openclaw clawmodeler export --workspace <workspace> --run-id <run_id> --format md
openclaw clawmodeler bridge sumo prepare --workspace <workspace> --run-id <run_id>
openclaw clawmodeler bridge sumo validate --workspace <workspace> --run-id <run_id>
openclaw clawmodeler bridge sumo run --workspace <workspace> --run-id <run_id>
openclaw clawmodeler bridge matsim prepare --workspace <workspace> --run-id <run_id>
openclaw clawmodeler bridge urbansim prepare --workspace <workspace> --run-id <run_id>
openclaw clawmodeler bridge dtalite prepare --workspace <workspace> --run-id <run_id>
openclaw clawmodeler bridge tbest prepare --workspace <workspace> --run-id <run_id>
openclaw clawmodeler bridge prepare-all --workspace <workspace> --run-id <run_id>
openclaw clawmodeler bridge validate --workspace <workspace> --run-id <run_id>
openclaw clawmodeler graph osmnx --workspace <workspace> --place <place>
openclaw clawmodeler graph map-zones --workspace <workspace>
```

For direct sidecar debugging, use:

```bash
python3 -m clawmodeler_engine ...
```

## Workflow

1. Run `openclaw clawmodeler doctor` before the first model run on a machine.
2. Run `openclaw clawmodeler tools --json` and inspect available tools and model inventory before choosing a method.
3. For a smoke test or product demo, run `openclaw clawmodeler demo --workspace <workspace>`.
4. Create or choose a workspace directory for real user data, using `init` for new projects.
5. Prefer `workflow full` when the user wants the whole job handled end to end.
6. Use `workflow demo-full` for demos and `workflow report-only` after bridge updates.
7. Use `workflow diagnose` when data, tools, or next steps are unclear.
8. Otherwise stage and validate user inputs with `intake`.
9. Write a `question.json` file that records the user goal, scenario assumptions, requested metrics, and optional method parameters.
10. If using a GraphML cache, run `graph map-zones` to generate and register `zone_node_map.csv`.
11. Run `plan` to create `analysis_plan.json` and `engine_selection.json`.
12. Run `run` with baseline and scenario IDs.
13. For full handoffs, run `bridge prepare-all` after the main run.
14. Run `bridge sumo validate` and inspect `bridge_qa_report.json`.
15. Run `bridge sumo run` only when SUMO binaries and `network.net.xml` are available.
16. For MATSim handoffs, run `bridge matsim prepare` after the main run.
17. For UrbanSim handoffs, run `bridge urbansim prepare` after the main run.
18. Run `bridge validate` after preparing external-engine packages.
19. Inspect `runs/<run_id>/qa_report.json`.
20. Export only when QA passes.
21. Summarize outputs by citing generated files and limitations.

## Input Expectations

Useful inputs include:

- zones as GeoJSON with `properties.zone_id`,
- socioeconomic CSV with `zone_id`, `population`, and `jobs`,
- optional candidate project CSV with `project_id`, `name`, `safety`, `equity`, `climate`, and `feasibility`,
- optional network edge CSV with `from_zone_id`, `to_zone_id`, and `minutes`,
- optional GraphML cache files under `cache/graphs/` with edge travel-time minutes,
- optional zone-to-node map CSV with `zone_id` and `node_id` for GraphML networks,
- optional GTFS zip with core files,
- optional local network/model files for future bridge workflows.

If required fields are missing, stop and ask for corrected data or propose a reduced analysis. Do not silently invent zone IDs, population, jobs, routes, or project scores.

## Method Selection

Default to the strongest defensible method available in the local toolbox. Use `openclaw clawmodeler tools --json` to inspect profiles, tool availability, and method policy. If a preferred tool is missing, either choose the documented fallback or explain the missing dependency and ask whether to install the relevant profile.

Current implemented methods:

- end-to-end `workflow full` orchestration,
- `workflow diagnose` workspace readiness and next-action reports,
- network edge and GraphML shortest-path cumulative accessibility,
- Euclidean proxy cumulative accessibility fallback,
- VMT and CO2e screening,
- GTFS route span and frequency metrics,
- weighted project scoring,
- bridge manifests for MATSim, SUMO, UrbanSim, DTALite, and TBEST.
- SUMO bridge packages and bridge QA from staged zone-level network edges and socioeconomic demand.
- MATSim bridge packages from staged zone-level network edges and socioeconomic demand.
- UrbanSim bridge packages from staged zone-level socioeconomic demand.
- DTALite bridge packages from staged zone-level network edges and socioeconomic demand.
- TBEST bridge packages from staged GTFS schedule inputs.
- `bridge prepare-all` for preparing every applicable bridge package with skipped reasons.
- Unified bridge validation reports across prepared external-engine packages.

Future detailed engine paths:

- OSMnx/NetworkX for graph-based accessibility,
- R5 for many-to-many and transit accessibility,
- SUMO for microscopic operations,
- MATSim for agent-based demand simulation,
- UrbanSim for land-use interaction,
- DTALite for dynamic traffic assignment,
- MOVES export for detailed emissions workflows,
- TBEST bridge for stop-level transit ridership.

## Max Toolbox Profiles

ClawModeler defines install profiles:

- `light`: DuckDB, pandas, geometry basics, and report templating.
- `standard`: GIS, OSMnx/NetworkX, GTFS tooling, plotting, Excel/Word/PDF helpers.
- `full`: SUMO, MATSim/R5-oriented Java workflows, UrbanSim/DTALite/TBEST bridge support, optimization, matrix, and simulation libraries.
- `gpu`: PyTorch, XGBoost, LightGBM, transformers, embeddings, and GPU-oriented ML helpers.

Use ML libraries only when the user has training/validation data or clearly wants exploratory modeling. Do not present ML outputs as calibrated transportation forecasts without validation evidence.

## QA Rules

Never bypass QA. Report export requires:

- `manifest.json`,
- `qa_report.json`,
- `fact_blocks.jsonl`,
- at least one fact-block,
- no known ungrounded narrative claims.

If QA blocks export, explain the blockers and the concrete next fix. Do not write a polished planning conclusion from unsupported evidence.

## Reporting Rules

Treat current accessibility and VMT outputs as screening-level. Use language such as "proxy", "screening", "planning-level", and "requires detailed follow-up" where appropriate.

Every factual claim in a report or user-facing summary must trace to:

- a generated table,
- a generated report,
- a manifest field,
- a QA report,
- or an approved source citation.

Do not claim engineering precision, final travel demand forecasts, regulatory emissions compliance, or grant eligibility unless the supporting model path and source evidence exist.

## Local Modeling Directories

These directories are intentional modeling resources:

- `matsim-libs/`
- `sumo/`
- `urbansim/`
- `DTALite/`
- `tbest-tools/`

Do not delete or clean them as accidental untracked files. Use them as bridge targets when implementing detailed model adapters.
