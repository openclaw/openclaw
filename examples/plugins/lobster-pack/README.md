# Reef Lobsters

A native Lobster Pack with two original Clawmojis: Coral (self-contained SVG) and
Tide (a three-frame PNG sprite atlas). All artwork in this example is original
and available under the repository's MIT license.

This private example is for a source checkout containing Lobster Pack support.
The published OpenClaw `2026.9.6` release does not support `lobsterPacks`; its version
number in the checkout is not a compatibility floor for this feature.

From that checkout's repository root, install the example in your development profile
using the checkout's CLI:

```sh
pnpm openclaw plugins install ./examples/plugins/lobster-pack
```

Reload plugins or restart the Gateway, then open **LobsterDex**. The pack appears
under **Lobster Packs**. Previewing it does not record an encounter.

The identities available to Control UI plugin consumers are:

- `reef-lobsters/reef/coral`
- `reef-lobsters/reef/tide`

The native entrypoint intentionally registers no runtime hooks. The manifest
contributes the artwork; core reads and validates it before plugin execution.
A pack is not a new bundle or installer format.

Do not publish this example as-is. Its `private: true` package intentionally omits
release compatibility and build-version declarations until the first supporting
OpenClaw release is assigned. Before publishing a derived pack, set
`openclaw.compat.pluginApi` and `openclaw.install.minHostVersion` to that supporting release (or
a later release you require), record the actual build version in
`openclaw.build.openclawVersion`, and test against the declared minimum. Keep the
entrypoint and `openclaw.extensions` declaration.

Edit `reef.json` and the packaged assets, then explicitly reload the plugin to
publish a new catalog generation. Core serves captured bytes from that generation
so an on-disk edit cannot silently replace artwork already admitted by the host.
