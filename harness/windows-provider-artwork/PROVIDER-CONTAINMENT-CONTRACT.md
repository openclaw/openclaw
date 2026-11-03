# Provider accessible visual bounds contract correction — preparation only

Exact baseac3f5ea5f830bbf7e4069a5853331139ff7fd319. Only existing canonical OnboardingNativeProof.cs changes among the nine source postimages. No production UI/peer/name/cleanup change. No CI/native experiment/commit/publication.

## Personally traced maintained owner, not another geometry guess
Reference Microsoft WinUI commit948461c2d0c93bce2e9c039ec28b4a25976afede (full SHA already used in retained reference evidence; not a claim of exact runtime binary mapping):
1. dxaml/xcp/core/core/elements/AutomationPeer.cpp:900–902 delegates GetBoundingRectangle to managed APBoundingRectangleProperty.
2. dxaml/xcp/dxaml/lib/FrameworkElementAutomationPeer_partial.cpp:183–246 implements that framework peer rectangle using IsOffscreenHelper then owner CUIElement.GetGlobalBoundsWithOptions(ignoreClipping=false), rasterization scale and physical/screen-coordinate conversion. It is the actual visual/content rectangle, not LayoutInformation.GetLayoutSlot.
3. dxaml/xcp/core/text/TextBlock/TextBlock.cpp:741–767 overrides TextBlock ActualWidth using DWrite text metrics width plus padding (or text page desired width).
4. Same TextBlock.cpp:2740–2752 GenerateContentBounds explicitly uses BASE CFrameworkElement::GetActualWidth/GetActualHeight. Those framework visual bounds differ from the TextBlock text-metric ActualWidth.
5. Public System.Windows.Automation.AutomationElementInformation.BoundingRectangle contract: screen coordinates of the rectangle completely enclosing the element; it can include points not clickable. It does not equate this rectangle to text metrics or a parent pre-alignment layout allocation.

Public contract URL:
https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.automationelementinformation.boundingrectangle?view=windowsdesktop-10.0

Immutable-source links:
https://github.com/microsoft/microsoft-ui-xaml/blob/948461c2d0c93bce2e9c039ec28b4a25976afede/dxaml/xcp/dxaml/lib/FrameworkElementAutomationPeer_partial.cpp#L183
https://github.com/microsoft/microsoft-ui-xaml/blob/948461c2d0c93bce2e9c039ec28b4a25976afede/dxaml/xcp/core/text/TextBlock/TextBlock.cpp#L741
https://github.com/microsoft/microsoft-ui-xaml/blob/948461c2d0c93bce2e9c039ec28b4a25976afede/dxaml/xcp/core/text/TextBlock/TextBlock.cpp#L2740

Four parent-fetched source files were personally read and verified against exact tree blob IDs; no parent source file was written. Private dependency-evidence.json binds those bytes; public contract text is retained privately. No dependency/vendoring/runtime change.

## Actual runtime evidence supporting the fixture-specific relation
Run41612460788 four provider/theme note observations: actual native modal Window/Popup Name Provider note was correct. Rendered Llama app extent279364344.543382.621 lies inside native ProviderName Text/TextBlock/AutomationIdProviderName rectangle279364495383, inside independently measured actual parent-space layout slot transformed to279352495394. Ollama glyph width differs but the native/layout relation is the same. Full rendered-extent equality was wrong horizontally; full layout-slot equality was wrong vertically. Both compared DIFFERENT concepts, not wrong native names.

This specific fixed, loaded, visible, unclipped provider-header fixture therefore requires:

    rendered text extent ⊆ actual native accessibility visual rectangle ⊆ measured actual allocation slot

The relation is not asserted as a universal law for arbitrary clipped/rotated controls; the current fixture already requires same live root, visible content and source-owned dialog/header geometry. A clipped provider that fails to enclose the required rendered extent intentionally fails this proof.

## Explicit minimal corrected assertion
ContainsPhysical compares existing NativeProofLayout.PhysicalEdge-rounded physical pixels, without arbitrary padding/epsilon/new scale. Both rectangles must be finite/positive AND have nonzero physical-pixel area after rounding. Native provider rectangle contains rendered extent and measured slot contains native rectangle. The superseded private SamePhysical equality helper is removed, not kept as another accepted route. No hybrid rectangle is constructed from selected axes.

ALL native identity/name constraints remain: unique owned current HWND/PID/UIthread/root, Window role/Popup class/modal/visible, full actual content/header/window containment, real title/provider descendants, exact actual ProviderName Text/TextBlock/AutomationId/runtime-ID association, and exact NAME ON THE WINDOW NODE. Parent reference/rendered/raw slot/physical slot stability checks remain. Blank/wrong/foreign provider, displaced native box missing glyphs, box escaping real slot, nonfinite/zero/zero-pixel boxes, absent/duplicate dialog and wrong native name still fail.

Receipts retain all three rectangle measurements and raw native observations BEFORE semantics; geometry-rejection diagnostics retain parent/coordinates. New explicit providerGeometryContract=rendered-in-native-in-measured-slot-physical-pixels binds successful private receipts; old equality-era success markers are not adopted. Existing12name-receipt/16original-image/7case-zero-skip contract remains, dialog4 FIRST then remaining3 fail-closed, typedJSON/exit23 probe still pre-runtime/build. Before50de unchanged/not rerun. Other eight workflow jobs and other eight canonical source postimages unchanged.

## Proof limits
Retained evidence replay/negative mutation analysis may check the proposed rectangle/identity contract cheaply, but is NOT execution of the new C# owner/native runtime. No new per-test app/Gateway boots, timers, role/schema managers or broad geometry framework. Current compile/AST/new source-native predicates/pixels/cost remain UNRUN. Parent canonical review and separate execution authority remain required. This is a proper assertion-contract correction, not a waiver or product UI edit. Shared RED/unwaived; installer/Reactor hold unchanged.
