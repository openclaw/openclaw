## Unreleased

### Changes

- Discord: add `autoThread: "on-first-message"` so a channel thread opens with the first progress draft, reply, or message-tool send instead of sitting empty until the agent responds; the per-message session is unchanged. (#194666)

### Fixes

- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
