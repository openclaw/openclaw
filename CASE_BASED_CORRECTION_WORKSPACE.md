# Case-Based Correction Workspace

## Status

- This file records the current product freeze that combines:
  - session `019d346c-c72f-77d1-83ec-5b36dbfb5e91` for the correction engine logic
  - session `019d3825-4d57-7d72-a65c-6225857638c5` for the approved logo and Apple-native interaction direction
- This is shared implementation context for parallel sessions inside this repo.
- Implemented in the native app now:
  - a macOS `Correction Workspace` shell with `Summary`, `Seats needing attention`, and `Detail / intervention`
  - shared JSON-backed `CorrectionCasebookStore` persistence in `OpenClawKit`
  - per-bot medical record tracking with recurrence, last outcome, and treatment history
  - casebook-aware detail history inside `CorrectionWorkspaceView`
  - activity cases now resolve `sessionKey -> stable bot identity` before writing into the casebook
  - global remedy-template promotion accounting now derives candidate readiness across multiple bots
  - cross-bot diagnosis portfolio guidance now derives:
    - how many bots have shown the same diagnosis
    - which remedy template is the cleanest precedent
    - whether the current intervention matches that precedent
    - which root cause has appeared most often in recorded cases
  - synthetic randomized bot trial scaffolding now persists:
    - automatic trial-batch staging once three candidate templates exist
    - a temporary randomized bot profile for the staged batch
    - per-template three-round synthetic validation progress and outcomes
    - universal-template promotion state after clean synthetic passes
  - synthetic randomized bot trials now execute inside the native app:
    - `CorrectionSyntheticTrialRunner` opens a temporary synthetic session through the gateway
    - the runner builds a casebook-derived prompt from diagnosis, remedy, root cause, and evidence
    - the runner waits for a real assistant reply, evaluates whether it is specific and evidence-grounded, then records pass or fail back into the casebook
    - the temporary synthetic session is deleted after each validation run
    - the native workspace can now run the whole pending synthetic validation queue, not just one round at a time
  - native template validation copy now reflects:
    - staged
    - validating
    - blocked by synthetic failure
    - universal-ready
  - native summary now reflects live synthetic validation runtime state while the queue is running
  - intervention dispatch is now confirmation-first in the native workspace:
    - synthetic validation actions show the exact prompt before execution
    - case-level intervention actions show the destination lane and exact correction payload before send
    - confirmed intervention sends now target the live bot session instead of only opening chat
    - confirmed intervention sends now write dispatch timestamp and dispatch summary back into the active casebook treatment
  - native detail now exposes a `Similar cases / research` section derived from the casebook:
    - cross-bot symptom scope
    - other active bots with the same diagnosis
    - leading recorded root causes
    - strongest current remedy precedent
    - persisted external web research query, refresh time, and captured public references
  - native detail now exposes an `Intervention progress` section derived from active treatment state:
    - current treatment label
    - when the current round opened
    - whether fresh runtime output landed after treatment began
    - whether a fresh artifact has appeared yet
  - selected native cases now auto-refresh external symptom research:
    - the app queries public web references for the active diagnosis cluster
    - fetched web references are written back into the active case and pending treatment in the casebook
    - failed refreshes also write back a visible summary instead of silently disappearing
    - intervention dispatch payloads now include the captured external web references
- Verified locally now:
  - `CorrectionCasebookStoreTests` passes with the Xcode toolchain
    - includes intervention-dispatch persistence coverage
    - includes external-web-research persistence coverage
  - `CorrectionDiagnosisPortfolioTests` passes with the Xcode toolchain
  - `CorrectionSyntheticTrialTests` passes with the Xcode toolchain
  - `CorrectionTemplatePortfolioTests` passes with the Xcode toolchain
  - `CorrectionSyntheticTrialRunnerTests` passes with the Xcode toolchain
  - `CorrectionWebResearchStoreTests` passes with the Xcode toolchain
  - `LowCoverageViewSmokeTests` passes with the Xcode toolchain, including `CorrectionWorkspaceView`
  - `HoverHUDControllerTests` passes with the Xcode toolchain after the singleton test fix
  - macOS target `OpenClaw` builds successfully with the Xcode toolchain after the synthetic runner integration
  - the previously blocking `HoverHUDControllerTests` compile failure was fixed by updating the test to use the singleton controller

## Product Position

- The app is not a web console and not just an alarm board.
- The app is a native Apple-style correction workspace for supervising bots that drift into hallucination, laziness, blocked execution, weak evidence, or bad working attitude.
- Product skeleton:
  - case-based precise correction
