# Frozen Windows Ollama qualification packet

## Review status

Prepared only. Nothing in this packet has been dispatched, installed or launched. Product source remains the accepted 21-file candidate: base d38ebb418c3aba6b24a4d6470def72b2bba4c4a8 plus patch fd1d39dfb6184ac07fa359990c4c42a2348b26954543f63d7e4e3794d5ec6a95. The full postimage manifest accompanies the patch. No product edit, commit, push, public workflow or paid allocation occurred.

This is an unexecuted runnable qualification packet: one required build/fixture job and two explicitly opt-in real-app jobs on separate fresh GitHub-hosted Windows VMs. A selected-stage pass is never whole-feature acceptance. No app/model download or native execution has occurred here. The killed drafting child was reconciled by complete source reads and targeted proof-consumer repairs; its draft is not reused as an execution receipt.

## Actual entrypoint and source admission

The parent may copy workflow.yml into an owned harness repository's .github/workflows/ and this entire directory into harness/windows-ollama at the same reviewed workflow commit. The checkout action uses that immutable workflow commit; it persists no credential. The only trigger is workflow_dispatch, with contents: read. No repository/product writes, release, deployment or cache adoption are configured.

Prepare-Source.ps1 requires two fresh independent W3 checkouts, validates packet bytes, applies the exact patch to After without staging, and checks all 21 postimages and the exact changed-file inventory. It inserts comparison-method.txt into the unchanged OnboardingAiPageTests owner in BOTH checkouts. Before production remains d38; no new product flag. The comparison file's full postimage is identical across both copies. The After-only real-OS inspection overlay is copied separately and sealed; no other test or production source is copied across.

Initialize-NativeRuntime.ps1 retains the previously qualified native route: windows-2025, exact .NET SDK 10.0.403, installed Windows SDK 26100 files, current interactive SID/session owning explorer.exe (not session 0/SSH/ownership transfer), source AppSDK 2.6.4, hash-and-Microsoft-signature-verified official 2.6.4 runtime installer, current-user Microsoft.WindowsAppRuntime.2 X64 framework registration at minimum2.6.4.0 (SDK channel2.6 is NOT the AppX family suffix), and stable Bootstrap.Initialize(0x00020006, empty tag). It invokes the unchanged source-owned desktop geometry script. No broad setup-dev, certificate change, firewall, proxy, WSL, source reset or Windows policy mutation.

## Executed gates after parent dispatch

Invoke-RequiredGates.ps1 attempts each independently runnable stage and preserves failures; a failed stage never becomes a success receipt:

1. Full candidate build through build.ps1 -Project All -Configuration Debug -NoTrustRepository (not publish/DevBuild), plus the complete canonical validate-docs.ps1 gate with no SkipProofPoolFlowRegression switch.
2. Explicit Debug build and FULL Shared.Tests, Connection.Tests, Tray.Tests and SetupEngine.Tests through the existing Invoke-CiTest/TestResultContract owners. Shared/Connection use the canonical default runtime; Tray/SetupEngine use win-x64. Ordinary supported environment skips are retained and reported separately, never counted as custom proof.
3. Strict selected owner cases: 15 OllamaWindowsSetup cases plus 2 admitted-installer runner cases = **17 passed, 0 skipped** required. No zero-test admission.
4. Both UI projects are built Debug win-x64. The unchanged Invoke-PrivateDesktop owner runs sealed consumer Invoke-UiStage on a normal-DACL-and-label private desktop; Default is not switched and no null-security control is used.
5. Before strict UI: **2 passed, 0 skipped** (Light/Dark identical advertised Ollama/no-model fixture).
6. After strict UI: **12 passed, 0 skipped** = identical comparison 2 + product OnboardingOllamaPageTests 9 + real OS inspection 1.
7. Full source/binary manifests freeze before UI execution; the canonical capture helper independently binds the actual loaded assemblies and full source manifest. Loaded test assembly SHA also binds the mounted-control frames. All source/binary hashes and source inventory are rechecked after execution. Source seals are checked again after all required gates.

Total strict custom selections: **31 cases**, distinct from ordinary full-suite totals. Expected counts are admission requirements, not results obtained here. Native test discovery/semantic compilation may expose a source defect; do not relabel that as an unsupported skip.

## Expected frames (9, human inspection still required)

