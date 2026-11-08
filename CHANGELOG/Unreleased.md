## Unreleased

### Fixes

- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
- Config: the config audit journal now records the calling client (`actor`, `deviceId`, `clientIp`, `connId`) on Gateway-mediated writes. A `config-rpc` write previously named only the Gateway process, so pid/argv could not identify the caller; a write with no client keeps the record byte-shape unchanged.
