---
summary: "Install sources and locators, trust and install policy, capability consent, and marketplace installs"
title: "Install plugins"
read_when:
  - You want to install a plugin from ClawHub, npm, git, a local path, or a marketplace
  - You need the rules behind `--force`, `--pin`, or an install-policy warning
---

This page covers `openclaw plugins install`: every supported source locator,
the trust and install-policy rules that gate an install, and the marketplace
surfaces it accepts.

## Install

```bash
openclaw plugins search "calendar"                      # search ClawHub plugins
openclaw plugins install @openclaw/<package>            # trusted official catalog
openclaw plugins install <package>                       # arbitrary npm package
openclaw plugins install clawhub:<package>                # ClawHub only
openclaw plugins install npm:<package>                    # npm only
openclaw plugins install npm-pack:<path.tgz>               # local npm-pack tarball
openclaw plugins install git:github.com/<owner>/<repo>     # git repo
openclaw plugins install git:github.com/<owner>/<repo>@<ref>
openclaw plugins install <path>                            # local path or archive
openclaw plugins install -l <path>                         # link instead of copy
openclaw plugins install <plugin>@<marketplace>             # marketplace shorthand
openclaw plugins install <plugin> --marketplace <name>      # marketplace (explicit)
openclaw plugins install <package> --force                  # confirm source / overwrite existing
openclaw plugins install <package> --pin                    # pin resolved npm version
openclaw plugins install <package> --acknowledge-install-policy-warning
```

Maintainers testing setup-time installs can override automatic plugin install
sources with guarded environment variables. See
[Plugin install overrides](/plugins/install-overrides).

<Warning>
Bare package names install from npm by default. Bundled plugin ids select the bundled copy. Official plugin ids and unqualified official package names (bare or `@latest`) use their declared npm source first and ClawHub second when npm has no published target. ClawHub-only plugins stay on ClawHub. Integrity, compatibility, trust, install-policy, and capability-consent failures stop the install without switching sources. Use `npm:<package>` when you deliberately want an external npm package instead. Use `clawhub:<package>` for ClawHub. Treat plugin installs like running code; prefer pinned versions.
</Warning>

<Warning>
ClawHub packages and OpenClaw's bundled/official catalog are trusted install
sources. A new arbitrary npm, `npm-pack:`, git, local path/archive, or
marketplace source warns and asks before continuing. Noninteractive arbitrary
installs must pass `--force` after you review and trust the source. The same
flag overwrites an existing install target when needed. Normal updates of an
already tracked install do not require it. `--force` does not bypass
`security.installPolicy` or remaining
install safety checks.
</Warning>

