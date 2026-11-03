# Owned native dialog-name boundary: preparation only

Exact harness base30ac6382f17d23baa66907da725f00a0ec37531c. No CI, source/harness commit, publication or runtime action performed. Parent personal/canonical review and separate execution authority remain required.

## Actual failure and source-backed native contract
Run41601071406 proved genuine Opened before managed CreatePeerForElement(dialog) returned null. It did NOT prove a wrong native accessible name. Rebind/unload now passes with actual Unloaded and production cleanup unchanged. Current picker pixels are already accepted partial evidence; no preview is repeated.

Personally inspected immutable Microsoft WinUI source948461c2d0c93bce2e9c039ec28b4a25976afede (the same reference already cited by existing native proof layout/readiness):
- ContentDialog_Partial.cpp:982–989 sets AutomationProperties.IsDialog on its popup;1954–1981 projects the dialog default/explicit automation Name and AutomationId onto that popup.
- PopupAutomationPeer_Partial.cpp:56–65 returns native ClassName=Popup;84–91 returns Window control type;GetPatternCore exposes WindowPattern under the popup owner policy.
- Popup_Partial.cpp:916–931 exposes WindowPattern for content-dialog/light-dismiss/submenu popups. Thus ClassName alone is not sufficient.
- ContentDialogAutomationIntegrationTests.cpp:327–343 explicitly checks UIA_WindowControlTypeId so the name match is the dialog, NOT merely its title TextBlock.

Source URLs (reference contract, NOT a claimed exact binary mapping to runtime2.6.4):
https://github.com/microsoft/microsoft-ui-xaml/blob/948461c2d0c93bce2e9c039ec28b4a25976afede/dxaml/xcp/dxaml/lib/ContentDialog_Partial.cpp
https://github.com/microsoft/microsoft-ui-xaml/blob/948461c2d0c93bce2e9c039ec28b4a25976afede/dxaml/xcp/dxaml/lib/PopupAutomationPeer_Partial.cpp
https://github.com/microsoft/microsoft-ui-xaml/blob/948461c2d0c93bce2e9c039ec28b4a25976afede/dxaml/test/native/external/controls/contentdialog/ContentDialogAutomationIntegrationTests.cpp

New assertion admits ONLY native ClassName Popup + ControlType.Window + current modal WindowPattern, never Text/Pane or a guessed ContentDialog managed peer. It also requires unique same-PID owned-target descendant, exact content/provider geometry association and real title/provider TEXT CHILDREN, then exact name on the WINDOW NODE ITSELF. This is not a title-label fallback. If the current runtime differs, record its actual role/class/name/bounds/runtime IDs and fail; do not broaden the role/class without evidence/approval.

## One existing UIA owner
New ninth canonical file is OnboardingNativeProof.cs, extending its existing Task.Run/MTA/System.Windows.Automation owner. No other COM/UIA manager, capture backend, constructed managed peer or global Find. UI thread binds current Window HWND/PID/UI-thread/root/XamlRoot, observed Opened, string Title and actual loaded/visible dialog content/provider bounds before MTA. Native observations (including empty/mismatched trees) persist BEFORE semantic assertions. After MTA the same live roots/window/bounds/content are revalidated. In proof mode source/freeze/loaded assembly bindings are required; normal tests use identical native name assertion without a private-desktop/foreground requirement.

The ordinary fixture parks its owned HWND at1x1/offscreen. The affected canonical dialog test therefore requests a narrow existing-fixture nativeAutomation presentation: size/position its OWN window on the existing desktop using Show(false), then restore original size/position. It does not activate, switch desktops, change ACLs or require proof settings. No other caller opts in. Private proof mode retains its existing task-owned Window/presentation and only adapts the Window argument; native name logic is canonical, not copied into the overlay.

All production4UI files/docs, capture owner, source session/cleanup and event-corrected rebind test bytes remain unchanged from F03. Before50de proof MUST remain byte-exact to retain accepted6cases/16originals; its source projection reverts the new ninth owner to base. Existing foreground/input/Z-order/capture methods inside OnboardingNativeProof remain unchanged.

## Bounded next proof plan, not executed
After-only existing7cases/0skips/16separate original PNGs remain mandatory. First run the FOUR existing dialog cases as the named new native-role boundary; if they fail, stop with their observation receipts before spending picker/rebind work. Only after they pass run the remaining picker2+rebind1 selection. This adds one selection/suite boot, not per-test boots, a new app owner or a new test case; it bounds the previously unobserved native automation contract. Before is not rerun.

Every note/text/confirm × two providers/two themes must produce a name-verified owned-native-dialog-name-v1 observation alongside the unchanged image/required-v2 receipts (12name observations,16original images). Both parent and popup originals remain separate, no composite/crop. Preserve Title/decoded icon/shared session/provider label/typed answers/no-auth/no-activation/cancel/reopen/page-close/rebind assertions and actual Opened. Preserve cheap typed-JSON binding/exit23 probe BEFORE runtime/build and unchanged source launcher security.

If native dialog node/role/class/name is absent or wrong, this is honest new native evidence; propose a minimal owner repair only AFTER parent critical review. No name fallback/role relaxation/fake peer/threshold weakening or automatic retry. New native compile/AST/cost/native role/pixel proof UNRUN (Linux lacks pwsh/dotnet/Windows). Source9 remains uncommitted; Shared RED/unwaived; installer/Reactor hold unchanged.
