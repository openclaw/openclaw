## Unreleased

### Fixes

- SSRF private-network allows refuse DNS answers that are cloud metadata or non-exempt link-local. Ollama keeps private LAN, loopback, and the Podman gateway address. (#191588) Thanks @SebTardif.
- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
