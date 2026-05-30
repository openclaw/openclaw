# Zorg MemoryDB And LAN Command Chat Install

Zorg MemoryDB extends OpenClaw with PostgreSQL-backed durable memory and the LAN command chat fallback console.

## What The Installer Adds

The first-run installer prepares missing prerequisites, installs the normal OpenClaw package on the host, then runs `zorg/install-zorg-memorydb.sh` as the add-on step. The add-on script creates the OpenClaw workspace subdirectories for `zorg-memorydb` and `lan-chat`, applies the public-safe schema, seeds production rule records, imports packaged markdown rules into database tables, imports retired `memory/*.md` files into the database if they exist, and copies the LAN command chat source.

If the target Linux user does not have root or passwordless sudo, the bootstrap does not abort the whole OpenClaw install. It copies the packaged Zorg MemoryDB and LAN command chat files, builds the LAN chat source when npm is available, and warns that system packages such as PostgreSQL client/server must be installed as root before rerunning `zorg/install-zorg-memorydb.sh` to apply the database schema.

When the add-on bootstrap is launched with `sudo`, it defaults to the invoking user's OpenClaw home unless `OPENCLAW_HOME` is explicitly set. This keeps the LAN command chat service user and `WorkingDirectory` aligned; otherwise a root-run bootstrap can accidentally create `/root/.openclaw/workspace/lan-chat` while systemd runs LAN chat as the non-root user.

## Database Rules

The database package keeps rule tables, markdown import tables, source chunk tables, recall hint tables, entity and association tables, and the default LAN command chat message table. The public baseline does not ship private live memory rows, transcripts, credentials, uploaded files, contact data, or operator-only state.

## Coding And Install Rule Discipline

Zorg MemoryDB install and package changes must be grounded in the product's own documentation, source patterns, package metadata, tests, runbooks, and existing implementation procedures before code is changed. Do not implement install, upgrade, plugin, or runtime behavior from generic coding memory or assumed API behavior.

For package or installer fixes, the verification target is the real documented install path: the GitHub URL, npm package metadata, generated runtime artifacts, and the resulting clean or explicitly existing-install flow. A local source checkout working by itself is not enough evidence. If a patch works locally but fails from a clean install, treat that as an incomplete documentation/procedure check and repair the documented path before calling the fix complete.

## Clean And Existing Installs

On a clean install, the bootstrap creates the database schema and starts with empty user/private memory tables. The default installer mode is `first-run`; if a host-side `openclaw` binary is already on `PATH`, the installer stops instead of treating that host as an upgrade target. This prevents a fresh Zorg setup from accidentally upgrading an existing host install or a host CLI pointed at a Docker/Dockge deployment.

