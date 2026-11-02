# Mac exact-family artwork follow-up — parent dispatch packet

Preparation only. The two-file product slice is committed locally, not pushed or published. No native allocation, workflow dispatch, Mac build, or new PNG capture was performed by this child. Parent owns payload review, publication of the exact After commit, temporary workflow assembly/dispatch, native-result inspection, and chat/PR delivery. Do not dispatch until the After SHA is available in the checkout repository.

## Immutable inputs

| Role | Commit | Tree |
| --- | --- | --- |
| Before: original PR #190009 | `0b584645a34242f72b0566f8cf3acebd9ac63a73` | `685b7e59c940a055b0e998276c13ab19a110d6e8` |
| After: approved exact-family fix | `adcfa7ca4a204860ff67b5e1db4f45bd7d5c8a17` | `12fe3ed2d4c8dfd6757dd54fd6220ba9b74162a3` |
| P6 Gateway fixture producer / PR #191169 | `7830780292c95ac7f2e96ecee19cdfb1639393bb` | `adba24522319c79af72e3632b4e5483b90af53a4` |

`source.py` admits every tracked path, blob, executable mode, and symlink in each full checkout, exports complete SHA-256 manifests, and admits only the two reviewed changed paths before advancing one task-owned incremental build tree. No production source is replaced by the capture harness. Canonical source freezes occur before test instrumentation.

The unchanged After resource/alias test file is explicitly overlaid onto Before, so the same regression tests run on both production versions. This is a **test-only** Before overlay, recorded separately from canonical source identity. The native onboarding test file gets the private capture appendix on both stages. Original tests, appendix, and effective instrumented file hashes are exported.

## Same producer-derived fixture, both stages

`derive-fixtures.mjs` reads exact P6 metadata, provider note, server label, and endpoint default. It produces four choices: **Llama app**, **Built-in local AI**, **Existing llama.cpp server**, and **Ollama**, each with the producer-owned **Set up** action. It does not derive copy from historical native-source plugin metadata, override Gateway policy in Swift, or claim automatic installation of Llama app. `validate-fixtures.mjs` compares all fixtures with those producer contracts and checks actual native-source and producer wire schemas using pinned TypeBox/esbuild.

Synthetic existing model/config remains unchanged. The mounted views are real production `OnboardingView.aiSetupPage` and `OnboardingAISetupSheet` with an in-memory fixture Gateway. Model calls enter prepare/note/endpoint presentation; there are no native user-click, real installation, real server, inference, activation, or default-mutation claims. Exactly detect, prepare-start, and wizard-next are admitted.

## Corrected private capture contract

The prior native run used requested seed heights (380/300) as a PNG oracle even though SwiftUI legitimately sized the actual sheets to 221/220. This packet is for a **new changed candidate**, not an unchanged rerun for green.

`source-contracts.py` binds sheet constraints to the actual production source: `.frame(width: 500)` and `.frame(minHeight: 220)`. The private appendix records the **final NSHostingView bounds**, screen bounds, backing scale, bitmap dimensions, AX content/control frames, and the managed row frame at capture time. PNG dimensions must match those final bounds at the actual 1x/2x scale. Requested window seed heights are retained only as diagnostics, never accepted as screenshot dimensions.

Required visible text, all four enabled provider actions, wizard buttons, the full note, the endpoint field, and captured control geometry remain required. Missing, clipped, blank, malformed, or duplicate frames fail. The managed llama.cpp row must have different pixels in its same-frame AX-bounded region; unchanged app-sheet pairs may legitimately match. No product layout, targets, assertions, or sandbox restrictions were relaxed.

## Qualified route and budget

- `macos-26` Apple Silicon, `/Applications/Xcode_26.4.1.app/Contents/Developer`, exact Swift **6.3.1**, macOS/SDK >=26.2. No fallback binary, host, lower deployment target, or paid VM.
- Same standard resource admission and **-j 2**, sequential incremental native builds, 150-minute job budget as the qualified original route; >=3 logical CPU, >=7 GB RAM, >=8 GiB currently-free disk.
- Source-pinned Node 24.22.1 / pnpm 12.15.0; frozen pnpm locks, `--force-resolved-versions`, unchanged Package.resolved files and maintained reduced debug/index settings.
- Existing pinned checkout/setup-node/upload-artifact actions in the workflow fragment are reused. `persist-credentials: false`, contents-read only.
- Disposable secretless runner only. Native execution retains the maintained `macos-health-render.sb` sandbox, network/Keychain/preferences-service restrictions, private HOME/state/TMPDIR, `env -i`, fixed English/light appearance. No operator desktop execution.

## Invocation and payload

Copy only files listed in `INPUT-SHA256SUMS`, plus `INPUT-SHA256SUMS`, `READY.json`, and `SEAL-SHA256SUMS`, into the parent-owned temporary proof branch at `.github/native-llama/mac/`. Do not copy `.checks/`, Python caches, source checkouts, or old proof artifacts. Parent uses `workflow-job.yml.fragment` within a reviewed manual-only workflow. No dispatch has occurred.

```bash
/bin/bash .github/native-llama/mac/run-mac-ci.sh \
  "$GITHUB_WORKSPACE/.source-before" \
  "$GITHUB_WORKSPACE/.source-after" \
  "$GITHUB_WORKSPACE/.source-core" \
  "$GITHUB_WORKSPACE/.artifacts/native-llama/mac"
```

The output path must be fresh. The runner verifies the input seal before source execution. It first runs the five exact After alias/resource tests on Before: the one family-identity regression must record exactly three expected issues and complete; no other failure/skip/cancellation is accepted. The same suite must pass on After. Each stage independently runs the native capture test and exports raw Swift 6.3 event streams, logs, timings, and source freezes.

Expected new outputs: exactly **six raw PNGs**, `{before,after}/{onboarding,install-note,endpoint}.png`, matching AX geometry JSON, per-stage receipts, icon red/green event streams/verdicts, build/test/dependency/toolchain/resource logs, complete source manifests, instrumented-test hashes, `pixel-validation.json`, status, and `OUTPUT-SHA256SUMS` sealed after the log writer exits. Onboarding viewport is 630x1000; sheets use actual final native bounds under the product 500/min-220 contract.

## Remaining gates

Controller syntax/schema/validator checks are preparation evidence, not native execution. Swift parse/typecheck/build, executable native red/green results, all six new raw frames, actual geometry, pixel comparison, and human full-resolution inspection remain pending parent-coordinated CI. The six original Mac PNGs remain completed original-draft evidence and are not relabeled as this new candidate proof.

The parent must inspect all six new images, verify source/overlay/event/hash receipts, deliver inspected Before/After to the originating chat and the authorized follow-up PR, and verify PR rendering. No ready/merge action is authorized by this packet. Native client fallback copy remains a separate slice. Future PR credit must be followed immediately by `## Work sessions`, using the exact links below.

Requested and co-authored by [Vincent Koc (@vincentkoc)](https://github.com/vincentkoc).

## Work sessions

- [Original discussion](https://team.openclaw.ai/chat/roboclaw/dashboard/bda3a7dd-8232-4846-87ca-2e375baa64d8)
- [Implementation](https://team.openclaw.ai/chat/roboclaw/~key/subagent/5761a58c-97b3-46a2-ab9d-222d8a76abd3)
