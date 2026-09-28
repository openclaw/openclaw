---
summary: "Selecting and enabling internal hooks, and how the Gateway discovers them across sources"
read_when:
  - You are enabling internal hooks or narrowing which ones load
  - You need the master switch and selection rules for directory hooks
  - You need discovery precedence across bundled, plugin, managed, extra, and workspace sources
title: "Hook configuration and discovery"
---

Enabling and selecting internal hooks, and how the Gateway discovers them across sources. Part of the [Hooks](/automation/hooks) guide.

## Configuration

For a predictable selection, enable named hooks rather than turning on broad
discovery:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "command-logger": { "enabled": true },
        "session-memory": { "enabled": false }
      }
    }
  }
}
```

The master switch and selection rules for directory-loaded hooks are:

| Configuration                                                                 | Selection                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks.internal.enabled: false`                                               | Internal hooks are off.                                                                                                                     |
| No master flag and no enabled entries, extra directories, or tracked installs | Gateway skips directory-hook loading.                                                                                                       |
| Named entries, with master flag omitted or true                               | Enabled names form an allowlist; `enabled: true` on the master does not broaden it. An entry without `enabled: false` contributes its name. |
| Master flag true with no named entries or named installs                      | Open-ended discovery of eligible hooks.                                                                                                     |
| Tracked hook packs declaring hook names                                       | Those names join the selection; an explicit per-hook `enabled: false` still disables a non-plugin hook.                                     |
| Nonempty `load.extraDirs`, or a tracked install without a hook-name list      | Open-ended discovery, not a selection restricted to that directory or pack.                                                                 |

Workspace hooks always need `entries.<hookKey>.enabled: true`, even with
open-ended discovery. For other file hooks, an entry can be selected by its
name or `hookKey`, but settings are read under `hookKey`. The CLI resolves the
name and writes the correct key for you. Adding the first named entry can narrow
a previously broad selection; inspect existing hooks before changing it.

Per-hook entries accept arbitrary handler-defined fields. The core types
`enabled` as a boolean and `env` as a string-to-string map; it does not validate
custom handler options. For example:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": { "MY_HOOK_LABEL": "example" }
        }
      }
    }
  }
}
```

Per-hook `env` satisfies eligibility checks but **does not mutate `process.env`**.
On events carrying config, a handler can read it from
`event.context.cfg?.hooks?.internal?.entries?.["my-hook"]?.env`. Other events do
not promise a `cfg` field. Do not log entire config objects or put secrets in
examples.

<Warning>
`hooks.internal.handlers` is retired and fails normal config validation. Before
running `openclaw doctor --fix`, migrate each registered module into a managed or
workspace hook directory with `HOOK.md` and a handler. Doctor removes the old
registrations; it does not create executable files. For a legacy-only config
with `hooks.internal.enabled: true`, it also removes that flag to avoid broad
discovery. Named entries, nonempty extra directories, and explicit
`enabled: false` are preserved.
</Warning>

## Hook discovery

Directory discovery merges hooks by **name** using these rules:

| Source            | Location and collision behavior                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled           | Shipped with OpenClaw.                                                                                                                                                  |
| Plugin            | Hook directories declared by active plugins; can replace bundled names.                                                                                                 |
| Managed           | `<stateDir>/hooks/`, normally `~/.openclaw/hooks/`; can replace bundled and plugin names.                                                                               |
| Extra directories | `hooks.internal.load.extraDirs`; same source policy as managed hooks. Later extra directories win over earlier ones; the managed directory wins over extra directories. |
| Workspace         | `<workspace>/hooks/`; can add names but cannot replace bundled, plugin, or managed names. Explicit opt-in required.                                                     |

Bundled, managed, workspace, and plugin hook locations are collection
directories: discovery inspects their immediate children for hooks or packages
whose `package.json` declares `openclaw.hooks`.

Each explicit `hooks.internal.load.extraDirs` path can instead be a pack root,
a single-hook root, or a collection directory. A pack root loads only its
declared hook paths, including nested paths such as `./hooks/my-hook`. Each
path must point directly to a hook; discovery does not recurse into another
pack or collection. A recognized pack with no valid hooks stays empty rather
than scanning unlisted children. A single-hook root loads its own `HOOK.md`
and handler. Only an ordinary collection root gets the immediate-child scan.

For example, to select `/opt/openclaw-hook-library/my-hook/HOOK.md` directly,
add that hook's directory:

```json
{
  "hooks": {
    "internal": {
      "load": {
        "extraDirs": ["/opt/openclaw-hook-library/my-hook"]
      }
    }
  }
}
```

To scan the library's immediate children instead, add
`/opt/openclaw-hook-library`. Only add trusted directories: any extra path
opens hook-name selection across discovery sources beyond named entries,
even when that path selects a single hook or pack.
Handler files must stay within their hook directory; package and plugin hook
paths must stay within their package root. Symlinks escaping those boundaries
are rejected. Hook config and selected-workspace changes reload discovery in
`hybrid` mode, including config written by a new hook-pack install or link. Hook
files and metadata are not watched; restart after editing them or updating
existing hook code, then verify the handler's actual side effect.

### Hook packs

A hook pack is a package whose `package.json` declares hook directories in
`openclaw.hooks`. Install a reviewed package or local directory through the
unified installer:

```bash
openclaw plugins install <path-or-spec>
```

Installation and update flags, npm restrictions, linked-root behavior and trust, and
the deprecated `hooks install` / `hooks update` aliases are documented in
[Install and update hook packs](/cli/hooks#install-and-update-hook-packs).