For an intentional existing host repair, opt in explicitly:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/StefRush2099/Zorg_MemoryDB/main/scripts/install.sh | bash -s -- --existing-install
```

On an existing install, the bootstrap applies additive schema changes and preserves user data. Do not run `prepare_public_baseline.sql` against a live user install; that file exists only for building a public-safe package seed.

## Retired Markdown Memory Files

Active memory markdown files should not exist in a Zorg MemoryDB install. If retired `memory/*.md` files are found, the importer records them in `zorg_markdown_imports` and `memory_source_chunks` so the database becomes the durable memory source.

## Zorg MemoryDB first-run installer

Use the installer first on a fresh system. It follows the OpenClaw install pattern and upgrades/install prerequisites such as Node before installing Zorg MemoryDB and LAN command chat.

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/StefRush2099/Zorg_MemoryDB/main/scripts/install.sh | bash
```

Install order is intentional: OpenClaw is installed first from the normal OpenClaw package, then the Zorg MemoryDB add-on and LAN command chat are applied from this repository. This is the supported first-run path for hosts with missing or old software.

Direct npm installs the OpenClaw package only unless the explicit existing-upgrade guard is set. Use direct npm only on systems that already have Node >=22.19.0 and working global npm permissions. For first-run installs, run the packaged Zorg add-on script as a separate step. Do not use direct npm as the first command on old hosts such as Node v12 systems; use the first-run installer above so Node is repaired before npm evaluates OpenClaw's dependency tree.

```bash
node --version
sudo npm install -g --install-links=true git+https://github.com/StefRush2099/Zorg_MemoryDB.git
sudo env ZORG_INSTALL_MODE=first-run "$(npm root -g)/openclaw/zorg/install-zorg-memorydb.sh"
```

Direct global npm also fails closed when a host-side `openclaw` binary already exists. That command would be an upgrade, not a first-run install. Use the first-run installer on clean hosts, or opt into an existing repair with `ZORG_INSTALL_MODE=existing ZORG_ALLOW_EXISTING_UPGRADE=1` only when that is the intended scope.

For an intentional direct GitHub npm upgrade over an existing host OpenClaw install, use the explicit existing-upgrade environment guard:

```bash
ZORG_INSTALL_MODE=existing ZORG_ALLOW_EXISTING_UPGRADE=1 npm install -g --install-links=true git+https://github.com/StefRush2099/Zorg_MemoryDB.git
```

This preserves the first-run safety gate while allowing a deliberate additive overlay refresh on a host that already has OpenClaw installed. In this mode, package postinstall runs `zorg/install-zorg-memorydb.sh --from-openclaw-install --install-mode existing` after the OpenClaw package postinstall completes, so the Zorg MemoryDB add-on is applied automatically instead of requiring a second manual command. Set `ZORG_MEMORYDB_SKIP_BOOTSTRAP=1` only for special-purpose package installs where the add-on bootstrap must be skipped.

If direct GitHub npm is rerun over an existing global install, npm may fail during its git-dependency preparation before package lifecycle scripts can print the clearer guard. The common signature is:

```text
npm error git dep preparation failed
npm error ENOTEMPTY: directory not empty, rename '/usr/lib/node_modules/openclaw' -> '/usr/lib/node_modules/.openclaw-*'
```

That is still an existing-install collision, not the clean first-run path. Do not add `--force` for a fresh Zorg install; use the first-run installer on a clean host or explicitly choose existing repair mode.

If `node --version` prints Node 12, Node 18, or any version below 22.19.0, do not repeat direct npm as the first repair path. The direct npm lifecycle helper can sometimes upgrade Node on supported Linux package managers, but npm may drop root privileges for lifecycle scripts or resolve dependencies before the helper can safely take over. The reliable repair path is the first-run installer above, which upgrades Node before npm executes OpenClaw lifecycle scripts.

Observed failure on old hosts: npm resolves the package dependency tree before a safe host repair can complete. On Node v12.22.9 this produces a long `npm WARN EBADENGINE` cascade. Zorg keeps a copy of the Node prerequisite repair script under `zorg/check-node-version.cjs`, which is part of the packaged add-on tree, so the lifecycle path remains available during direct git installs. If that helper can repair the runtime, it stops the old npm process with a retry instruction instead of pretending the original process can continue safely. If npm runs lifecycle scripts as an unprivileged user, the helper cannot repair system Node; use the first-run installer instead.

If direct npm has already repaired Node or failed once on an old host, verify the repaired runtime and rerun:

```bash
node --version
npm --version
sudo npm cache clean --force
sudo env ZORG_INSTALL_MODE=existing ZORG_ALLOW_EXISTING_UPGRADE=1 npm install -g --install-links=true git+https://github.com/StefRush2099/Zorg_MemoryDB.git
```

If Node is still below v22.19.0 after the failed direct npm attempt, use the first-run installer instead of repeating direct npm:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/StefRush2099/Zorg_MemoryDB/main/scripts/install.sh | bash
```

## Docker Gateway TUI Compatibility

When OpenClaw runs in Docker or Podman and the host runs `openclaw tui` against a published gateway port such as `127.0.0.1:18789`, the gateway can see the host connection as a container bridge address instead of true localhost. Without the compatibility patch, the TUI can fail with:

```text
control ui requires device identity (use HTTPS or localhost secure context)
```

The Zorg MemoryDB first-run installer does not patch existing Docker/Podman gateway config. That compatibility patch is an existing-install repair and must be requested explicitly by setting `ZORG_PATCH_EXISTING_DOCKER_CONFIG=1`; it sets `gateway.controlUi.allowInsecureAuth=true` and, by default, `gateway.controlUi.dangerouslyDisableDeviceAuth=true`. This keeps host-side TUI access working for private Docker installs where the gateway is protected by the configured gateway token.

For hardened public, HTTPS, or paired-device deployments, disable that compatibility setting before running the installer:

```bash
ZORG_INSTALL_MODE=existing ZORG_PATCH_EXISTING_DOCKER_CONFIG=1 OPENCLAW_CONTROL_UI_DISABLE_DEVICE_AUTH=false zorg/install-zorg-memorydb.sh
```

If the host CLI still cannot connect after this patch, verify that the host-side OpenClaw config uses the same gateway token as the running container. Do not paste or publish the token in logs, issues, or chat.
