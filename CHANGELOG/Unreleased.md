## Unreleased

### Changes

- Developer workflow: document Xcode MCP and interactive Mac/iOS Simulator development through a paired Mac node and Control UI Desktop.
- Control UI: focus the Desktop viewer on a selected app window area while preserving pointer input.

### Fixes

- Desktop: honor an explicit VNC password file when a Mac offers both ARD and VncAuth, so Control UI input can use the operator-enabled VNC control path.
- Control UI: show Fit height and Fit width in the Desktop panel's size picker so narrow viewers can scale and scroll the shared display.
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
