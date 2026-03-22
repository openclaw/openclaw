# Azure Blob Storage plugin

OpenClaw plugin that exposes optional agent tools to **list storage containers**, **list blobs in a container**, and **read blob contents** from Azure Blob Storage using a connection string or storage account name + key.

Registered tools (all **opt-in** — see [Tool allowlists](#2-tools--optional-tools-and-sandbox-policy)):

| Tool                         | Purpose                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `azure_blob_list_containers` | List blob containers in the account (optional name prefix, capped results).       |
| `azure_blob_list_blobs`      | List blobs in a container (optional blob name prefix / “folder”, capped results). |
| `azure_blob_read`            | Download blob bytes as UTF-8 text or base64 (size limits apply).                  |

---

## `openclaw.json` — plugin setup

The Gateway must:

1. **Load** this extension from disk (`plugins.load.paths`).
2. **Allow** the plugin id if you use a global plugin allowlist (`plugins.allow`).
3. **Enable** it and pass **credentials** (`plugins.entries.azure-blob`).
4. **Expose** the optional tools via `tools.alsoAllow` (and `tools.sandbox.tools.allow` when sessions run sandboxed).

Use the **absolute path** to **this directory** (the folder that contains `openclaw.plugin.json`) on the **same machine** as the Gateway process. Do **not** point at `index.ts` — use the directory path to avoid plugin id mismatch warnings.

**Path placeholder:** replace `<ABSOLUTE_PATH_TO_AZURE_BLOB_EXTENSION>` below with your real path, for example:

- macOS/Linux: `/Users/you/src/openclaw/extensions/azure-blob`
- Windows: `C:\\src\\openclaw\\extensions\\azure-blob`
- Container: whatever path you mounted or cloned the repo to inside that environment

**Do not commit production secrets** — use placeholders, environment variables, or OpenClaw secret references. Restart the Gateway after changing config.

---

### 1. `plugins` — load path, allowlist, entries, credentials

| Key                                  | Role                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `plugins.load.paths`                 | **Directory** containing this extension (must include `openclaw.plugin.json`). Use the folder path, **not** `index.ts`. |
| `plugins.allow`                      | If you use a global plugin allowlist, include `azure-blob` so the plugin is not blocked.                                |
| `plugins.entries.azure-blob.enabled` | Set `true` so the plugin is active.                                                                                     |
| `plugins.entries.azure-blob.config`  | Storage auth and optional defaults (see `openclaw.plugin.json` / [Environment variables](#environment-variables)).      |

**Example (secrets redacted):**

```json
{
  "plugins": {
    "load": {
      "paths": ["<ABSOLUTE_PATH_TO_AZURE_BLOB_EXTENSION>"]
    },
    "allow": ["azure-blob"],
    "entries": {
      "azure-blob": {
        "enabled": true,
        "config": {
          "connectionString": "DefaultEndpointsProtocol=https;AccountName=<account>;AccountKey=<key>;EndpointSuffix=core.windows.net",
          "defaultContainer": "optional-default-container"
        }
      }
    }
  }
}
```

Instead of `connectionString`, you may use `accountName` + `accountKey`, and optionally `accountUrl` (sovereign clouds / custom domain) or `defaultContainer` (used when tools omit `containerName`).

---

### 2. `tools` — optional tools and sandbox policy

| Key                         | Role                                                                                                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.profile`             | Base tool profile (e.g. `coding`) used with your deployment; pair it with `alsoAllow` below.                                                                                            |
| `tools.alsoAllow`           | **Required for this plugin:** optional tools are not exposed until listed here (or you allow the plugin id `azure-blob`). Include each tool name you need.                              |
| `tools.sandbox.tools.allow` | When the **session is sandboxed**, OpenClaw applies an extra allowlist. Include every `azure_blob_*` tool that should be callable from the sandbox, plus any core tools you still need. |

**Example:**

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["azure_blob_read", "azure_blob_list_containers", "azure_blob_list_blobs"],
    "sandbox": {
      "tools": {
        "allow": [
          "read",
          "write",
          "edit",
          "apply_patch",
          "exec",
          "process",
          "group:sessions",
          "group:memory",
          "azure_blob_read",
          "azure_blob_list_containers",
          "azure_blob_list_blobs"
        ]
      }
    }
  }
}
```

If you use a **non-empty** sandbox allowlist, omitting `azure_blob_list_containers` or `azure_blob_list_blobs` will **block** those tools for sandboxed sessions even if they appear in `alsoAllow`.

---

## Environment variables

You can keep secrets out of `openclaw.json` by setting:

| Variable                                                   | Maps to                     |
| ---------------------------------------------------------- | --------------------------- |
| `AZURE_STORAGE_CONNECTION_STRING`                          | Connection string           |
| `AZURE_STORAGE_ACCOUNT_NAME` / `AZURE_STORAGE_ACCOUNT_KEY` | Shared key auth             |
| `AZURE_STORAGE_ACCOUNT_URL`                                | Custom blob endpoint        |
| `AZURE_STORAGE_DEFAULT_CONTAINER`                          | Default container for tools |

OpenClaw also supports **secret reference objects** in config for sensitive fields (see core OpenClaw documentation).

---

## Azure Storage account checklist

- **Networking:** the Gateway host must reach your blob endpoint on **HTTPS (443)** if firewalls or private endpoints apply.
- **Shared key access:** must be enabled if you use a connection string / account key.
- **Permissions:** the key (or SAS) must allow **list** and **read** as needed for the tools you use.

---

## Minimal merged example (`plugins` + `tools` only)

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["azure_blob_read", "azure_blob_list_containers", "azure_blob_list_blobs"],
    "sandbox": {
      "tools": {
        "allow": [
          "read",
          "write",
          "edit",
          "apply_patch",
          "exec",
          "process",
          "group:sessions",
          "group:memory",
          "azure_blob_read",
          "azure_blob_list_containers",
          "azure_blob_list_blobs"
        ]
      }
    }
  },
  "plugins": {
    "load": {
      "paths": ["<ABSOLUTE_PATH_TO_AZURE_BLOB_EXTENSION>"]
    },
    "allow": ["azure-blob"],
    "entries": {
      "azure-blob": {
        "enabled": true,
        "config": {
          "connectionString": "<DefaultEndpointsProtocol=...>"
        }
      }
    }
  }
}
```

---

## Security

- Never commit real **connection strings** or **account keys** to version control.
- Rotate credentials in Azure if they were ever exposed.
