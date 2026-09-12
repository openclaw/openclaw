---
summary: "What `plugins uninstall` removes, and how `plugins update` resolves sources, channels, pins, and integrity drift"
title: "Uninstall and update plugins"
read_when:
  - You want to remove a plugin and know exactly what uninstall touches
  - You want to update a plugin and understand pin, channel, and integrity rules
---

This page covers the two commands that change an existing install:
`openclaw plugins uninstall` and `openclaw plugins update`.

## Uninstall

```bash
openclaw plugins uninstall <id>
openclaw plugins uninstall <id> --dry-run
openclaw plugins uninstall <id> --keep-files
openclaw plugins uninstall <id> --force
```

`uninstall` removes plugin settings from `plugins.entries`, the persisted plugin index, plugin allow/deny list entries, and any `plugins.load.paths` entry that exactly resolves to the recorded install path. It leaves only an exact `enabled: false` entry for each removed plugin id. This marker records the explicit uninstall choice so remaining model, provider, or channel selections do not automatically reinstall the package during startup repair. Reinstalling does not silently re-enable it; enabling the plugin again replaces the marker. For a package with multiple child entries, any child id resolves to the package owner; uninstall removes every sibling's policy and slot/channel references, the one package install record, and the managed directory once. Linked path installs also remove an exact entry for their recorded source path. Parent directories, child paths, prefix matches, and unrelated load paths are preserved. Unless `--keep-files` is set, uninstall also removes the tracked managed install directory, but only when it resolves inside OpenClaw's plugin extensions root. If the plugin currently owns the `memory` or `contextEngine` slot, that slot resets to its default (`memory-core` for memory, `legacy` for context engine).

Matching load-path references are removed before package files so symlink aliases cannot leave invalid config; if file removal fails, the plugin stays disabled and tracked so you can retry uninstall.

`uninstall` prints a preview of what will be removed. Multi-entry packages name the package owner and every affected child before prompting. Pass `--force` to skip the confirmation prompt (useful for scripts and non-interactive runs); without it, uninstall requires an interactive TTY. `--dry-run` prints the same preview and exits without prompting or changing anything.

If a tracked package has no discovered plugin entries, uninstall can remove its exact install record and same-owner policy, including owner-keyed channel config that no other discovered plugin claims. This recovery is allowed only when no other install record shares its package path and no discovered plugin matches its id or recorded paths. Unrelated policy remains unchanged. Registry refresh rebuilds discovery metadata; it does not remove these orphan install records.

Discovered packages with missing, ambiguous, or conflicting ownership still fail closed without changing package files, config, or the installed index. Run `openclaw plugins registry --refresh`, inspect `openclaw plugins doctor`, and use `openclaw doctor --fix` for repairable legacy index state. If ownership is still ambiguous, reinstall the package before retrying update or uninstall.

<Note>
`--keep-config` is supported as a deprecated alias for `--keep-files`.
</Note>

## Update

```bash
openclaw plugins update <id-or-npm-spec>
openclaw plugins update --all
openclaw plugins update <id-or-npm-spec> --dry-run
openclaw plugins update @openclaw/voice-call
openclaw plugins update @acme/demo
openclaw plugins update openclaw-codex-app-server --acknowledge-install-policy-warning
```

Updates apply to tracked plugin installs in the managed plugin index and tracked hook-pack installs in shared SQLite state. They reuse the source that the user already chose when installing the plugin, so they do not require a second source acknowledgement.

On source installations, a selected plugin built with the host stays in use. Named updates, `--all`, and stable/beta core updates report why the registry copy was not admitted and leave its dormant install record unchanged. Package ownership checks still apply to plugins being updated; explicit plugin paths retain their selection priority.

`update --all` reports and skips orphaned path-source install records so remaining plugins can update. Remove an orphan record with `openclaw plugins uninstall <id>` when its files are no longer needed.

