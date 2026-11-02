## Unreleased

### Fixes

- Brave Search: refuse a configured base URL that targets a cloud metadata service or a link-local address before the request can send the API key. Localhost and private-network proxy names still work. (#191445) Thanks @SebTardif.
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
