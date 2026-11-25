# Apple Foundation Models provider

Bundled on-device Apple Intelligence inference for OpenClaw setup and utility tasks.
Choose **Apple Foundation Models** during `openclaw onboard` on a Mac. No API key
or third-party model server is required.

Requires macOS 27 on Apple silicon, Apple Intelligence enabled with its model
downloaded, and installed Apple Swift tools with the macOS 27 SDK. Background
discovery checks the actual system model with a disposable helper. Selection
prepares the persistent native helper.
Setup requires at least 8,192 context tokens; older 4K variants are not eligible.

The model reference is `apple-fm/system`. Its name and context window come from
Apple's native Foundation Models API. Onboarding sets `utilityModel`, preserving
the primary model. A fresh installation uses Apple for its setup assistant and
asks for a separate primary model before regular agent chat.

See the [provider guide](https://docs.openclaw.ai/plugins/apple-fm).
