# Narrow Windows provider artwork qualification (prepared, not executed)

Candidate source remains the independently reviewed seven-file patch on exact W4 c550174d517b5e8830726cd5c32d4e132c144659, branch llama-app/w5-provider-artwork. No source commit, publication, runtime, CI, host, dependency or configuration authority has been granted at this checkpoint.

## Source contracts and candidate cases

1. ProviderPicker_ShowsAdvertisedBrandsAndHonestFallbacksWithoutStartingSetup: 2 Light/Dark mounted cases; real ComboBox template, Llama/Ollama native SVG decoding, unknown/llamacpp fallbacks, existing page session, no selection/mutation/completion.
2. ProviderDialog_KeepsSelectedArtworkThroughTypedPromptsAndReleasesOnlyItsBorrow: 4 cases (2 brands x 2 themes); real invoked prepare row, source-owned descriptor and session, notes/text/Boolean confirmation, preserved string Title and automation names, typed wizard.next dispatch, no auth/activation, cancel detachment and same-page reopen, page-close image clearing.
3. ProviderArtwork_RebindingDetachesThePreviousSessionWithoutClosingTheBorrowedReplacement: 1 mounted control case; dispose old session after replacement image decodes, detach/reuse replacement, unload, then dispose. This covers completed-decode rebind, not a pending-native-decode race. The page dialog is reopened with the same provider; a provider-A-to-B dialog-switch claim is not made.

Exactly 7 candidate cases. All reuse UIThreadFixture and existing PageTransport/render-ready helpers. No new app boot, timers/sleeps/poll loop, fake loader, ignore or production test hook.

Exact candidate selection (normal current UI restore/build required first):

```powershell
$project = "tests/OpenClaw.Tray.UITests/OpenClaw.Tray.UITests.csproj"
$filter = "FullyQualifiedName~OnboardingAiPageTests.ProviderPicker_ShowsAdvertisedBrandsAndHonestFallbacksWithoutStartingSetup|FullyQualifiedName~OnboardingAiPageTests.ProviderDialog_KeepsSelectedArtworkThroughTypedPromptsAndReleasesOnlyItsBorrow|FullyQualifiedName~OnboardingArtworkRenderingTests.ProviderArtwork_RebindingDetachesThePreviousSessionWithoutClosingTheBorrowedReplacement"
dotnet test $project -c Debug -r win-x64 --no-build --no-restore --filter $filter
```

Candidate requirement: 7 passed, 0 skipped. The packet driver adds fresh TRX, source/binary freezes, durations and native capture admission.

## Matched before/after visuals

Two separately identified clean checkouts and artifact roots are required. Driver Stage Before uses original W4 production sources plus only baseline-capture.patch, a sealed test-file-only append. Its BeforeArtworkPicker and BeforeArtworkDialog methods mount the actual original production inventory/dialog, assert the original absence of artwork, preserve the same wire fixtures/themes/viewport/typed prompt progression, and capture before any missing-icon regression assertion would abort. It selects the 2 Before picker cases FIRST and stops on their actual unknown leaf; only after they pass are the 4 Before dialog cases selected. Total 6 cases and 14 genuine baseline PNGs, two existing-suite testhost boots. No candidate production file, cloned inventory, mock-rendered dialog or generic replacement UI is used.

Stage After applies only the reviewed candidate to a clean W4 checkout, or accepts a clean later commit with that exact tree. It selects the 7 candidate cases and 14 after PNGs. The 28 frames are 14 matched pairs: 2 inventories plus 2 brands x 2 themes x note/text/confirm. Baseline and candidate provenance stay separate. No old W4 campaign is rerun; these are only the two changed icon surfaces.

The separate optional failing-regression negative control uses W4 plus only the two new candidate test postimages (not production postimages), the candidate filter, and no capture environment. Expected results are exactly 6 intended omission failures (2 picker + 4 dialog) and 1 passing unchanged-owner lifecycle case. Picker failure must be the absent artwork descendant; dialog failure must be missing ProviderIcon. Build/bootstrap/schema/capture/prerequisite/timeout failures are inconclusive, never the intended regression red. No such native negative control ran here.

