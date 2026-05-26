# Zorg MemoryDB And LAN Command Chat Install

Zorg MemoryDB extends OpenClaw with PostgreSQL-backed durable memory and the LAN command chat fallback console.

## What The Installer Adds

The OpenClaw installer runs `zorg/install-zorg-memorydb.sh` when this package is installed. The script installs missing prerequisites, creates the OpenClaw workspace subdirectories for `zorg-memorydb` and `lan-chat`, applies the public-safe schema, seeds production rule records, imports packaged markdown rules into database tables, imports retired `memory/*.md` files into the database if they exist, and copies the LAN command chat source.

## Database Rules

The database package keeps rule tables, markdown import tables, source chunk tables, recall hint tables, entity and association tables, and the default LAN command chat message table. The public baseline does not ship private live memory rows, transcripts, credentials, uploaded files, contact data, or operator-only state.

## Clean And Existing Installs

On a clean install, the bootstrap creates the database schema and starts with empty user/private memory tables. On an existing install, the bootstrap applies additive schema changes and preserves user data. Do not run `prepare_public_baseline.sql` against a live user install; that file exists only for building a public-safe package seed.

## Retired Markdown Memory Files

Active memory markdown files should not exist in a Zorg MemoryDB install. If retired `memory/*.md` files are found, the importer records them in `zorg_markdown_imports` and `memory_source_chunks` so the database becomes the durable memory source.

## Install From The GitHub Release Repository

Use the HTTPS git install form. The npm `github:` shorthand can resolve through SSH on some systems and fail when root or the install user has no GitHub SSH key.

```bash
sudo npm install -g git+https://github.com/StefRush2099/Zorg_MemoryDB.git
```

## Zorg MemoryDB first-run installer

Use the installer first on a fresh system. It follows the OpenClaw install pattern and upgrades/install prerequisites such as Node before installing Zorg MemoryDB and LAN command chat.

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/StefRush2099/Zorg_MemoryDB/main/scripts/install.sh | bash
```

Use direct npm only on systems that already have Node >=22.19.0 and working global npm permissions:

```bash
sudo npm install -g git+https://github.com/StefRush2099/Zorg_MemoryDB.git
```
