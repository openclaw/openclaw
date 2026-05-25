# GitHub Branch Protection — ClaWorks Required Checks

Settings → Branches → Require status checks:

- `claworks-smoke.yml` — PR runtime + smoke
- `claworks-weak-model-regression.yml` — PR + nightly
- `claworks-evolution-smoke.yml` — evolution PR + weekly

Local: `CLAWORKS_PREFLIGHT_EVOLUTION=1 CLAWORKS_PREFLIGHT_GATEWAY=1 pnpm claworks:release:preflight`
