---
summary: "Prompt-first App Studio dashboard for native iPhone apps and App Store readiness"
read_when:
  - You want to use or change the App Studio dashboard
  - You are building prompt-first native iOS apps in Control UI
  - You need the Xcode, TestFlight, or App Store handoff rules
title: "App Studio"
---

App Studio is the Control UI dashboard for creating and preparing native iPhone apps from prompts. It wraps the `openclaw apps` CLI lane with a beginner-readable workflow:

**Prompt → Blueprint → Build gates → Preview → TestFlight plan → App Store evidence**

The dashboard is designed for non-technical operators. The first action is always a plain-English prompt. The advanced controls stay visible, but they are expressed as concrete checks: model readiness, project validation, screenshots, App Store evidence, and publish planning.

## What App Studio creates

When you click **Build new app**, App Studio creates a generated SwiftUI project with:

- XcodeGen project files
- SwiftUI source and XCTest files
- privacy manifest and App Store metadata stubs
- `.openclaw-app-builder/product-spec.json`
- `.openclaw-app-builder/build-packet.json`
- `.openclaw-app-builder/app-studio-project.json`
- `.openclaw-app-builder/app-studio-agent-task.md`
- `.openclaw-app-builder/screen-image-brief.json` after optional screen-picture import
- `.openclaw-app-builder/screen-vision-task.md` after optional screen-picture import
- evidence ledger entries for later readiness checks

The build packet keeps the safe default lane pinned, and the dashboard adds an explicit build-engine selector:

- Local Qwen Q8: `ollama/qwen3.6:27b-q8_0`
- Codex GPT-5.5: `openai/gpt-5.5`
- local fallback: `ollama/openclaw-control-qwen3-30b-q6-chatfix:latest`
- Codex verifier and repair-review lane: `openai/gpt-5.5`
- Claude and Gemini reviewers disabled

Choosing Codex routes the next App Studio code-mutation task to Codex while keeping the local validation, screenshot, App Store evidence, and human publish-approval gates unchanged.

## Agent workboard

Every selected app shows an **Agent workboard**. It is intentionally plain: each card names the agent, model/tool, current task, inputs, outputs, blockers, and last event.

The selected app also shows a **Live updates** panel and an **AI build status** panel above the workboard. Use them to test whether the app builder is truly active: they show the current worker, recent evidence events, selected coder, current task, whether the last run connected to AI, changed files, raw-output hash, evidence artifacts, an evidence-proof card from the latest AI/patch reports, next actions, and a direct **Run AI build pass** button.

The stage rail is actionable. A newly created app opens at **Blueprint** because the scaffold and product spec already exist; from there, the stage cards expose the next concrete gate: **Check AI coder**, **Run AI build**, **Capture preview**, **Prepare TestFlight**, and **Check App Store**. While any gate or app edit is running, the dashboard polls the Gateway every few seconds and refreshes the live worker/evidence panels.

The default workboard lanes are:

- Product Planner: translates prompts into the product spec and visible blueprint.
- Visual Mapper: turns optional uploaded screen pictures and sketch notes into screens and tap-flow links.
- App Builder: uses the selected build engine, either Local Qwen Q8 or Codex GPT-5.5, for app-local SwiftUI changes.
- Local Validator: runs project-file, XcodeGen, `xcodebuild`, and screenshot gates.
- App Store Verifier: checks metadata, privacy, signing references, screenshots, and publish evidence.
- Human Publisher: tracks owner-only TestFlight upload and App Review submit approvals.

## Prompt changes

Use **Apply to selected app** to revise the selected app. The current implementation updates the product spec, visible screen list, prompt history, Swift feature summary, evidence ledger, and constrained builder task.

App Studio also applies the constrained app-local SwiftUI implementation pass so `Sources/ContentView.swift` renders every product-spec screen with local create, toggle, delete, relaunch persistence backed by Codable records in `UserDefaults`, and visible **Connected screens** `NavigationLink` rows from the product spec `screenFlow`. The pass writes `.openclaw-app-builder/implementation-report.json`, mutates only `Sources/AppModels.swift` and `Sources/ContentView.swift`, and still does not install dependencies, read secrets, contact App Store Connect, upload, publish, or submit.

Use **Run AI build pass** when you want the selected coding model to actually work on the app. App Studio now writes a running workboard state, asks the selected engine for a JSON-only app-local patch plan, applies that plan through the guarded patch executor, and records `.openclaw-app-builder/ai-build-report.json`, `.openclaw-app-builder/patch-report.json`, and `.openclaw-app-builder/patch-transcript.json`. The dashboard polls while the gate is active so the workboard shows whether the App Builder, Local Validator, or App Store Verifier is running, blocked, done, or idle.

For a browser-level proof that the dashboard is reading real build evidence, run `pnpm ui:build` and then `pnpm ui:smoke:app-studio`. The smoke starts an isolated Gateway, creates a sample app through App Studio, clicks **Run AI build pass**, waits for Local Qwen Q8 to return a patch plan, and verifies the dashboard plus `.openclaw-app-builder/ai-build-report.json`, `ai-build-raw-output.txt`, `patch-report.json`, and `patch-transcript.json`.