- Before/ollama-identical-advertised-no-model-Light.png
- Before/ollama-identical-advertised-no-model-Dark.png
- After/ollama-identical-advertised-no-model-Light.png
- After/ollama-identical-advertised-no-model-Dark.png
- After/ollama-real-windows-inspection.png
- After/ollama-install-review.png
- After/ollama-install-needs-model.png
- After/ollama-open-review.png
- After/ollama-open-needs-model.png

The four comparison images use the same test-only source and Gateway payload. The actual-OS inspection frame uses SetupWindow.CreateAiSetupArgs and its unmodified production Ollama factory, real Windows registry/process/signature/API observation, and a synthetic selected Gateway. It never checks consent or invokes Install/Open. The last four frames are real mounted production windows with synthetic OS/Gateway dependencies, not actual installed-app/compositor/keyboard/inference evidence. Each receipt preserves its original qualification. No clipped or reconstructed UI, fallback capture, image editing or fabricated frame.

## WinGet/catalog contract admission

Test-WinGetContract.ps1 observes the actual current user's Microsoft.DesktopAppInstaller registration, executable signature and product alias, WinGet version, source export field names and exact default Microsoft source identity. It never repairs registration, installs App Installer, accepts source agreements, adds/resets sources or rewrites JSON to satisfy the candidate. Unsupported availability produces a named blocked receipt. NoDetected is not equated with not installed.

The frozen product correctly reads GetProperty("Arg"). Personally verified official WinGet v1.29.380 commit000f6b55151cb0f1afd2933bb54c62a4724b9ca8: its source-export serializer emits Arg, NOT Argument. No product parser repair or fallback is justified. The probe records actual field names and requires that authoritative contract without rewriting output. WINGET-CONTRACT.md contains exact official source citations, the Server runner availability finding, and the supported first-party prerequisite boundary.

Test-CatalogManifest.ps1 obtains only the immutable public winget-pkgs manifest as DATA: ref fcb37e5558b7629d808ecc6210488848328afcb3, Ollama.Ollama 0.40.13, manifest SHA bab1bff45cadc507a844ff09097dffcc51c3190c029c9c9076a00d43117be10d. It checks both x64/ARM64 descriptors, product code and installer SHA 9e3c76e54e7184c68e88a2378b909bf59bbe454f83c076cb4f4a717e946ae719. This is not current configured-catalog acquisition, signer or actual app proof. No installer/model is downloaded by this packet.

## Actual app jobs: opt-in, separate fresh VMs, no tree-killing wait

After parent packet review/release, workflow_dispatch input qualify_app=true selects Normal and CancelCloseQuit as independent matrix jobs. fail-fast=false prevents a sibling failure from canceling a pending installation; there is no cancel-in-progress policy. Default false executes no app installation and leaves real-app acceptance unqualified. Each app job checks out a fresh d38 source, admits the exact 21-file patch through Prepare-RealSource.ps1, qualifies the same native runtime/desktop, then calls Invoke-RealAppQualification.ps1. It does NOT reuse the comparison-overlay source or uninstall/reinstall an app to create the other case. There are no inherited Ollama environment overrides or .ollama state permitted in this disposable proof user; no cache/config contents are read or adopted.

The app driver requires actual Microsoft App Installer registration/publisher/trust, its current-user alias, and reviewed WinGet v1.29.380. Missing/different prerequisites block without bootstrap, downgrade or source/policy changes. WINGET-CONTRACT.md records a supported first-party prerequisite candidate whose binary/native deployment qualification remains pending. This is a concrete CI prerequisite, not evidence that Ollama is absent or defective.

The one-shot WinExe references the actual UI-test/product assemblies and production SetupWindow.CreateAiSetupArgs factory. Only its selected Gateway transport is synthetic no-model discovery. The real host, current typed route/generation/operator authority checks, native consent, CommandRunner, installer acquisition/hash/signer/held-file rules, page/window logger drain, setup lock, WindowManager and shutdown coordinator are retained. All Gateway calls except detect are rejected. No model pull/provider configuration/inference is possible through this fixture; Windows readiness is not selected-Gateway readiness. This qualifies a production shared-window boundary, not registered/packaged Companion startup.

