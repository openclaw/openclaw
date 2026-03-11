## END-7 builder review

### What changed

- Added a dedicated `/pilot` shell with a pilot dashboard and source-health framing (`ui/pilot/index.html`, `ui/src/pilot/home.ts`, `ui/src/pilot/styles.css`).
- Added `/pilot/project` intake for parcel ID, address, and project scope with project workspace launch links (`ui/pilot/project/index.html`, `ui/src/pilot/project.ts`).
- Added pilot-only persistence for `jurisdictions`, `parcels`, and `projects` in local storage, separate from generic chat context (`ui/src/pilot/storage.ts`).
- Updated the operator harness browser runtime to preserve `review.md` across reruns while regenerating screenshots/video/log output (`src/operator-harness/browser-runtime.ts`).

### What I validated

- Ran the canonical walkthrough validation command from the task packet:
  - `node --import tsx operator-harness/scripts/run-artifact-walkthrough.ts --task .openclaw-operator/task-builder.json`
- Confirmed browser assertions pass for:
  - Pilot Home title and Source pack health dashboard card
  - New project form fields (parcel/address/scope)
  - Project creation summary and launch-workspace CTA
- Confirmed required artifact set exists in `operator-harness/evidence/END-7/builder`:
  - `before.png`, `after.png`, `annotated.png`, `walkthrough.webm`, `serve.log`, `review.md`

### Residual risk

- Pilot persistence is currently browser-local (`localStorage`) and not yet backed by server-side storage, so records are per-browser and can be cleared by users.