<AccordionGroup>
  <Accordion title="Resolving plugin id vs npm spec">
    When you pass a plugin id, OpenClaw starts from its recorded install source. For a multi-entry package, a child id resolves to its package owner and updates every sibling together. If the new package version removes or renames children, OpenClaw removes the retired children's entries, allow/deny policy, exact child load paths, channel config, and memory/context slot selections while preserving retained/new children and unrelated plugins. Stored dist-tags such as `@beta` retain their selected release line.

    The narrow exception is a trusted official package completing a catalog-declared plugin id replacement. That update starts from the catalog package selector so the renamed manifest can replace the legacy id.

    Verified OpenClaw-owned npm and official ClawHub plugins resume automatic updates when their recorded exact OpenClaw release is no newer than core and their catalog source follows the default release line. The update uses the existing channel and compatibility rules, retains the recorded registry, and saves the default selector only after a successful install or an unchanged-artifact verification. For npm installs, recovery can save the default selector without downloading or reinstalling when the existing version and recorded artifact identity already match the target.

    An explicit npm version or tag supplied in the current command remains authoritative. Newer release pins, independently versioned packages, third-party packages, local, Git, marketplace, and custom ClawHub sources keep their existing selectors. An npm registry mirror stays in use while eligible official npm packages receive recovery. If a retained pin has a newer available release, OpenClaw prints an explicit replacement command. ClawHub selector replacement uses `plugins install clawhub:<package> --force` because `plugins update` accepts explicit selector overrides only for npm records.

    Older official-plugin syncs could save an exact version without a user request. Those records do not distinguish automatic pins from manual ones, so qualifying older OpenClaw release pins resume automatic updates in both cases. The same recovery applies to targeted updates, `--all`, `openclaw update`, and `openclaw update repair`. A failed replacement keeps the previous install record for retry.

    For npm installs, you can also pass an explicit npm package spec with a dist-tag or exact version. OpenClaw resolves that package name back to the tracked plugin record, updates that installed plugin, and records the new npm spec for future id-based updates.

    Passing the npm package name without a version or tag also resolves back to the tracked plugin record. Use this when a plugin was pinned to an exact version and you want to move it back to the registry's default release line.

  </Accordion>
  <Accordion title="Beta channel updates">
    Targeted `openclaw plugins update <id-or-npm-spec>` uses the configured update channel when present. Otherwise, recognized official plugins inherit OpenClaw's registry channel. Bulk `openclaw plugins update --all` uses the same registry-channel resolver for official plugins. Moving selectors remain moving even when the downloaded artifact has an exact version; recovered OpenClaw release pins follow that same policy.

    `openclaw update` resolves plugin targets from the newly installed core. npm updates on the beta channel select the newer of the package's `beta` and `latest` releases; ClawHub default-line updates try `@beta` and can fall back to the recorded default/latest selector when that release is unavailable. Integrity, compatibility, trust, install-policy, and capability-consent failures do not trigger source fallback. An unavailable plugin update leaves a notice without failing an otherwise successful core update. Explicit selectors retain their meaning, with the managed OpenClaw release-pin recovery described above.

  </Accordion>
  <Accordion title="Existing plugin source choices">
    Updates retain the recorded npm or ClawHub source. Older install records do not distinguish automatic ClawHub selection from an explicit `clawhub:` request, so OpenClaw does not silently switch those records to npm. To change an existing plugin deliberately, review and run `openclaw plugins install npm:<package> --force`. Automatic externalization of an image-owned bundled plugin uses npm first and its declared ClawHub source second.
  </Accordion>
  <Accordion title="Version checks and integrity drift">
    Before a live npm update, OpenClaw checks the installed package version against the npm registry metadata. If the installed version and recorded artifact identity already match the resolved target, it avoids downloading or reinstalling. A requested selector change or managed release-pin recovery can still update the plugin index without rewriting `openclaw.json`.

    When a stored integrity hash exists and the fetched artifact hash changes, OpenClaw treats that as npm artifact drift. The interactive `openclaw plugins update` command prints the expected and actual hashes and asks for confirmation before proceeding. Non-interactive update helpers fail closed unless the caller supplies an explicit continuation policy.

  </Accordion>
  <Accordion title="--acknowledge-install-policy-warning on update">
    `plugins update` uses the same warning acknowledgement as install, with `type: '<plugin>' to update anyway` in an interactive terminal. The policy is re-evaluated, and `block` or a policy failure remains terminal.
  </Accordion>
  <Accordion title="ClawHub Security Audit on update">
    Community ClawHub-backed plugin updates run the same exact-release trust check as installs before downloading the replacement package. Review outcomes are printed informationally and continue; blocked releases remain non-installable. Official ClawHub packages and bundled OpenClaw plugin sources bypass this release-trust check.
  </Accordion>
</AccordionGroup>