The unchanged private-desktop launcher is used WITHOUT WaitForExit/ConsoleProcess for real installation. Its GUI input-idle root gets a parent acknowledgment only after launch/DACL/label/Default-desktop guards return successfully. Consent cannot be consumed before that acknowledgment. Parent retains exact PID/start/path/native handle and observes, never tree-kills. The fixture-only Invoke-UiStage/WaitForExit/VSTest hang collectors never own a real installer. A soft 45-minute deadline reports blocked/unconfirmed and fails without process termination or settlement claims. Job hard limit110 minutes includes the product's 30-minute acquisition budget, setup/build and proof overhead. Host reclamation/cancellation can still end a disposable VM; no survival claim extends across its destruction.

Normal requires ten named checks: fresh real Windows inventory; actual unchecked consent; actual signed fixed installer process admission; NeedsModel with zero models; recheck reuses the same running service without another command; real settlement releases lock/logger; task-created desktop app; explicit final-freeze success; actual Application.Exit; and that exact signed app surviving the host's native-handle exit. CancelCloseQuit requires twelve: the eight shared checks, then actual Cancel, Window.Close and Quit each observed while the SAME real installer remains live, plus CancelledInstallationPresent after drain. If installation settles before a required observation, that row is blocked; the proof never suspends/holds the installer to stretch the window. Expensive proof hashing/trust runs off the UI thread. Exclusive-file refusal is checked before opening a proof stream; image mapping can also explain refusal, so no false exclusive attribution is made.

Each driver verifies frozen source, generated host inputs, actual launch payload and required loaded product assemblies before/after. Required named rows, exact process exit, unchanged source/binaries, and frame digests are independently checked by the parent driver. A zero process exit is not sufficient. Native stopped-app Open remains explicitly blocked: no qualified graceful owned-app shutdown fixture exists, and forced stop/uninstall/reinstall would manufacture the state. Its existing mounted regression remains separate. Full selected-Gateway configuration/inference and registered Companion startup remain unproven, not inferred.

Expected real-app frames: Normal/proof/images/real-app-unchecked-review.png and real-app-installed-needs-model.png; CancelCloseQuit/proof/images/real-app-unchecked-review.png. Together with the nine fixture frames this is twelve frames across three jobs. Normal requires10 named checks, CancelCloseQuit12; these twenty-two observations are NOT twenty additional xUnit tests. Generic mounted sidecars preserve conservative synthetic-dependencies wording; the cell ledger distinguishes real OS/app/installer from its synthetic selected Gateway. Human inspection remains mandatory.

## Composition boundary

This packet pins ONLY the already accepted d38 + fd1d39 product21 postimages. It does not silently stack the separate W4 presentation candidate. A different accepted W4 composition must carry its exact patch/postimages and invalidate affected build/binary/source proof before native acceptance; parent owns that reconciliation. No W4 checkout or product file was edited here.

## Output and honest failure handling

The workflow preserves .artifacts/windows-ollama including source admission, runtime/bootstrap/current-user registration, actual WinGet field names, pinned catalog data, full-source/build freezes, ordinary TRX skip counts, strict TRX case names/counts, private-desktop security/exit receipts, original frames and metadata, stage failures and artifact hashes. No secrets are supplied. Directory reuse is refused. See REAL-APP-BOUNDARY.md for case mechanics and EXPECTED-MATRIX.json for exact expected/unexecuted rows. Full app readiness with no model remains a future valid partial outcome, not AI setup completion. A live native/WSL/remote Gateway still needs its own reachable service/model verification.

Validate-Packet.ps1 only parses PowerShell/C# and checks seals. Linux Roslyn syntax is not semantic compilation. There has been no native build/test/capture, actual package query, install, app launch or inference in preparation. The prior Linux docs-validator baseline-equivalent failure is not a passing docs gate.

Runtime prerequisite correction: parent native CI run41490135782 showed the stale SDK-channel-derived .2.6 AppX query fails before build/capture despite successful signed installer execution. This packet now uses the EXACT already-proven family .2/minimum2.6.4.0 block from the maintained original harness, retaining same-user/SID and stable Bootstrap0x20006/empty-tag checks. No fallback, guard waiver, runtime experiment or product edit occurred.

Review repair: AppShutdownStep remains Func<ValueTask>, so the qualification callback is an async ValueTask-targeted lambda. Final freeze success is a required row and root-bound receipt written only after verification; actual Exit signals nonzero if that success latch is absent. Parent independently rechecks the full manifest, generated host inputs and binaries. Best-effort shutdown cannot promote a verification failure to native acceptance.