## Optional screen pictures

Screen pictures are optional. Use the **Optional pictures** panel when you have sketches, screenshots, or wireframes:

1. Upload one or more PNG/JPG images.
2. Optionally add short flow notes, such as `Home → Settings`.
3. Click **Import pictures to flow**.

App Studio stores the uploaded images under `DesignInputs/screens/`, writes `.openclaw-app-builder/screen-image-brief.json`, infers screen titles from file names or notes, updates `product-spec.json`, and refreshes the screen connection map. This does not replace prompt-based building and is not required for App Store readiness. Pixel-level multimodal interpretation is still a future guarded model pass; the verified implementation today uses file names and notes as the safe source of truth.

The dashboard shows selected-image previews before import and lists the most recent imported picture references after import. It also writes `.openclaw-app-builder/screen-vision-task.md`, a model-ready Visual Mapper packet that points at the stored images, current screens, current links, operator notes, and the required JSON shape for a future multimodal analysis pass. If a visual model or Codex returns that JSON, use **Apply AI picture analysis** to merge the analyzed screens, questions, and tap links into `product-spec.json`, `screenFlow`, `Sources/AppModels.swift`, and `Tests/GeneratedAppTests.swift`.

For deeper free-form implementation changes, use **Run AI build pass** in App Studio or `openclaw apps patch` with a JSON patch plan from the selected app-builder engine. The guarded patch executor scope-checks every app-local write, rejects symlink traversal, applies the plan only when every requested write is safe, validates the result, and records `.openclaw-app-builder/patch-report.json` plus `patch-transcript.json`.

## Drag and drop screens

The Blueprint panel lets you reorder screens by drag/drop or by the **Up** and **Down** buttons. Reordering updates the product spec and the generated Swift feature summary.

The same panel shows a **Screen connection map**. Each row shows `source screen → target screen` plus the tap trigger, so you can see relationships like `Home → Settings` before running the next implementation pass. You can add or remove links directly in the map by choosing **From**, **To**, **Button label**, and **Trigger**. Reordering screens refreshes the default flow; explicit import notes like `Home → Settings` or manually added links can override the default sequential flow.

The generated Swift tests now assert the exact number of screen-flow links, so an intentionally empty flow map remains valid after you remove all links in the dashboard.

## Build gates

App Studio exposes the same durable gates as the CLI:

- **Check AI coder**: verifies the selected dashboard coding lane and local fallback evidence.
- **Run AI build pass**: connects to the selected Local Qwen Q8 or Codex GPT-5.5 coder, requests a guarded app-local patch plan, applies it through the patch executor, and records AI/patch evidence.
- **Implement app UI**: applies the deterministic constrained SwiftUI implementation pass and records implementation evidence.
- **Check project files**: validates scaffold structure without host Xcode.
- **Build and test**: runs XcodeGen and `xcodebuild` validation.
- **Repair validation failure**: reapplies the app-local repair loop and reruns validation evidence.
- **Capture screenshot**: builds, installs, launches, and screenshots the simulator app.
- **Check App Store evidence**: verifies metadata, signing references, screenshots, privacy, and review-contact evidence.
- **Prepare publish plan**: writes the gated archive, export, TestFlight, and rollback plan.
- **Run final verifier**: writes the evidence-backed final verifier report before owner-controlled TestFlight/App Review actions.
- **Summarize readiness**: reports completion grade, criticality, and the next highest-impact gap.

No gate signs, uploads, publishes, submits, or contacts App Store Connect without a separate human-controlled step.

## Apple setup fields

The Apple setup panel stores references only. Do not paste private keys or secrets. Use it for:

- App Store Connect app ID
- SKU
- Apple Team ID
- signing identity and provisioning profile names
- App Store Connect API key profile reference
- support URL and privacy-policy URL
- review contact details

Actual credentials should remain in the normal OpenClaw credential and auth-profile locations.

## When to hand off to Xcode

Stay in App Studio while you are prompting, reviewing screens, running structure checks, filling metadata, and generating publish plans.

Open Xcode when one of these is true:

- local validation fails repeatedly and needs visual debugger inspection
- signing/provisioning requires manual Xcode account repair
- simulator UI polish needs direct inspection
- App Review rejection needs manual reproduction
- you are ready to archive after the publish plan and final verifier are green

## Related CLI commands

```bash
openclaw apps create "Create a habit tracker for the Apple Store" --name HabitForge
openclaw apps model-check ./generated-apps/habitforge
openclaw apps ios-validate ./generated-apps/habitforge --run-xcodegen
openclaw apps screenshots ./generated-apps/habitforge
openclaw apps app-store-ready ./generated-apps/habitforge
openclaw apps publish-plan ./generated-apps/habitforge
openclaw apps ready ./generated-apps/habitforge --json
```

See [Apps CLI](/cli/apps) for full command details.
