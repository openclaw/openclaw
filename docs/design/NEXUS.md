# ClaWorks Nexus Pack Registry

Local-first pack registry compatible with the ClawHub-style API shape used by ClaWorks robots.

## Start registry

```bash
# catalog defaults to ../claworks-packs
pnpm claworks:nexus

# custom catalog / port
CLAWORKS_NEXUS_CATALOG=/path/to/packs CLAWORKS_NEXUS_PORT=8080 pnpm claworks:nexus
```

## API

| Method | Path                                                  | Description               |
| ------ | ----------------------------------------------------- | ------------------------- |
| GET    | `/health`                                             | Registry status           |
| GET    | `/api/packages?family=claworks-pack&q=`               | Search packs              |
| GET    | `/api/packages/{slug}`                                | Package detail + versions |
| GET    | `/api/packages/{slug}/versions/{v}`                   | Version metadata          |
| GET    | `/api/packages/{slug}/versions/{v}/artifacts/generic` | Pack tarball (gzip tar)   |

## Robot install

Configure `packs.registry` in `claworks-robot` plugin config (default `http://127.0.0.1:8080`).

```bash
# Search registry from robot REST API
curl http://127.0.0.1:18800/v1/packs/registry?q=industry

# Install from Nexus
curl -X POST http://127.0.0.1:18800/v1/packs/install \
  -H 'Content-Type: application/json' \
  -d '{"source":"nexus://process-industry@1.0.0"}'

# Uninstall (removes from persisted install list)
curl -X DELETE http://127.0.0.1:18800/v1/packs/process-industry
```

Installed packs are extracted to `~/.claworks/packs/<slug>/` and tracked in `~/.claworks/packs-installed.json`.
