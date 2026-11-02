# Real Ollama application boundary consumer

Preparation only. No native execution, download, installation, CI dispatch, VM,
commit, or product modification occurred during preparation. Native compilation
and runtime qualification remain unverified.

## Integration and runnable entry point

Additional packet files: RealOllamaAppQualificationTests.cs (test-only overlay,
not an xUnit Fact), Invoke-RealAppQualification.ps1 (opt-in driver), and this
boundary declaration. These three drafts were fully reconciled after the drafting child was killed. The packet owner repaired proof observations, integrated workflow jobs, and seals the final bytes. No product patch or existing product source was edited.

Use a separate prepared source copy containing ONLY base
**d38ebb418c3aba6b24a4d6470def72b2bba4c4a8** plus the 21 product files in patch
SHA256 **fd1d39dfb6184ac07fa359990c4c42a2348b26954543f63d7e4e3794d5ec6a95**.
Do not pass the comparison/OS-inspection overlay checkout. The driver first
runs the existing product guard, then adds exactly its own test overlay.

After parent runtime/install release, on an owned disposable GitHub-hosted fresh
Windows x64 runner with current interactive ownership and existing build/runtime prerequisites:

~~~powershell
pwsh -NoProfile -File .\Invoke-RealAppQualification.ps1 -Source C:\proof\product -Artifacts C:\proof\real-normal -Mode Normal -AuthorizeRealInstall -DisposableFreshWindows
~~~

For cancellation, use another fresh disposable host/user and -Mode
CancelCloseQuit. Do not uninstall or terminate Ollama to manufacture another
fresh-install cell. A normal install and a canceled install cannot both prove
their different outcomes from one installation. The existing nine synthetic
mounted Cancel/Close/Quit regressions remain independent.

The driver generates a WinExe project in its new artifacts directory, references
the existing UI-test project, builds it, copies that project's actual XBF/PRI
runtime payload, freezes the actual launch directory and invokes the one-shot
consumer inside the UI-test assembly. Existing friend visibility and the actual
UI resource loader are reused, not expanded. Build/resource/bootstrap failure is
blocked, not executed proof. No toolchain/runtime installation is attempted.
Build restore can fetch existing pinned project dependencies under normal
build/network policy; it is not app installation.

## Production and synthetic owners

Reflection invokes actual SetupWindow.CreateAiSetupArgs. Only TransportFactory
is changed. The real OllamaSetupFactory, OllamaWindowsAppHost, CommandRunner,
AccessDraft, logger, mounted Set up card/dialog, setup lock, page drain,
Window.Close, WindowManager and shutdown coordinator remain intact. There is no
fake IOllamaWindowsAppHost, substituted installer, artificial admission signal,
generic manager or product hook.

The selected Gateway is synthetic no-model discovery, never a live Gateway.
Runtime requests are restricted to openclaw.setup.detect; all others throw.
There is no provider/model pull or setup completion. The transport advertises
detect/verify and the minimum prepare/wizard metadata needed by the frozen
GatewayAiSetupClient.DetectAsync guard. Those wizard methods cannot successfully
execute. **A literal advertised-method list of only detect+verify cannot render
this product card:** DetectAsync requires at least one supported choice,
otherwise returns ClassicWizardRequired. This explicit fixture constraint is
not a parser defect or hidden working download capability. If a literally
detect/verify-only advertised list is mandatory, that narrower request remains
blocked without a separately reviewed product contract change.

Official current WinGet v1.29.380 upstream serialization emits Arg. The product
parser is correct and unchanged. The driver requires that exact reviewed
first-party version, the current-user alias and healthy Microsoft App Installer
package. Missing/different availability blocks without bootstrap, reset, source,
alias, policy changes or downgrade. Product acquisition alone executes source
export/download. There is no direct URL/curl or manual-install fallback.
Actual product logic owns fixed 0.40.13, source identity, hash, held-file signer,
final inventory/conflict checks and Inno admission. The consumer additionally
observes matching actual installer hash, exclusive-file refusal, actual product
signer verifier and a real same-image/current-SID/session process started after
the command event. A missed short-lived process window blocks instead of
fabricating admission from cmd.start, which occurs BEFORE Process.Start.

## Non-killing launch and custody

Source-owned scripts/Invoke-PrivateDesktop.ps1 runs unchanged with normal
DACL/label and desktop guards, **without WaitForExit or ConsoleProcess**. The
WinExe provides a real GUI input-idle root. No shared input-desktop switch,
null-security override, unsupported held keys or desktop transfer occurs.

The existing WaitForExit mode tree-kills on timeout. Neither that mode nor
Invoke-UiStage, VSTest or --blame-hang may own this live installation. The normal
launcher can still terminate its exact root on launch error. Therefore the child
cannot toggle consent until the parent has returned successfully from the WHOLE
wrapper, checked exact root PID/start/path plus desktop receipts, and atomically
written the matching admission acknowledgment. Launch-failure cleanup cannot
race app admission. The acknowledgment binds PID/start and freeze digest; it is
launch admission, never a substitute for product consent or live process proof.

The parent retains a native handle to the exact root and uses only a soft
observation deadline (45 minutes by default). At deadline it writes
blocked-pending and returns without killing or claiming settlement. Product
drain keeps owning admitted installer work. Later follow-up must observe this
run and its identities, never blindly relaunch/retry. External CI cancellation
or VM reclamation still can kill processes: do not put this consumer under a
shorter hard supervisor timeout, or claim survival across host destruction.

