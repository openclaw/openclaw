---
summary: "CLI reference for `openclaw clawmodeler` transportation modeling workflows"
read_when:
  - You want to run ClawModeler workspace, demo, workflow, bridge, or graph commands
  - You need the OpenClaw wrapper for the `clawmodeler-engine` Python sidecar
title: "clawmodeler"
---

# `openclaw clawmodeler`

Run ClawModeler transportation sketch-planning workflows through the local Python sidecar.

The command forwards arguments to `python3 -m clawmodeler_engine`. Outputs are screening-level unless a workspace includes calibrated model inputs, validation evidence, and method notes that support a detailed analysis tier.

## Common commands

```bash
openclaw clawmodeler doctor
openclaw clawmodeler tools --json
openclaw clawmodeler init --workspace ./demo
openclaw clawmodeler demo --workspace ./demo
```

## Workflow commands

```bash
openclaw clawmodeler workflow full \
  --workspace ./demo \
  --inputs zones.geojson socio.csv network_edges.csv projects.csv feed.zip \
  --question question.json \
  --run-id demo \
  --scenarios baseline scenario-a

openclaw clawmodeler workflow demo-full --workspace ./demo --run-id demo
openclaw clawmodeler workflow report-only --workspace ./demo --run-id demo
openclaw clawmodeler workflow diagnose --workspace ./demo
```

## Stage commands

```bash
openclaw clawmodeler intake --workspace ./demo --inputs zones.geojson socio.csv
openclaw clawmodeler plan --workspace ./demo --question question.json
openclaw clawmodeler run --workspace ./demo --run-id demo --scenarios baseline scenario-a
openclaw clawmodeler export --workspace ./demo --run-id demo --format md
```

## Bridge commands

```bash
openclaw clawmodeler bridge prepare-all --workspace ./demo --run-id demo
openclaw clawmodeler bridge validate --workspace ./demo --run-id demo
openclaw clawmodeler bridge sumo prepare --workspace ./demo --run-id demo
openclaw clawmodeler bridge matsim prepare --workspace ./demo --run-id demo
openclaw clawmodeler bridge urbansim prepare --workspace ./demo --run-id demo
```

## Graph commands

```bash
openclaw clawmodeler graph osmnx \
  --workspace ./demo \
  --place "Davis, California, USA"

openclaw clawmodeler graph map-zones --workspace ./demo
```

## Notes

- `doctor` and `tools` inspect local Python modules, external binaries, and model bridge directories.
- Report export is blocked when ClawQA cannot find a manifest or fact-block evidence.
- Direct sidecar access is available with `python3 -m clawmodeler_engine --help`.

See [ClawModeler Stack](/clawmodeler-stack) for workspace contracts, analysis modules, bridge packages, and install profiles.
