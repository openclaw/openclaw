---
summary: "Create, validate, and prepare native iOS apps from OpenClaw prompts"
read_when:
  - Creating apps from prompts
  - Validating generated iOS app scaffolds
  - Preparing App Store readiness evidence
title: "Apps CLI"
---

The `openclaw apps` command is the CLI-first app builder lane. It creates native SwiftUI iOS app scaffolds, writes machine-readable build evidence, validates the local Xcode toolchain, and checks App Store readiness gates without uploading or submitting anything automatically.

The same lane is available in Control UI as [App Studio](/web/app-studio). App Studio adds a prompt-first dashboard, a Local Qwen Q8 vs Codex GPT-5.5 build-engine selector, an agent workboard showing exactly what each lane is doing, optional screen-picture imports, a visible screen connection map, screen reordering, completion grade and criticality display, Apple metadata reference entry, and one-click access to the gates below. The current prompt-change implementation updates the app blueprint, constrained builder task, screen flow, and app-local SwiftUI screen implementation. The dashboard **Run AI build pass** gate now connects to the selected Qwen/Codex coder, requests a JSON-only app-local patch plan, applies it through the guarded patch executor, and records AI/patch evidence.

## Create a native iOS app

```bash
openclaw apps create "Create a habit tracker for the Apple Store" --name HabitForge
```

The generated app includes:

- `project.yml` for XcodeGen
- SwiftUI source under `Sources/`
- XCTest coverage under `Tests/`
- `Sources/PrivacyInfo.xcprivacy`
- App Store metadata and signing stubs under `AppStore/`
- `AppStore/ExportOptions.plist` for a gated archive/export lane
- screenshot and privacy evidence placeholders
- `.openclaw-app-builder/product-spec.json`
- `.openclaw-app-builder/build-packet.json`
- `.openclaw-app-builder/evidence-ledger.json`
- `.openclaw-app-builder/implementation-report.json` after `openclaw apps build --apply`
- `.openclaw-app-builder/screen-image-brief.json` after optional App Studio screen-picture import
- `.openclaw-app-builder/screen-vision-task.md` after optional App Studio screen-picture import
- `.openclaw-app-builder/patch-report.json` and `patch-transcript.json` after `openclaw apps patch`

## Validate the iOS toolchain

```bash
openclaw apps ios-toolchain
openclaw apps ios-toolchain --json
```

This checks `xcodebuild`, `xcrun simctl`, and `xcodegen` from the current host environment.

## Validate a generated app

```bash
openclaw apps ios-validate ./generated-apps/habitforge --run-xcodegen
openclaw apps ios-validate ./generated-apps/habitforge --run-xcodebuild
```

Validation writes `.openclaw-app-builder/ios-validation-report.json` and appends to the evidence ledger. The command fails closed when required structure, toolchain checks, XcodeGen generation, or simulator tests fail.

## Capture simulator screenshot evidence

```bash
openclaw apps screenshots ./generated-apps/habitforge
openclaw apps screenshots ./generated-apps/habitforge --simulator "iPhone 17 Pro"
```

This command regenerates the Xcode project, builds the app for the simulator, boots the selected simulator if needed, installs and launches the app, captures a PNG under `Screenshots/`, writes `.openclaw-app-builder/screenshot-report.json`, and appends to the evidence ledger. It does not sign, upload, publish, submit, or contact App Store Connect.

## Prepare builder task prompt

```bash
openclaw apps build ./generated-apps/habitforge --dry-run
openclaw apps build ./generated-apps/habitforge --apply --engine "Codex GPT-5.5"
openclaw apps patch ./generated-apps/habitforge --plan patch-plan.json --run-xcodegen
openclaw apps repair ./generated-apps/habitforge --run-xcodegen
openclaw apps final-verify ./generated-apps/habitforge
```

The build command creates a constrained task prompt with `--dry-run`. With `--apply`, it runs the deterministic app-local SwiftUI implementation pass, writes `.openclaw-app-builder/implementation-report.json`, and updates only `Sources/AppModels.swift` and `Sources/ContentView.swift` so the app renders all product-spec screens with local create, toggle, delete, relaunch persistence backed by Codable records in `UserDefaults`, and visible `NavigationLink` rows for the product spec `screenFlow`. It does not install dependencies, read secrets, contact App Store Connect, upload, publish, or submit.

Generated product specs include an app-local `screenFlow` map. The default flow links each screen to the next screen and loops back to the start. App Studio can refresh the flow from drag/drop screen ordering, optional notes such as `Home → Settings`, or manual links added in the **Screen connection map** editor.

Optional screen-picture import is dashboard-first. Uploading images in App Studio stores them under `DesignInputs/screens/`, shows previews in the dashboard, writes `.openclaw-app-builder/screen-image-brief.json` and `.openclaw-app-builder/screen-vision-task.md`, infers screen titles from file names or sketch notes, and refreshes `product-spec.json` plus `screenFlow`. This is not required for App Store readiness; it is a convenience lane for sketches, screenshots, or wireframes. Full multimodal vision extraction from the pixels remains a future guarded model pass, but the vision task file gives the selected Visual Mapper model a deterministic JSON-output contract. The dashboard can now apply that returned JSON with **Apply AI picture analysis**, which merges analyzed screens, questions, and tap links back into the product spec and generated Swift screen-flow files.