A process-level completion signal is used only AFTER actual Application.Exit
returns. The parent separately proves that exact host has exited and the app
is still alive. Shared UIThreadFixture.Dispose is deliberately not called after
Exit: its source first marshals ResetContainer/GC back to the dispatcher. The
one-shot host avoids inventing successful post-Exit shared-fixture teardown.

## Cases and receipts

Every requested row starts blocked and becomes passed only after its named
observation. A zero root exit code is not whole-scope success. Missing selected rows or frame/source identity fail the driver. A soft deadline preserves its pending receipt and returns failure without killing the process; eventual CI VM reclamation is not settlement. The parent
requires explicit selected-mode rows, exact root receipt/exit and app survival.
It always reports allRequestedBoundariesComplete=false while alternate-mode or
stopped-Open boundaries remain blocked.

| Boundary | Normal | CancelCloseQuit |
| --- | --- | --- |
| Actual fresh inventory, unchecked consent, explicit native toggle/Install | Selected | Selected |
| Real WinGet/source/hash/held-file/signer/Inno and actual process admission | Selected | Selected |
| Installed API with zero models reaches NeedsModel | Selected | Blocked: continuation canceled |
| Read-only Check again reuses running service without another command | Selected | Blocked: closed |
| Actual Cancel then Window.Close then Quit while installer remains live; lock/logger retained | Blocked: normal install | Selected, combined sequentially |
| Drain settles; lock/logger released | Selected | Selected |
| Actual canceled settlement records CancelledInstallationPresent | Blocked: normal install | Selected |
| Actual Application.Exit, exact host gone, task-created signed desktop app survives | Selected | Selected |
| Stopped installed app Open | Blocked | Blocked |
| Model pull/inference, live Gateway readiness, provider configuration | Excluded, never claimed | Excluded, never claimed |

Fresh installation is allowed only when ALL actual product evidence permits it:
no supported registration/default unregistered app/PATH CLI, inactive process
inventory, refused API connection and no foreign llama-server. Unknown is not
absence. Existing Ollama or foreign llama-server is refused without cleanup.
Product checks repeat after acquisition and immediately before admission.

CancelCloseQuit requires the exact installer to remain live at EVERY retention
observation. If it settles between actions, that later case is blocked, not a
pass. The consumer never holds/freezes the real installer to stretch a window.
Product settlement is awaited without forced timeout. Quit reaches actual final
Application.Exit, not a suppressed callback. A test-only shutdown step records
settled app identity, released resources and freeze before Exit. The shutdown
coordinator's best-effort error handling cannot qualify missing rows: the parent
still requires each explicit receipt.

The surviving process must be actual ollama app.exe, not just its service. Its
path comes from product signature-verified registration, its start follows this
task's installer event, and SID/session match the task. After root native-handle
exit the parent checks the SAME app PID/start/path/SID/session and a valid Ollama
Inc. Authenticode signature. The external app is left running. No forced stop,
uninstall, rollback, reinstall, compensating Open or model acquisition occurs.
Stopped-Open remains blocked because no qualified source-owned graceful app
shutdown contract was found.

Artifacts: real-app-freeze.json (all source, declared overlay, generated host
source and actual launch-payload digests); loaded-binary digests checked against
that freeze before/after; normal wrapper launch/security receipts; initial
product observation; installer event/process/hash/held-file/signer receipts;
per-case outcomes; synthetic-only Gateway call inventory; app-before-exit
identity; and parent real-app-result.json. Parent checks source inventory and
binary bytes again after native root exit. Generic MountedControlCapture
sidecars retain conservative synthetic-dependencies wording; the cases and this
declaration distinguish real Windows app/installer from synthetic Gateway.
Images use private-desktop PrintWindow, not physical input/compositor/inference
or live Gateway proof. Human inspection is required before visual completion.

## Preparation checks and native unknowns

Final packet validation separately parses all PowerShell and C# inputs; its exact report is retained with the handoff. This is syntax-only, not semantic/native qualification. No semantic C# build, native bootstrap/UI, installed App Installer
preflight, signature chain, network download, installer, real Exit or survival
proof ran. Product source HEAD and bytes remain unchanged. This is runnable
preparation, not a native green receipt.

Required full build/shared/tray and relevant native UI gates are unrun under
the explicit no-execution/no-install/no-CI/no-VM constraint. Retain these concrete
blockers and separately authorize any native run.

Runtime prerequisite correction: parent native CI run41490135782 showed the stale SDK-channel-derived .2.6 AppX query fails before build/capture despite successful signed installer execution. This packet now uses the EXACT already-proven family .2/minimum2.6.4.0 block from the maintained original harness, retaining same-user/SID and stable Bootstrap0x20006/empty-tag checks. No fallback, guard waiver, runtime experiment or product edit occurred.

Review repair: AppShutdownStep remains Func<ValueTask>, so the qualification callback is an async ValueTask-targeted lambda. Final freeze success is a required row and root-bound receipt written only after verification; actual Exit signals nonzero if that success latch is absent. Parent independently rechecks the full manifest, generated host inputs and binaries. Best-effort shutdown cannot promote a verification failure to native acceptance.
