## Unreleased

### Fixes

- Plugin state: recover plugin-state authority after an indeterminate write outcome by re-reading committed state through the state worker, instead of failing every guarded call with "Plugin state authority is unavailable" until the Gateway restarts.
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
