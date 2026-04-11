# ClawModeler Roadmap

This document keeps the transportation-modeling workbench focused. The goal is not to keep adding disconnected model adapters forever. The goal is an installable OpenClaw transportation edition where agents can run a complete, reproducible modeling workflow, choose defensible methods, prepare external engine packages, validate outputs, and explain limitations.

## End Goal

ClawModeler should let a user install this OpenClaw fork and ask agents to handle transportation demand modeling end to end:

- discover local transportation models, Python libraries, runtimes, and data tools,
- ingest local planning data into a predictable workspace,
- select the strongest modeling method justified by available data and tools,
- run a screening workflow when detailed calibrated inputs are not available,
- prepare handoff packages for detailed engines such as SUMO, MATSim, UrbanSim, DTALite, and TBEST,
- validate generated artifacts before using them,
- export reports only from auditable fact blocks and manifests,
- clearly label assumptions, missing data, and screening-level results.

## Current Checkpoint

The current stack is a usable foundation when it can do these things:

- `openclaw clawmodeler doctor` and `tools` expose the local modeling lab.
- `workflow full` handles init, intake, planning, run, report export, bridge preparation, and bridge validation.
- `workflow demo-full` gives a known-good smoke path.
- `workflow report-only` refreshes reports and bridge validation for an existing run.
- `workflow diagnose` explains missing data, missing tools, and likely next steps.
- Bridge packages are generated for SUMO, MATSim, UrbanSim, DTALite, and TBEST where inputs support them.
- QA blocks unsupported report export.
- The sidecar can be installed as a Python package with the `clawmodeler-engine` entrypoint.

That is the right boundary for this phase. More features should strengthen these contracts before expanding into deeper calibration or engine-specific execution.

## Rabbit Holes To Avoid

Do not spend the next phase hand-tuning every possible external engine option. Bridge packages should be valid, inspectable starter packages until real project requirements demand deeper controls.

Do not claim calibrated forecasts from proxy accessibility, VMT, or demand logic. These are screening methods unless the workspace includes calibrated model inputs and validation data.

Do not add GPU or ML workflows just because the toolbox can expose PyTorch and similar libraries. Use them only when there is a defined training target, validation set, and model-governance story.

Do not vendor large upstream model source trees into the Python package by accident. Local model directories can be available to agents, but packaging should stay lean unless there is an explicit submodule, artifact, or distribution decision.

Do not let CLI orchestration, workflow orchestration, and tests drift into three separate versions of the same behavior. Shared contracts should be pulled into reusable functions as the stack hardens.

## Next Engineering Milestones

1. Stabilize orchestration internals.

   Move duplicated CLI and workflow stage logic into shared service functions so `workflow full`, manual commands, and tests exercise the same code paths.

2. Version the workspace contract.

   Add explicit schema versions for `question.json`, `analysis_plan.json`, `manifest.json`, `qa_report.json`, bridge manifests, and workflow reports. Add validation helpers and focused tests for required fields.

3. Add small public integration fixtures.

   Keep the built-in synthetic demo, then add one tiny real-world fixture path for zones, GTFS, network edges, and bridge preparation. The fixture should be small enough for CI.

4. Add CI packaging checks.

   Verify Python tests, TypeScript CLI tests, editable install, wheel build, package-data inclusion, and `clawmodeler-engine --help`.

5. Harden bridge adapters before adding new ones.

   Improve SUMO, MATSim, UrbanSim, DTALite, and TBEST validation reports with clearer missing-input explanations and links to generated files. Add actual engine execution only after generated packages are stable.

6. Add calibrated-model execution gates.

   Before agents run detailed external engines as authoritative forecasts, require project-specific calibration inputs, validation checks, and method notes in the manifest.

7. Add optional ML workflows last.

   Expose ML libraries through the toolbox, but keep ML-assisted forecasting behind explicit data, validation, reproducibility, and reporting requirements.

## Decision Gates

Proceed to detailed traffic assignment only when the workspace includes a usable network, OD or demand data, and a validation target.

Proceed to transit ridership forecasting only when the workspace includes GTFS, stop or route context, demand drivers, and a validation target.

Proceed to land-use interaction modeling only when the workspace includes land-use inventory, household/job controls, and scenario assumptions.

Proceed to ML or GPU methods only when the workspace includes enough labeled data to validate the model and the report can explain the method plainly.

Proceed to production packaging only when the wheel excludes accidental heavyweight source trees and still includes the packaged default toolbox.

## Definition Of Done For The Next Pass

The next pass is done when the core orchestration is easier to maintain, workspace artifacts have versioned contracts, and the install/test path can run in CI without relying on the developer's local environment.
