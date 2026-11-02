# Windows Ollama fixture repair v2

Preparation only. No new native run, build/test execution, capture, app/model download, CI dispatch, VM allocation, commit, push or PR occurred. Parent release remains required. Real-app jobs are DORMANT and UNREGISTERED: workflow.yml has one noninstalling fixture job only.

## Source and failure evidence

Base d38ebb418c3aba6b24a4d6470def72b2bba4c4a8. Repaired full product patch SHA256 f25cff6b71801078260e2f5080e2d8d9c32584829ad7d7dfb9c59d79e254961d, 169445 bytes,22 postimages in composed-evidence.json. Narrow three-file delta from fd1d39 is candidate-repair-from-fd1d39.patch, SHA256 45eace8a52b98119c5f3e2b332faf429b8d655d02c18c40772247539900813f6. Old source packet and relay are preserved.

Run41495507649 (workflow507754c) FAILED and produced ZERO PNG. Artifact13166488749: ZIP4004584B, SHA25677342554bfd0e130a61d36d559134c054222c2da4e7f6187a35aa0c3062b5218. Parent imported and verified all33 output hashes. RETAINED-EVIDENCE.json projects actual receipts with raw artifact hashes and verifies unchanged source closures; it is not new execution or an aggregate pass.

Retained: strict backend/runner17passed0skip(4s), Connection1700passed/1 ordinary supported skip, Tray4799passed, canonical docs passed. Shared4782passed/44failed/8skip; SetupEngine2560passed/1failed/1skip. Those failed whole-suite results remain recorded. Old Before2 both failed. No native acceptance.

## Repairs at the actual owners

1. Source build.ps1 line697 applies Count to a scalar false pipeline. Inherited Proof.Common StrictMode Latest throws and obscures the actual WinUI build failure. Cheap exact-expression reproduction failed under caller Latest, succeeded in fresh pwsh with4success/1failure, and confirmed caller StrictMode unchanged. Full All/Debug/NoTrust now runs in canonical fresh pwsh -NoProfile -File, with no builder or strict-policy relaxation.
2. Every existing source/output directory is resolved at the script entry through Resolve-Path filesystem provider and Get-Item.FullName before OPENCLAW_REPO_ROOT/child commands. This fixes the harness's mixed-slash producer, not MXC, permissions, expected paths, ACLs or sandbox policy. Shared full suite is selected again because it failed44 root-sensitive cases and its producer input changed.
3. The old artwork source literal pinned one incidental conditional spelling. The owning source guard now protects early artwork disposal before async cleanup. Existing mounted Ollama cases now assert ordinary provider action/brand forwarding, native Set up overriding conflicting external action metadata, and actual artwork-session closure. No test count was dropped, no baseline exception. Also, the retained full-build log revealed a real CS0103 at OllamaWindowsSetupDialog.cs45: AutomationLiveSetting lives in Microsoft.UI.Xaml.Automation.Peers. The missing import is the ONLY production-code repair. Its public enum namespace was independently verified; native compilation is pending.
4. GitVersion.MsBuild6.8.2 supports WriteVersionInfoToBuildLog=false. UI build graphs get that exact property; full builder gets its process-scoped environment equivalent restored in finally. No version computation/assembly generation is disabled, no CI impersonation/unsetting GITHUB_ACTIONS, no dependency bump/serial pin/retry. Save-CalculatedVersion.ps1 verifies actual evaluated computation controls and the generated gitversion.json SHA/FullSemVer after each affected UI build. Dirty-source and loaded-binary freezes remain mandatory.
5. Foreground activation was the wrong proof rung for a private desktop, not failed launcher admission. The foreground owner, source launcher, UIThreadFixture and MountedControlCapture remain unchanged. The packet-only private consumer uses existing AppWindow.Show(false) and the unchanged MountedControlCapture PrintWindow producer. It requires explicit fixture-v1, owned private HWND, DPI/visibility/whole-window geometry/source/loaded binaries/no fallback and original-image labels. No foreground/focus/input-desktop/ACL/keyboard/compositor claim or waiver.

## Runnable gates and counts

Prepare-Source admits all22 product inputs first, then installs exact TEST-OVERLAYS.json postimages. Common comparison and helper bytes MUST match both states; Before production staysd38. After's product-test overlay changes ONLY its presentation boundary on the repaired metadata-test input, plus a read-only real-Windows observation class. No product baseline flag or fake app action.

Invoke-RequiredGates runs: retained-proof admission; full All build (which canonically validates docs); Shared build/full suite; SetupEngine build and three ProviderArtworkSourceContractTests owning-source cases; After/Before UI build plus computed-version receipts; private UI; source postflight. It does NOT repeat successful unchanged Connection/Tray/17 suites solely to obtain green. Current owner3 and current mounted metadata observations address the prior single Setup failure; no fabricated fresh full-Setup-suite pass.

The original strict31 matrix is retained: prior native17 + current Before2 + current After12(2comparison+9mounted+1readonlyOS). No skipped custom rows and no zero-test admission. All9 original frames remain required: Before2 and After7. All use the unchanged mounted receipt schema, not a forged foreground receipt. The five comparison/OS images additionally require .required.json with source/freeze/image/assembly/native label/geometry/original-PNG OCR bindings. Original images require human inspection even with machine labels passing.

## Actual dependency contracts and remaining limits

Actual WinGetv1.11.510, current-user AppInstaller1.26.510.0, Microsoft Authenticode Valid, alias/packageOk and Name/Arg/Type/Identifier source export passed in the failed run. Exact pinned1.11 source/spec supports all eleven acquisition flags. There is no justification for a1.29 executable prerequisite or an Argument parser fallback. This is runtime/source-command evidence, NOT configured-catalog download, installer inventory/hash/signer, installation or model proof. See DEPENDENCY-CONTRACTS.md and WINGET-CONTRACT.md.

Runtime bootstrap retains the proven current-user Microsoft.WindowsAppRuntime.2 X64 healthy framework minimum2.6.4.0, exact trusted installer, same SID/session and stable Bootstrap0x20006/empty tag. SDK channel2.6 is not an AppX family suffix. No runtime fallback or experiment.

W4 is not silently stacked; another accepted composition needs its exact source/postimages and affected proof reconciliation. App installation, stopped-app Open, native app lifecycle, registered Companion startup, ARM64 host, live selected-Gateway configuration/inference and model acquisition remain unqualified. Synthetic UI/readonly Windows facts are not those results. A private rendering/UIA/OCR refusal remains a concrete unsupported boundary, not permission to force foreground or weaken a guard.

Review/static reports and the bounded native-read2200 transfer index accompany this packet. Parent must review exact repaired bytes before any execution. No rerun has been dispatched.