Bundled plugins and verified first-party catalog plugins do not require
`--accept-capabilities` for install, enable, update, or Doctor repair. Local
copies and unverified sources still require capability consent even when their
package name matches an official plugin. This exemption does not grant OAuth,
operating-system, or runtime tool permissions. See
[capability consent](/plugins/manage-plugins#capability-consent).

AI onboarding separately requests a capability review before installing a chosen
provider or required runtime, including verified first-party packages.

`plugins search` queries ClawHub for installable `code-plugin` and
`bundle-plugin` packages (not skills; use `openclaw skills search` for those).
Default `--limit` is 20, capped at 100. It only reads the remote catalog: no
local state inspection, config mutation, package install, or plugin runtime
load. Results include the ClawHub package name, family, channel, version,
summary, and an install hint such as `openclaw plugins install clawhub:<package>`.

<Note>
Default installs use declared npm sources first and declared ClawHub sources second.
ClawHub also provides plugin discovery. OpenClaw-owned
`@openclaw/*` plugin packages are published on npm again; see the current list
on [npmjs.com/org/openclaw](https://www.npmjs.com/org/openclaw) or the
[plugin inventory](/plugins/plugin-inventory). Stable installs use `latest`.
Fresh beta-channel installs with bare/default or `@latest` intent target the
installed core's exact beta version for eligible official npm and trusted
official ClawHub plugins. If the core is not a beta release, they target `@beta`.
The selected release must exist in a declared source; pass an explicit version
to choose another release. Doctor, onboarding, and plugin-update recovery paths
can fall back to the recorded or default selector with a visible warning.
On the extended-stable channel, eligible official plugins with bare/default or
`@latest` intent resolve to the installed core version (the base release cohort
for version-bound plugins).
The install record retains the requested selector. Exact pins and explicit
non-`latest` tags keep their targets. Unrelated third-party packages are not pinned
to the core version. Doctor separately refreshes stale official runtime plugins
that are bound to the current OpenClaw release cohort; an existing exact npm
pin becomes the exact replacement version on the same registry.
</Note>

<AccordionGroup>
  <Accordion title="Config includes and invalid-config repair">
    If your `plugins` section, or the `plugins.entries.<id>` entry being changed, is backed by a single-file `$include`, `plugins install/update/enable/disable/uninstall` write through to the deepest included file that owns the change and leave `openclaw.json` untouched. Root includes (every section of a config whose root object authors `$include`), include arrays, includes with sibling overrides, changes spanning several include files, and an include whose own file still authors a nested `$include` fail closed instead of flattening. See [Config includes](/gateway/configuration) for the supported shapes.

    If config is invalid before install, `plugins install` normally fails closed and tells you to run `openclaw doctor --fix` first. Gateway startup can apply [safe legacy-key migrations](/gateway/doctor#detailed-behavior-and-rationale), but plugin config that remains invalid still fails closed; hot reload also rejects invalid plugin config. `openclaw doctor --fix` can quarantine the invalid plugin entry. The only pre-existing-config exception for plugin installation is a narrow bundled-plugin recovery path for plugins that explicitly opt into `openclaw.install.allowInvalidConfigRecovery`.

    When the existing host config is valid but the newly installed plugin's own config is absent, OpenClaw records the install disabled instead of writing an invalid enabled entry. Configure `plugins.entries.<id>.config`, then run `openclaw plugins enable <id>`. If an existing plugin config entry is present but invalid, install fails without rewriting it.

  </Accordion>
  <Accordion title="--force confirmation and reinstall vs update">
    `--force` confirms a non-ClawHub source without prompting. It does not bypass `security.installPolicy` or remaining install safety checks. When the plugin or hook pack is already installed, it also permits replacing the existing install. Use it after reviewing an arbitrary npm, local, archive, git, or marketplace source, or when intentionally reinstalling the same id. For routine upgrades of an already tracked npm plugin, prefer `openclaw plugins update <id-or-npm-spec>`.

    Managed npm installs prepare the package and its dependencies in a private staging directory. Integrity and platform-package checks, install policy, and artifact consent finish before the installed directory is replaced. Rejection or cancellation before publication leaves the previous project unchanged. Upgrades retain generation paths that running plugins may still need for later imports.

    If installation ownership ends during a backup copy, cleanup stops and preserves the complete backup and remaining original files. Failed restoration reports the recovery path. Keep those files until you have checked the current install; an older transaction cannot restore over a newer install or use a substituted backup.

    For recognized npm project corruption or incomplete install metadata, OpenClaw quarantines the affected `node_modules`, lockfile, and shrinkwrap files outside the staging directory and attempts one rebuild. The reported quarantine path remains available after failure; failed recovery leaves the previous project unchanged.

    Reinstalling preserves an authored `plugins.entries.<id>.enabled: false`. `--force` does not approve capabilities: when no valid prior acceptance can be reused, review and accept them before the install commits. Use `openclaw plugins enable <id>` to activate the plugin afterward. See [Capability consent](/plugins/manage-plugins#capability-consent).

    If you run `plugins install` for a plugin id that is already installed, OpenClaw stops and points you at `plugins update <id-or-npm-spec>` for a normal upgrade, or at `plugins install <package> --force` when you genuinely want to overwrite the current install from a different source. Arbitrary sources still show the interactive provenance warning; noninteractive installs must pass `--force` after review. Trusted ClawHub and OpenClaw-catalog sources do not need it. With `--link`, `--force` confirms the source but does not change the linked-path install mode.

  </Accordion>
  <Accordion title="--pin scope">
    `--pin` applies to npm installs only and records the resolved exact `<name>@<version>`. It is not supported with `git:` installs (pin the ref in the spec instead, e.g. `git:github.com/acme/plugin@v1.2.3`) or with `--marketplace` (marketplace installs persist marketplace source metadata instead of an npm spec).
  </Accordion>
  <Accordion title="--acknowledge-install-policy-warning">
    When `security.installPolicy` returns `warn` in an interactive terminal, OpenClaw prints the reason and findings, then uses the same acknowledgement copy as a suspicious ClawHub release: `type: '<plugin>' to install anyway`. If the fully rendered review exceeds 4,000 characters, OpenClaw fails closed before prompting; reduce or coalesce the policy output first. A matching answer re-evaluates the staged source before continuing. A declined or non-interactive direct CLI install stops before commit; after review, `--acknowledge-install-policy-warning` explicitly approves every warning for that command invocation. Automatic and managed install surfaces cannot use that flag themselves; rerun the equivalent direct CLI command when one exists, or change `security.installPolicy` to return `allow` for the reviewed request before retrying the managed flow. Every approved warning is re-evaluated before continuing. Neither acknowledgement nor `--force` overrides `block` or a policy failure.

    If a plugin you published on ClawHub is hidden or blocked by a registry scan, use the publisher steps in [ClawHub publishing](/clawhub/publishing). This flag does not ask ClawHub to rescan the plugin or make a blocked release public. The deprecated `--dangerously-force-unsafe-install` flag remains a no-op.

  </Accordion>
  <Accordion title="ClawHub Security Audit">
    Community ClawHub installs check the selected release's trust record before downloading. OpenClaw prints the outcome, exact audit overview, and details link. A Review outcome is informational and installation continues. If ClawHub disables download or returns a blocking moderation outcome, OpenClaw refuses the release. Official ClawHub packages and bundled OpenClaw plugin sources bypass this release-trust check.
  </Accordion>
  <Accordion title="Hook packs and npm specs">
    `plugins install` is also the install surface for hook packs that expose `openclaw.hooks` in `package.json`. Use `openclaw hooks` for filtered hook visibility and per-hook enablement, not package installation.

    Npm specs are **registry-only** (package name plus optional **exact version** or **dist-tag**). Git/URL/file specs and semver ranges are rejected. Dependency installs run in one managed npm project per plugin with `--ignore-scripts` for safety, even when your shell has global npm install settings. Managed plugin npm projects inherit the npm-compatible parts of OpenClaw's dependency overrides. pnpm parent-child selectors are skipped; npm aliases remain unless the installed npm version rejects them.

    Use `npm:<package>` to make npm resolution explicit. Bare package specs also install directly from npm during the launch cutover unless they match an official plugin id.

    Raw `@openclaw/*` specs that match bundled plugins resolve to the image-owned bundled copy before npm fallback. For example, `openclaw plugins install @openclaw/discord@2026.5.20 --pin` uses the bundled Discord plugin from the current OpenClaw build instead of creating a managed npm override. To force the external npm package, use `openclaw plugins install npm:@openclaw/discord@2026.5.20 --pin`.

    Bare specs and `@latest` stay on the stable track. OpenClaw date-stamped correction versions such as `2026.5.3-1` count as stable for this check. If npm resolves either form to a prerelease, OpenClaw stops and asks you to opt in explicitly with a prerelease tag (`@beta`/`@rc`) or an exact prerelease version (`@1.2.3-beta.4`).

    For npm installs without an exact version (`npm:<package>` or `npm:<package>@latest`), OpenClaw checks the resolved package metadata before install. If the latest stable package requires a newer OpenClaw plugin API or minimum host version, OpenClaw inspects older stable versions and installs the newest compatible release instead. Exact versions and explicit non-`latest` dist-tags stay strict: an incompatible selection fails and asks you to upgrade OpenClaw or choose a compatible version.

    If a bare install spec matches an official plugin id (for example `diffs`), OpenClaw installs the catalog entry directly. To install an npm package with the same name, use an explicit scoped spec (for example `@scope/diffs`).

  </Accordion>
  <Accordion title="Git repositories">
    Use `git:<repo>` to install directly from a git repository. Supported forms: `git:github.com/owner/repo`, `git:owner/repo`, full `https://`, `ssh://`, `git://`, `file://`, and `git@host:owner/repo.git` clone URLs. Add `@<ref>` or `#<ref>` to check out a branch, tag, or commit before install.

    Git installs clone into a temporary directory, check out the requested ref when present, then use the normal plugin directory installer, so manifest validation, operator install policy, package-manager install work, and install records behave like npm installs. Recorded git installs include the source URL/ref plus the resolved commit so `openclaw plugins update` can re-resolve the source later.

    Reinstalling the same Git source and ref without `--force` refuses an existing managed checkout, even if the repository now declares a different plugin id. Use `openclaw plugins update <id>` for a tracked upgrade, or `openclaw plugins install git:<repo>@<ref> --force` to intentionally reinstall the same plugin id. `--force` does not migrate an existing install record to a different plugin id.

    After installing from git, use `openclaw plugins inspect <id> --runtime --json` to verify runtime registrations such as gateway methods and CLI commands. If the plugin registered a CLI root with `api.registerCli`, run that command directly through the OpenClaw root CLI, for example `openclaw demo-plugin ping`.

  </Accordion>
  <Accordion title="Archives">
    Supported archives: `.zip`, `.tgz`, `.tar.gz`, `.tar`. Native OpenClaw plugin archives must contain a valid `openclaw.plugin.json` at the extracted plugin root; archives that only contain `package.json` are rejected before OpenClaw writes install records.

    Use `npm-pack:<path.tgz>` when the file is an npm-pack tarball and you want
    the same per-plugin managed npm project path used by registry installs,
    including `package-lock.json` verification, hoisted dependency scanning,
    and npm install records. Plain archive paths still install as local
    archives under the plugin extensions root.

    Claude marketplace installs are also supported.

  </Accordion>
</AccordionGroup>

ClawHub installs use an explicit `clawhub:<package>` locator:

```bash
openclaw plugins install clawhub:openclaw-codex-app-server
openclaw plugins install clawhub:openclaw-codex-app-server@1.2.3
```

Bare npm-safe plugin specs install from npm by default during the launch cutover unless they match an official plugin id:

```bash
openclaw plugins install openclaw-codex-app-server
```

Use `npm:` to make npm-only resolution explicit:

```bash
openclaw plugins install npm:openclaw-codex-app-server
openclaw plugins install npm:@openclaw/discord@2026.5.20
openclaw plugins install npm:@scope/plugin-name@1.0.1
```

OpenClaw checks the advertised plugin API / minimum gateway compatibility before install. When the selected ClawHub version publishes a ClawPack artifact, OpenClaw downloads the versioned npm-pack `.tgz`, verifies the ClawHub digest header and the artifact digest, then installs it through the normal archive path. Older ClawHub versions without ClawPack metadata still install through the legacy package archive verification path. Recorded installs keep their ClawHub source metadata, artifact kind, npm integrity, npm shasum, tarball name, and ClawPack digest facts for later updates.
Unversioned ClawHub installs keep an unversioned recorded spec so `openclaw plugins update` can follow newer ClawHub releases; explicit version or tag selectors such as `clawhub:pkg@1.2.3` and `clawhub:pkg@beta` remain pinned to that selector.

### Marketplace shorthand

Use `plugin@marketplace` shorthand when the marketplace name exists in Claude's local registry cache at `~/.claude/plugins/known_marketplaces.json`:

```bash
openclaw plugins marketplace list <marketplace-name>
openclaw plugins install <plugin-name>@<marketplace-name>
```

Use `--marketplace` to pass the marketplace source explicitly:

```bash
openclaw plugins install <plugin-name> --marketplace <marketplace-name>
openclaw plugins install <plugin-name> --marketplace <owner/repo>
openclaw plugins install <plugin-name> --marketplace https://github.com/<owner>/<repo>
openclaw plugins install <plugin-name> --marketplace ./my-marketplace
```

<Tabs>
  <Tab title="Marketplace sources">
    - a Claude known-marketplace name from `~/.claude/plugins/known_marketplaces.json`
    - a local marketplace root or `marketplace.json` path
    - a GitHub repo shorthand such as `owner/repo`
    - a GitHub repo URL such as `https://github.com/owner/repo`
    - a git URL

  </Tab>
  <Tab title="Remote marketplace rules">
    For remote marketplaces loaded from GitHub or git, plugin entries must stay inside the cloned marketplace repo. OpenClaw accepts relative path sources from that repo and rejects HTTP(S), absolute-path, git, GitHub, and other non-path plugin sources from remote manifests.
  </Tab>
</Tabs>

For local paths and archives, OpenClaw auto-detects:

- native OpenClaw plugins (`openclaw.plugin.json`)
- Agent Plugins bundles (root `plugin.json` declaring the [Agent Plugins](https://agent-plugins.org) `$schema`)
- Codex-compatible bundles (`.codex-plugin/plugin.json`)
- Claude-compatible bundles (`.claude-plugin/plugin.json`, or the default Claude component layout when that manifest file is absent)
- Cursor-compatible bundles (`.cursor-plugin/plugin.json`)

Managed local installs must be plugin directories or archives. Standalone `.js`,
`.mjs`, `.cjs`, and `.ts` plugin files are not copied into the managed plugin
root by `plugins install`, nor loaded by placing them directly in
`~/.openclaw/extensions` or `<workspace>/.openclaw/extensions`; those
auto-discovered roots load plugin package or bundle directories, and skip
top-level script files as local helpers. List standalone files explicitly in
`plugins.load.paths` instead.

<Note>
Compatible bundles install into the normal plugin root and participate in the same list/info/enable/disable flow. Today, bundle skills, bundle MCP servers, Agent Plugins skills/MCP (with the `PLUGIN_ROOT`/`PLUGIN_DATA` subprocess contract), Claude command-skills, Claude `settings.json` defaults, Claude `.lsp.json` / manifest-declared `lspServers` defaults, Cursor command-skills, and compatible Codex hook directories are supported; other detected bundle capabilities are shown in diagnostics/info but are not yet wired into runtime execution. See [Plugin bundles](/plugins/bundles) for the per-format mapping.
</Note>

Use `-l`/`--link` to point at a local plugin directory without copying it (adds
to `plugins.load.paths`):

```bash
openclaw plugins install -l ./my-plugin
```

`--link` is not supported with `--marketplace` or `git:` installs, and it
requires a local path that already exists. For a noninteractive local link,
pass `--force` after reviewing the source; it confirms provenance but does not
copy or overwrite the linked directory.

<Note>
Workspace-origin plugins discovered from a workspace extensions root are not
imported or executed until they are explicitly enabled. For local development,
run `openclaw plugins enable <plugin-id>` or set
`plugins.entries.<plugin-id>.enabled: true`; if your config uses
`plugins.allow`, include the same plugin id there too. This fail-closed rule
also applies when channel setup explicitly targets a workspace-origin plugin for
setup-only loading, so local channel plugin setup code will not run while that
workspace plugin remains disabled or excluded from the allowlist. Linked installs
and explicit `plugins.load.paths` entries follow the normal policy for their
resolved plugin origin. See
[Configure plugin policy](/tools/plugin#configure-plugin-policy)
and [Configuration reference](/gateway/config-extensions#plugins).

Use `--pin` on npm installs to save the resolved exact spec (`name@version`) in the managed plugin index while keeping the default behavior unpinned.
</Note>