- Product shell:
  - Apple-native multi-agent evidence and intervention workspace
- Current augmentation:
  - keep the case-based loop as the backbone
  - add a professional-role contract overlay so the app can diagnose role drift,
    not just generic "bad behavior"
  - treat hallucination, fake completion, overreach, and disobedience as
    occupational-role contract violations when possible

## Non-Negotiables

- Do not ship a surface that only says something is wrong.
- Every visible alert should be able to resolve into:
  - what is wrong
  - why it is likely wrong
  - whether this happened before
  - what treatment should be applied now
  - whether the treatment actually worked
- Correction logic must be evidence-first and operational, not decorative.

## Approved Native Surface

- Preserve the interaction direction already approved in session `019d3825-4d57-7d72-a65c-6225857638c5`.
- Visual and interaction cues to preserve:
  - Apple-native feel
  - warm sand `#eacda2` plus warm charcoal `#0e1011`
  - reduced noise, restrained effects, professional tone
  - three-layer structure:
    1. `Summary`
    2. `Seats needing attention`
    3. `Detail / intervention`
  - native semantics where helpful:
    - sidebar
    - segmented control
    - detail pane
    - search, filter, sort
  - send or dispatch actions should stay confirmation-first

## Core Correction Loop

1. Observe live bot state, output quality, timing, tool traces, and evidence chain.
2. Diagnose the likely failure mode for the specific bot and domain.
3. Infer or load the bot's professional role contract.
4. Mark whether the failure also represents role drift against that contract.
5. Check recurrence in the bot's own medical record or casebook.
6. Pull similar symptoms from prior local cases and web research.
7. Produce a concise prescription line that tells the bot what to do next.
8. Apply or arm the correction template.
9. Verify whether output quality materially improved.
10. Record success, failure, recurrence, and notes back into the casebook.

## Required Data Model

- `CorrectionCase`
  - one observed incident under active remediation
- `EvidenceItem`
  - logs, tool traces, timeout facts, output defects, acceptance failures
- `Diagnosis`
  - machine-readable id plus short human label
- `Prescription`
  - one-line treatment plus supporting steps
- `BotMedicalRecord`
  - long-term per-bot case history
- `TemplateCandidate`
  - reusable correction pattern under evaluation
- `TemplateValidationRun`
  - one measured attempt to validate a template
- `SyntheticBotTrial`
  - temporary randomized bot used to test whether a template generalizes

## Bot Medical Record

- Each bot should have its own long-term record in OpenClaw storage.
- Minimum record contents:
  - recurring diagnosis ids
  - domain or role context
  - prior prescriptions
  - success and failure counts
  - known triggers
  - evidence snapshots
  - notes on what actually fixed the problem
- The record is a correction resource, not just a log archive.

## Template Promotion Pipeline

- A template is not "universal" because it sounds good.
- Promotion requirements from the user directive:
  - run the template on different bots
  - at least three full successful rounds are required before adding it as a candidate backup template
  - once three candidate templates exist, begin self-test with a temporary randomized bot
  - the temporary bot should receive random persona and profile data, then be deleted after testing
  - each template must pass three correction trials on the synthetic bot
  - any failed round means the template is not universal
- Only templates that survive this loop can be treated as general-purpose correction templates for the app.

## Architecture Direction

- Target one native correction workspace, not separate mini-products.
- Preferred surface mapping:
  - `Summary`
    - health snapshot, evidence coverage, top active diagnoses, template readiness
  - `Seats needing attention`
    - sortable list of bots with severity, recurrence, and recommended next action
  - `Detail / intervention`
    - evidence chain, diagnosis, prescription, case history, template choice, validation outcome
- `Chat` belongs inside intervention, not as a detached product identity.
- `Canvas` can remain an auxiliary visualization surface, not the main product skeleton.
- `Settings` should remain actual preferences, not the primary workflow.

## Immediate Implementation Implication

- When refactoring native app structure, move toward a unified correction workspace.
- When refactoring shared logic, prioritize:
  - evidence chain closure
  - diagnosis and prescription generation
  - casebook persistence
  - template validation accounting
- Do not overwrite the approved UI layer while doing this work.

## Launch Gate For This Product Shape

- The app is not ready to ship if:
  - it only detects issues but cannot recommend a treatment
  - it has no persistent per-bot casebook
  - it cannot show whether the same disease has happened before
  - it cannot measure whether correction templates are actually effective
  - the native shell drifts away from the approved Apple-style interaction direction