The patch command applies a JSON patch plan from an approved app-builder engine (`Local Qwen Q8`, Qwen model refs, or `Codex GPT-5.5`). It scope-checks every write, rejects paths outside the app-local approved surface, rejects app-local symlink traversal, honors optional `oldContentSha256` preconditions, and applies the plan only when every requested write passes those safeguards. It then reruns the selected validation scope, writes `.openclaw-app-builder/patch-report.json`, and records the model patch plan plus validation evidence in `.openclaw-app-builder/patch-transcript.json`.

The repair command checks existing source traceability and validation evidence, reapplies the app-local implementation pass when source or validation is broken, reruns the selected validation scope, writes `.openclaw-app-builder/repair-report.json`, and appends repair-loop evidence. It uses the same app-directory-only safety rules and does not install dependencies, read secrets, contact App Store Connect, upload, publish, or submit.

The final verifier command writes `.openclaw-app-builder/final-verifier-report.json`. It is evidence-only: it checks implementation, local validation, prior `xcodebuild` evidence, model readiness, screenshot evidence, App Store evidence, the human-gated publish plan, and secret-scan results without mutating source or contacting App Store Connect. Use `--allow-structural-validation` only for local dry runs when prior simulator test evidence is not expected.

In App Studio, the dashboard writes `.openclaw-app-builder/app-studio-agent-task.md` beside the CLI builder task. That dashboard task records the selected build engine and the agent workboard. Choose Local Qwen Q8 for private local drafting or Codex GPT-5.5 for a stronger Codex coding pass; **Run AI build pass** records `.openclaw-app-builder/ai-build-report.json`, `.openclaw-app-builder/patch-report.json`, and `.openclaw-app-builder/patch-transcript.json`. Both paths still require the same local validation and human publish approvals.

The generated build packet pins the approved model lane instead of using a vague
builder label:

- Planner: `openai/gpt-5.5` through the Codex runtime with `openai-codex` auth
- Builder: `ollama/qwen3.6:27b-q8_0`, the highest-quality local Qwen Q8 coder
  model available in this OpenClaw setup
- Local fallback: `ollama/openclaw-control-qwen3-30b-q6-chatfix:latest`, the
  stable local Qwen Q6_K fallback coder model
- Builder params: `temperature=0.15`, `topP=0.9`, `topK=20`, `repeatPenalty=1.05`, `numCtx=65536`, `numPredict=8192`, `think=false`
- Repair fallback: `openai/gpt-5.5` through Codex, only after local Qwen failure evidence or explicit human approval
- Final verifier: `openai/gpt-5.5` through Codex with `xhigh` reasoning before TestFlight/App Review actions
- Disabled reviewer lanes: Claude and Gemini

## Verify the app-builder model lane

```bash
openclaw apps model-check ./generated-apps/habitforge
openclaw apps model-check ./generated-apps/habitforge --ollama-base-url http://127.0.0.1:11434 --json
```

The model check writes `.openclaw-app-builder/model-readiness-report.json`. It
fails closed unless the generated app's build packet still uses the approved
Qwen Q8 primary, Qwen Q6 local fallback, and Codex verifier routing. Ollama must
report both `qwen3.6:27b-q8_0` and
`openclaw-control-qwen3-30b-q6-chatfix:latest` with digests. This gate must pass
before a future autonomous implementation loop is allowed to mutate generated
app files.

## Check App Store readiness

```bash
openclaw apps app-store-ready ./generated-apps/habitforge
```

The command writes `.openclaw-app-builder/app-store-readiness.json` and blocks submission until required evidence is present, including App Store Connect app record reference, bundle ID, SKU, team ID, signing profile references, screenshots, metadata, support and privacy URLs, age rating, privacy nutrition labels, accessibility notes, review contact, and approval evidence.

## Generate the gated publish plan

```bash
openclaw apps publish-plan ./generated-apps/habitforge
openclaw apps publish-plan ./generated-apps/habitforge --json
```

The publish plan writes `.openclaw-app-builder/app-store-publish-plan.json` with the archive, export, TestFlight upload, manual review, and rollback steps. The plan is non-executing and remains blocked until the App Store evidence gates pass.

## Review app-builder gaps

```bash
openclaw apps gaps ./generated-apps/habitforge
openclaw apps gaps ./generated-apps/habitforge --json
```

The gaps command writes `.openclaw-app-builder/gap-report.json` with a prioritized score, strengths, missing evidence, unsafe drift, placeholder metadata, screenshot proof status, publish-plan status, and next actions. This is the fastest way to see what prevents the generated app from being ready for autonomous implementation or publishing.

## Summarize readiness

```bash
openclaw apps ready ./generated-apps/habitforge
openclaw apps ready ./generated-apps/habitforge --json
```

The readiness summary reports whether the app is ready to build, whether it is ready for App Store submission, a completion grade, the criticality of the next gap, and the next most impactful gap.
