# Cloudflare Clef decision provider

Source-checkout-only OpenClaw plugin for Cloudflare Clef, Clef Flash, and Clef
Omni using the Gateway user's existing `cf` CLI login. It registers Decision
models, not chat models. Supported evidence is text, JSON, or one embedded PNG,
JPEG, or WebP image with text; supported questions are Boolean, Choice, and Score.
Audio/video, multiple images, list, sort, and tags are not supported.

## Host compatibility and publication

This candidate requires the prepared V2 Decision provider API, including
`DecisionProviderV2` and `api.runtime.decisions.evaluateV2`. The published
OpenClaw `2026.10.4` package does not provide this contract. Its version number
must not be used as a compatibility floor for this plugin.

No compatible released host floor has been established. This package is private,
and both npm and ClawHub publication are disabled. The package deliberately omits
install/catalog specifications and compatibility ranges rather than advertising
support for a released host that cannot load it. Before publishing, verify the
plugin against a released host containing the required API, record that tested
release in `openclaw.install.minHostVersion` and `openclaw.compat.pluginApi`,
restore the install metadata, and enable publication through the normal release
workflow. Do not invent a future release number.

For now, use a matching source checkout that contains the prepared V2 runtime:

```bash
cf auth login
cf auth whoami
openclaw plugins install --link ./extensions/cloudflare-clef
```

Run `cf` authentication commands as the Gateway OS user. The adapter does not copy
CLI credentials into plugin config. Configure an absolute `binaryPath` and reload
plugins through plugin management; select `cloudflare-clef/clef`,
`cloudflare-clef/clef-flash`, or `cloudflare-clef/clef-omni` in the Decision picker.

See [the full setup, API, limits, and failure reference](https://docs.openclaw.ai/plugins/cloudflare-clef).

## Verification

```bash
pnpm test:extension cloudflare-clef
```

Live verification is opt-in, uses the CLI account, and incurs provider charges.
See the full reference for the live test command and environment selectors.
