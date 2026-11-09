## Unreleased

### Fixes

- Gateway: on Linux kernels built without PID namespaces (no `/proc/self/ns/pid`, e.g. Android GKI), record the single shared namespace instead of failing the process identity read, so the Gateway and `doctor --fix` can take over state ownership after a crash instead of refusing with "different PID namespace" until the owner heartbeat expires.
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
