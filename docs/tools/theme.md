---
summary: "Let an agent select plugin themes or create a personal OpenClaw theme"
title: "Theme"
sidebarTitle: "Theme"
read_when:
  - You want an agent to change your OpenClaw theme
  - You want to create a custom theme and apply it in one call
  - You need the theme catalog and profile selection contract
---

The `theme` tool lets an agent list, inspect, select, and create OpenClaw
appearance themes. Settings and the agent use the same catalog of built-in,
plugin, and personal themes. Theme descriptions explain their palette,
typography, and character so the agent can choose a theme from a request such
as "make this look like an alien spacecraft."

The tool is available in the coding and messaging profiles and `group:ui`.
It does not require a connected browser. Personal changes require a trusted
requesting profile; the agent cannot supply another person's profile ID.

## Select a theme

Ask the agent to list available themes or choose one for you. `list` includes
the current selection, so selecting a theme usually takes two calls:

```json
{ "action": "list" }
```

```json
{ "action": "set", "id": "space-pack/xenovessel", "mode": "dark" }
```

Use an ID returned by `list`. Plugin IDs are qualified as
`<pluginId>/<themeId>`; personal themes use `user/<slug>`.

## Actions

| Action   | Inputs                                       | Result                                                                                                                                 |
| -------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `list`   | None                                         | Available themes, descriptions, supported modes, sources, and the current selection.                                                   |
| `get`    | Optional `id`                                | Current selection and the requested theme, including its editable definition when available. Without `id`, inspects the current theme. |
| `set`    | `id` and/or `mode`                           | Saves profile overrides and returns the resulting selection.                                                                           |
| `import` | `id`, `definition`; optional `apply`, `mode` | Saves a personal theme. `apply: true` selects it in the same call.                                                                     |

`mode` is `system`, `light`, or `dark`. `set` accepts `null` for either `id` or
`mode` to clear that profile override and inherit the Gateway setting. Setting
only one field preserves the other override when it is compatible. Selecting or
applying a single-mode theme also selects its supported mode if the previous
explicit mode cannot render it. An explicitly requested incompatible mode is
rejected; `system` follows the available palette:

```json
{ "action": "set", "id": null, "mode": null }
```

`set` and `import` return `application: "saved"` after persistence succeeds.
The response already includes the resulting state; an extra `get` is not
necessary. Saving does not assert that a particular browser has rendered the
theme.

The returned `current.mode` is the saved preference. `current.effectiveMode`
reports the rendered variant when it can be determined without a browser; with
two palettes and `system` mode, the device determines it. A plugin reload can
change available variants without rewriting anyone's saved preferences.

## Create and apply a personal theme

`import` accepts a lowercase slug of up to 64 characters using letters,
numbers, hyphens, and underscores. Reimporting the same slug updates that
personal theme. `apply` defaults to `false`.

A definition requires a name, a short description, and at least one complete
`light` or `dark` palette. Each palette uses the semantic colors shown below
and may include `font-sans` and `font-mono`. Use CSS color values such as hex,
`rgb()`, `hsl()`, or `oklch()`. Font families describe locally available fonts;
definitions cannot load external stylesheets or resources.

Definitions can also supply these optional presentation fields, shared by built-in, plugin, and personal themes:

- `mascot`: `"claw"` (the default) or `"none"`. `"none"` replaces lobster branding with a neutral prompt mark and hides the resident lobster and visiting lobster strangers. Ordinary critters can still cross the composer ledge when Lobster visits is enabled; the theme does not change that toggle.
- `workingPhrases`: up to 24 literal status phrases, each trimmed to 1–24 characters with no control characters or duplicates after trimming. These authored strings are not translated. Omit the field to use the default whimsical vocabulary, or set it to `[]` to hide long-wait phrases.
- `critters`: up to 8 unique IDs from the built-in `"penguin"` and `"fedora"` catalog. These add occasional visitors to ordinary composer ledge traffic while Lobster visits is enabled. Omit the field or use `[]` to add none; unknown IDs and duplicates are rejected.
- `avatarHat`: `"fedora"`, `"crown"`, `"santa"`, `"party"`, or `"pumpkin"` adds an occasional decorative hat to agent avatars. Omit the field for no theme-supplied avatar hat.

Use consistent CSS separators: `rgb(20 30 40 / 50%)` or
`rgba(20, 30, 40, 0.5)`. Modern functions such as `oklch()` use spaces between
components and `/` before opacity. Font lists use comma-separated family names;
quote names containing punctuation or beginning with a digit, such as
`"123 Font", monospace`. Also quote names containing CSS keywords, such as
`"Foo serif"`. Malformed colors and unbalanced font quotes are rejected before
the theme is saved.

This example creates and activates a dark theme in one call:

```json
{
  "action": "import",
  "id": "xenovessel",
  "apply": true,
  "mode": "dark",
  "definition": {
    "name": "Xenovessel",
    "description": "Indigo spacecraft surfaces, lime controls, cyan highlights, and monospace typography.",
    "mascot": "none",
    "workingPhrases": ["Navigating", "Calibrating", "Scanning"],
    "critters": ["penguin", "fedora"],
    "avatarHat": "fedora",
    "dark": {
      "background": "#090818",
      "foreground": "#e8f2ff",
      "card": "#12112b",
      "card-foreground": "#e8f2ff",
      "popover": "#171533",
      "popover-foreground": "#e8f2ff",
      "primary": "#c7ff3d",
      "primary-foreground": "#172300",
      "secondary": "#28234a",
      "secondary-foreground": "#e8f2ff",
      "muted": "#211e39",
      "muted-foreground": "#aca6cc",
      "accent": "#4ce9ef",
      "accent-foreground": "#042b30",
      "destructive": "#ff698b",
      "destructive-foreground": "#290711",
      "border": "#40385e",
      "input": "#40385e",
      "ring": "#c7ff3d",
      "font-sans": "ui-monospace, monospace",
      "font-mono": "ui-monospace, monospace"
    }
  }
}
```

Names are limited to 80 characters, descriptions to 320 characters, and the
normalized definition to 4096 UTF-8 bytes. The Gateway validates definitions
before saving them. A personal theme does not require installing a plugin or
publishing the definition elsewhere.

## Plugin themes and hot reload

Plugins contribute theme definitions declaratively through their manifest.
Personal themes use only the built-in hat and critter catalog IDs; plugin themes
may also reference their own SVG artwork IDs declared in the
[plugin manifest](/plugins/manifest/surfaces#themes). Definitions never contain
artwork markup or external URLs.
The shared catalog updates when the plugin is enabled, disabled, or reloaded;
a Gateway restart is not required. The agent continues using the same `theme`
tool rather than receiving a new tool for each plugin.

If a selected plugin theme becomes unavailable, the result includes
`current.requestedId` while `current.id` identifies the fallback that can be
rendered. Re-enable the plugin or choose another theme. Listing the catalog
does not execute plugin theme code.

## Related

- [Plugin theme declarations](/plugins/manifest/surfaces#themes)
- [Manage plugins](/plugins/manage-plugins)
- [Control UI](/web/control-ui)
- [Screen tool](/tools/screen)
