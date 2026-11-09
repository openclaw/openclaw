## Unreleased

### Fixes

- Gateway: bind browser device tokens issued over a QR/setup-code or device-key pairing to the live shared-auth generation, so a Control UI paired that way is not refused as `legacy-browser-token` on its first reconnect after a Gateway restart.
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
