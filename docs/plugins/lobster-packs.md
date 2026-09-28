---
summary: "Publish custom Clawmojis and reuse the core LobsterDex renderer in plugins"
title: "Lobster Packs"
---

Lobster Packs add original Clawmojis to the LobsterDex. OpenClaw renders built-in
lobsters, custom SVG artwork, and animated PNG sprite atlases through the same
host component. Installing a pack adds previews; only an actual encounter adds a
collection entry. Collection history stays in the current browser, including
first names, first visits, and shiny sightings. Removing a pack retains that history.

## Package a pack

Use a normal native plugin package with an `openclaw.plugin.json` manifest:

```json
{
  "id": "reef-lobsters",
  "configSchema": { "type": "object", "additionalProperties": false },
  "categories": ["lobster-packs"],
  "lobsterPacks": [{ "id": "reef", "source": "lobsters/reef.json" }]
}
```

The package still needs the usual native plugin entrypoint; a pack-only plugin
can export `{ id: "reef-lobsters", register() {} }`. Pack definitions are inspected
as metadata. They do not need a browser module or custom rendering code.

The source file contains the pack name and characters:

```json
{
  "schemaVersion": 1,
  "name": "Reef Lobsters",
  "clawmojis": [
    {
      "id": "coral",
      "name": "Coral",
      "description": "A little reef explorer.",
      "appearance": {
        "kind": "svg",
        "source": "assets/coral.svg",
        "anchor": { "x": 0.5, "y": 1 }
      }
    }
  ]
}
```

Artwork paths are relative to the plugin root. SVG artwork must be self-contained;
core displays it as an image, never as package-provided DOM. For animation, use
`kind: "sprite-atlas"`, a PNG `source`, `frameWidth`, `frameHeight`, and
`animations`. Frames are zero-based, left-to-right, then top-to-bottom:

```json
{
  "kind": "sprite-atlas",
  "source": "assets/tide.png",
  "frameWidth": 64,
  "frameHeight": 64,
  "animations": {
    "idle": { "frames": [0, 1, 2], "fps": 6, "loop": true },
    "busy": { "frames": [2, 1, 0], "fps": 10, "loop": true }
  },
  "reducedMotionFrame": 0,
  "anchor": { "x": 0.5, "y": 1 }
}
```

`idle` is required. Optional poses are `busy`, `sleeping`, `happy`, and `error`;
missing poses use `idle`. Core owns playback, reduced motion, sizing, and unavailable
artwork fallbacks. Keep character IDs stable across releases so visits remain linked.
The full identity is `plugin-id/pack-id/character-id`; built-in palette IDs remain unchanged.

A source checkout containing this feature includes a private example at
`examples/plugins/lobster-pack`. The published OpenClaw `2026.9.6` release does not
support `lobsterPacks`; do not use that version as this feature's compatibility floor.
From the supporting checkout, run
`pnpm openclaw plugins install ./examples/plugins/lobster-pack`, enable it through
the normal plugin controls, then open **Settings → LobsterDex**. Each
pack has its own collection count; installing it does not change built-in completion.
Invalid definitions or artwork produce plugin diagnostics and are omitted from
the available catalog. Updating or disabling a plugin refreshes its contributions.

The example is for local development and is not publishable as-is. Its
`private: true` package omits release compatibility and build-version declarations
until the first supporting release is assigned. Before publishing a derived pack,
set `openclaw.compat.pluginApi` and `openclaw.install.minHostVersion` to a released version that
provides Lobster Packs, record the actual build version in
`openclaw.build.openclawVersion`, and verify the pack on that minimum version.
See [Package metadata](/plugins/manifest/package-json) for the compatibility contract.

## Use the inventory and renderer

Native Control UI plugins receive the API through `openclaw/plugin-sdk/control-ui`.
Check for the optional capability before using it on a host that predates Lobster Packs:

```ts
if (!host.lobsterdex || !host.components.mountClawmoji) {
  container.textContent = "Update OpenClaw to use this character.";
  return;
}
await host.lobsterdex.refresh();
const catalog = host.lobsterdex.listCatalog();
const inventory = host.lobsterdex.listInventory();
const character = catalog.find((entry) => entry.id === "reef-lobsters/reef/coral");
if (!character) return;

const picture = host.components.mountClawmoji(container, {
  clawmojiId: character.id,
  pose: "idle",
  size: 64,
  label: character.name,
});
// After an actual pet encounter, not a catalog preview:
host.lobsterdex.recordEncounter(character.id, { name: character.name });
const unsubscribe = host.lobsterdex.subscribe(() => {
  // Refresh the plugin's inventory controls using listInventory().
});
return () => {
  unsubscribe();
  picture.dispose();
};
```

`getDefinition(id)` reads one available character. `listInventory()` includes
unavailable characters with `available: false`. `subscribe()` reports catalog and
collection changes. `refresh()` rejects on failure. Snapshots are detached copies;
changing a returned object does not change the host catalog.

The renderer follows pack updates and removal automatically. Its handle has
`update(props)` and `dispose()` methods. Host deactivation closes retained API
operations and disposes mounted components. Rendering does not record a sighting.

A plugin such as OpenClaw Pet can own movement and interactions while asking core
to render each pose. The Gateway's read-only `lobsterdex.catalog` method exposes
enabled custom definitions; collection history belongs to the browser host API.
This DOM component is for native Control UI plugins, not a native desktop rendering bridge.