## Freeze, capture and host boundaries

The driver checks the whole expected source tree before build, freezes all tracked source and UI binary hashes after build, binds the maintained native helper to that freeze, then compares every source/binary hash and source inventory plus write-tree AGAIN after the entire selected run. This terminal comparison is the explicit equivalent of AssertSourceUnchanged(), so later captures cannot silently rely on only the first lazy Source.Value. Drift rejects the affected evidence. Baseline append also calls the existing AssertSourceUnchanged() boundary.

Each branded candidate capture follows a decoded SvgImageSource and collapsed fallback, not URI assignment alone. Inspect every full-resolution image for actual mark pixels, labels, theme, clipping and matched geometry. The maintained owned-HWND PrintWindow rung forbids screen/other-window fallback. A ComboBox popup may be separately hosted or trip the helper occlusion guard; either is a concrete capture blocker. requiredContent=picker does NOT prove popup containment. Never accept AX/OCR labels as substitute pixels. A new private owned-popup rung requires separate reviewed parent authority; none is added.

Run only after parent source acceptance and separate authorization of a qualified disposable Windows x64 native UI host. No host allocation, runtime install, desktop/resolution/safe.directory changes, Reactor/dependency/graph patches or analyzer/helper-name bypasses occur in the prepared driver. Current UI compilation and all selected native cases remain blocked here: this Linux host has no dotnet, pwsh, Windows App SDK or desktop. PowerShell AST parsing is also unrun. Stop at an actual admission/compile leaf, preserving its output.

## Cost and prior evidence

Candidate: 7 cases/14 frames/one existing-suite boot. Baseline visuals: 6 cases/14 frames/two existing-suite boots (picker gate before dialogs). Optional negative control is an additional separately identified selection, not part of passing candidate proof. Wall time and CI seconds remain UNMEASURED; the driver records command/TRX durations when authorized.

Prior W4 15-case native, Tray and full-build results remain prior-source evidence only. Unchanged Shared/Connection/installer/assets/resolver inputs support only exact contract-closure comparisons, not current-tree UI/full-build/full-suite claims. Shared remains RED/unwaived, with no inherited-only attribution. No whole campaign, live provider install/authentication/inference, WSL/Gateway behavior, ARM64 or broad accessibility certification is proposed. Parent owns any later broad gates; none is silently waived.

## Complete qualified CI producer

The corrected packet now includes guarded workflow-job.yml and workflow-input-choice.yml, payload-manifest.json and Invoke-ProviderArtworkCI.ps1. First CI step parses every PowerShell file and runs eight Stage casing cases before builds; controller verifies that run-bound receipt plus the complete payload seal. Runtime provisioning reuses exact qualified a8c5a852138b3a078125d2fa489c88d963a17cf2 owner bytes/adapters: source SDK 2.6.4, actual AppX family Microsoft.WindowsAppRuntime.2 >=2.6.4.0, exact Microsoft-signed installer, same-user source-exact Bootstrap(0x00020006, empty tag), and source-owned disposable-CI geometry. The old invented family .2.6 prerequisite is removed. Source global.json is unchanged; SDK queries and the isolated bootstrap probe consume its copied policy.

BuildOnly is separate from TestsOnly. Ordinary current UI graphs build under the qualified user with WriteVersionInfoToBuildLog=false only; unchanged calculated-version owner verifies computation/projection and actual SHA. Native selections use the existing source-owned private desktop launcher without switching or changing Default DACL/label. Before picker two cases execute first; an actual failure blocks Before dialogs and all After work. Stage receipts/manifests and final source/binary/tree checks are retained. No global/operator Git configuration mutation is included. All execution remains separately gated and locally unrun.
