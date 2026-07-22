# Release Handoff

Use this compact record to start or resume one release session. Replace every
placeholder with current live state. Omit completed detail that is already
captured by a durable run or artifact URL.

## Goal

Ship `<version>` on `<channel>` and stop when `<terminal success criteria>`.

## Immutable state

- release track: `<regular beta/stable | extended-stable>`
- branch: `<release/YYYY.M.PATCH | extended-stable/YYYY.M.33>`
- cut SHA: `<full sha>`
- Code SHA: `<regular release full sha | not applicable>`
- Release SHA: `<regular release full sha | exact extended-stable branch tip>`
- tag: `v<version>`
- workflow ref: `<release-ci ref | canonical extended-stable branch>`
- publication inventory: `<regular orchestrated surfaces | exact extended-stable surfaces>`
- approved backports: `<none or exact PRs/commits>`
- approved main changes: `<none or exact blocker>`
- frozen-target compatibility repairs: `<none or exact PRs/invariants>`

## Active evidence

- Full Release Validation parent: `<run id / attempt / URL or none>`
- npm preflight: `<run id / URL or none>`
- Plugin NPM Release: `<run id / URL or none>`
- publish parent: `<run id / URL or none>`
- Docker Release / channel repair: `<run ids / immutable tags / aliases or none>`
- immutable successful children: `<run ids / artifacts or none>`
- registry/provenance readback: `<artifact or command result>`

## Phase

- completed: `<phases that stay complete>`
- current: `<one phase>`
- next action: `<one concrete action>`

## Failure policy

- regular product/code failure: fix the release branch, freeze a new Code SHA,
  and invalidate downstream product evidence
- regular changelog-only failure: change only `CHANGELOG.md`, freeze a new
  Release SHA, and reuse green Code SHA evidence after delta proof
- extended-stable product or changelog failure: land an approved branch PR,
  freeze the new exact tip, and replace all exact-head validation evidence
- extended-stable frozen-target incompatibility: land only the smallest
  branch-owned workflow/harness repair, record its source and invariant, and
  replace all exact-head validation evidence
- workflow/tooling/credential failure: keep the candidate frozen and recover
  the smallest owning surface
- external approval or permission blocker: stop with the exact job, URL,
  missing permission, and required operator action

Do not scan moving `main`, add optional backports, dispatch a replacement
validation parent, or repeat completed phases unless a named invalidating event
requires it. For extended-stable, resume only after rechecking that the branch
tip, immutable tag, versions, workflow run identities, and registry selectors
still agree.

## Stop conditions

- success: `<exact published and verified state>`
- blocked: `<one precise external action that only the operator can complete>`
