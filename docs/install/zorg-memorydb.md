# Zorg MemoryDB And LAN Command Chat Install

Zorg MemoryDB extends OpenClaw with PostgreSQL-backed durable memory and the LAN command chat fallback console.

## What The Installer Adds

The first-run installer prepares missing prerequisites, installs the normal OpenClaw package, then runs `zorg/install-zorg-memorydb.sh` as the add-on step. The add-on script creates the OpenClaw workspace subdirectories for `zorg-memorydb` and `lan-chat`, applies the public-safe schema, seeds production rule records, imports packaged markdown rules into database tables, imports retired `memory/*.md` files into the database if they exist, and copies the LAN command chat source.

If the target Linux user does not have root or passwordless sudo, the bootstrap does not abort the whole OpenClaw install. It copies the packaged Zorg MemoryDB and LAN command chat files, builds the LAN chat source when npm is available, and warns that system packages such as PostgreSQL client/server must be installed as root before rerunning `zorg/install-zorg-memorydb.sh` to apply the database schema.

## Database Rules

The database package keeps rule tables, markdown import tables, source chunk tables, recall hint tables, entity and association tables, and the default LAN command chat message table. The public baseline does not ship private live memory rows, transcripts, credentials, uploaded files, contact data, or operator-only state.

## Clean And Existing Installs

On a clean install, the bootstrap creates the database schema and starts with empty user/private memory tables. On an existing install, the bootstrap applies additive schema changes and preserves user data. Do not run `prepare_public_baseline.sql` against a live user install; that file exists only for building a public-safe package seed.

## Retired Markdown Memory Files

Active memory markdown files should not exist in a Zorg MemoryDB install. If retired `memory/*.md` files are found, the importer records them in `zorg_markdown_imports` and `memory_source_chunks` so the database becomes the durable memory source.

## Zorg MemoryDB first-run installer

Use the installer first on a fresh system. It follows the OpenClaw install pattern and upgrades/install prerequisites such as Node before installing Zorg MemoryDB and LAN command chat.

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/StefRush2099/Zorg_MemoryDB/main/scripts/install.sh | bash
```

Install order is intentional: OpenClaw is installed first from the normal OpenClaw package, then the Zorg MemoryDB add-on and LAN command chat are applied from this repository. This is the supported first-run path for hosts with missing or old software.

Use direct npm only on systems that already have Node >=22.19.0 and working global npm permissions:

```bash
node --version
sudo npm install -g --install-links=true git+https://github.com/StefRush2099/Zorg_MemoryDB.git
```

If `node --version` prints Node 12, Node 18, or any version below 22.19.0, do not use direct npm yet. Run the first-run installer above so Node is upgraded before npm executes OpenClaw lifecycle scripts.

Observed failure on old hosts: npm resolves the package dependency tree before the OpenClaw lifecycle script can run. On Node v12.22.9 this produces a long `npm WARN EBADENGINE` cascade. If the lifecycle script does run and upgrades Node during the same npm process, npm can still continue inside the temporary git package tree it already prepared. Zorg keeps a copy of the Node prerequisite repair script under `zorg/check-node-version.cjs`, which is part of the packaged add-on tree, so the lifecycle path remains available during direct git installs.

If direct npm has already failed once on an old host, verify the repaired runtime and rerun:

```bash
node --version
npm --version
sudo npm cache clean --force
sudo npm install -g --install-links=true git+https://github.com/StefRush2099/Zorg_MemoryDB.git
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

The Zorg MemoryDB installer updates existing OpenClaw gateway config files for token-protected Docker/Podman installs by setting `gateway.controlUi.allowInsecureAuth=true` and, by default, `gateway.controlUi.dangerouslyDisableDeviceAuth=true`. This keeps host-side TUI access working for private Docker installs where the gateway is protected by the configured gateway token.

For hardened public, HTTPS, or paired-device deployments, disable that compatibility setting before running the installer:

```bash
OPENCLAW_CONTROL_UI_DISABLE_DEVICE_AUTH=false zorg/install-zorg-memorydb.sh
```

If the host CLI still cannot connect after this patch, verify that the host-side OpenClaw config uses the same gateway token as the running container. Do not paste or publish the token in logs, issues, or chat.
