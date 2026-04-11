# ClawModeler Install Profiles

Use `install-profile.sh` to install optional Python dependencies for increasingly capable local modeling profiles.

```bash
python3 -m pip install -e .
bash scripts/clawmodeler/install-profile.sh light
bash scripts/clawmodeler/install-profile.sh standard
bash scripts/clawmodeler/install-profile.sh full
bash scripts/clawmodeler/install-profile.sh gpu
bash scripts/clawmodeler/check-packaging.sh
```

Profiles:

- `light`: fast screening stack.
- `standard`: GIS, OSM routing, GTFS, plotting, and report tooling.
- `full`: simulation, optimization, matrix, and bridge tooling.
- `gpu`: full plus PyTorch and ML libraries.

System binaries such as GDAL, Java, SUMO, Pandoc, Graphviz, Docker, and local model source trees are checked by `openclaw clawmodeler doctor` but are not installed by this script.

Environment overrides:

- `CLAWMODELER_TOOLBOX`: path to a custom toolbox JSON.
- `CLAWMODELER_MODEL_ROOT`: path containing local model source trees such as `sumo/`, `matsim-libs/`, `urbansim/`, `DTALite/`, and `tbest-tools/`.

Installed sidecar entry point:

```bash
clawmodeler-engine --help
```

Packaging check:

```bash
pnpm clawmodeler:check
```

The check runs the sidecar unit tests, builds the wheel, verifies packaged sidecar files, installs the wheel into a temporary virtual environment, and checks the installed `clawmodeler-engine` console script.
