## Unreleased

### Fixes

- Auto-reply: the first turn in a mixed-case thread posts its reply on the forked session, instead of dying while the original thread id and the folded store key were treated as different sessions. (#184538) Thanks @csabatatrai.
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
