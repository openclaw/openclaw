---
summary: "Named storage destinations, explicit initialization, encryption, and provider configuration"
title: "Storage locations"
read_when:
  - Configuring an external disk or another storage destination
  - Choosing storage encryption and initializing a location
  - Diagnosing unavailable storage or a wrong encryption key
---

# Storage locations

A storage location names a destination for OpenClaw artifacts. Core storage owns
location identity, encryption, and health checks. Providers transfer objects, and
each consumer decides what to store and retain. Configuring a location does not
schedule a backup or move existing data.

The built-in `filesystem` provider supports an existing directory, including an
external disk or a mounted network filesystem. Additional providers come from
plugins. Referencing a bundled provider in config enables its owner plugin through
the normal plugin policy; an explicit disable still applies.

For Cloudflare R2 object storage, follow the
[Cloudflare plugin setup](/plugins/cloudflare) to create a bucket, configure
SecretRefs, and initialize an `r2` location.

## Configure and initialize a directory

Mount the intended disk and create the destination directory on it before
initializing storage. OpenClaw never creates the configured root directory. Use
an absolute path as seen by the process running the CLI or Gateway.

Set `OPENCLAW_STORAGE_PASSPHRASE` in that process's environment and keep a recoverable
copy of its value in your secret manager. Add a location to your config:

```json5
{
  storage: {
    locations: {
      archive: {
        provider: "filesystem",
        settings: { path: "/mnt/archive/openclaw" },
        encryption: {
          passphrase: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_STORAGE_PASSPHRASE",
          },
        },
      },
    },
  },
}
```

Initialize the destination explicitly, then verify a write/read/delete cycle:

```bash
openclaw storage init archive
openclaw storage test archive
openclaw storage list --json
```

Initialization writes `openclaw-storage.json` at the location root. Running `init`
again with the same encryption settings and passphrase is safe. Runtime operations
never create this marker: an empty mountpoint must not silently become storage on
the system disk.

## Configuration reference

Storage is optional; omitting `storage` or `storage.locations` defines no locations.
Each key under `storage.locations` is a name matching
`[a-z0-9][a-z0-9-]{0,62}`: 1–63 lowercase letters, digits, or hyphens, starting with
a letter or digit.

| Key                                              | Required                   | Meaning                                                                                    |
| ------------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------ |
| `storage.locations.<name>.provider`              | Yes                        | Nonempty provider id; `filesystem` is built in.                                            |
| `storage.locations.<name>.settings`              | Yes                        | Provider-owned JSON object, validated before opening a backend.                            |
| `storage.locations.<name>.encryption`            | Yes                        | `{ passphrase: SecretInput }` or the explicit string `"none"`.                             |
| `storage.locations.<name>.encryption.passphrase` | When encryption is enabled | Passphrase string or [SecretRef](/gateway/secrets/secretref-contract); prefer a reference. |

The filesystem provider accepts `settings: { path: "/absolute/existing/directory" }`.
It refuses a missing root and never overwrites an existing object key. Its check
reports free and total filesystem space when available.

Provider settings must be finite, bounded JSON: at most 32 nesting levels, 4,096
values, 512 keys per object, string lengths of 65,536, and 256 KiB when serialized.
Secret-bearing settings, including `accessKeyId`, `secretAccessKey`, and nested
credentials, must use valid SecretRefs. Provider-specific validation can impose
additional constraints. SecretRefs remain references until the provider requests
their values through the core secret resolver.

## Choose encryption deliberately

With a passphrase, core storage encrypts object streams before the provider receives
them and decrypts them when read. The `OCSTOR1` format uses scrypt to derive a master
key and authenticated AES-256-GCM segments with a separate key for every object.
An incorrect passphrase produces `wrong-key` and refuses access. Changing the
configured passphrase does not re-encrypt existing data.

Keep both the passphrase and the location marker. Losing either can make encrypted
objects unreadable. Object names and the initialization marker remain visible to
the storage provider; encryption protects object contents.

Set `encryption: "none"` only as an explicit operator choice, such as a destination
already protected by disk encryption. **Backups can contain credentials.** Without
storage encryption, anyone who can read the destination can read the stored bytes.

## Share a location across installations

Backups use `backups/<namespace>/` within a location. The namespace defaults to
the sanitized hostname; use `--namespace <name>` to choose a stable, distinct
name for each installation sharing the destination.

The first upload creates an `owner.json` claim containing the installation's
durable Gateway device ID, hostname, and claim time. It uses the same location
encryption settings as the archives. Backup creation checks the claim before
archiving and again before retention. A different device ID refuses the backup
and records a failed attempt, preventing a hostname collision from sharing
retention. Retention never deletes the claim.

Pass `--claim-namespace` to `backup create --to <location>` to deliberately take
over a namespace, for example after moving to new hardware. `backup enable --to`
also accepts the flag and stores it in the scheduled command only when explicitly
passed; those scheduled runs can then replace another installation's claim.
Prefer a separate namespace when both installations will continue running.

Recovery remains read-only: `backup list`, `backup verify`, and `backup restore`
with `--from <location>` do not require or change the claim. Listing without
`--namespace` also shows available namespaces and their claim hostnames. A
restored installation carries its original device identity and can continue its
namespace. A cloned copy running concurrently shares that identity and must use
its own `--namespace` to avoid sharing retention.

Backup status and Doctor preserve the newest attempt and newest successful result
for every backup kind and target alongside the newest 200 global attempts. A busy
job cannot hide an infrequent destination's last result. See
[Backups](/install/backups#copy-backups-offsite) and the
[Backup CLI](/cli/backup#recorded-runs-and-freshness) for commands and status details.

## Diagnose a location

`openclaw storage list` checks configured locations. `openclaw storage test <name>`
also writes a temporary `.openclaw-probe-<uuid>` object at the location root, reads and verifies it, then
deletes it. Every storage command supports `--json`; see the
[CLI reference](/cli/storage).

| State           | Next step                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`            | The marker and encryption identity are valid, and the backend check succeeded.                                                          |
| `unavailable`   | Reconnect the disk or restore access to the configured destination. Check that the CLI and Gateway see the same path and credentials.   |
| `uninitialized` | Confirm this is the intended new destination, then run `openclaw storage init <name>`. Never initialize an unexpected empty mountpoint. |
| `wrong-key`     | Restore the original passphrase or correct the SecretRef. Do not replace the marker to hide the mismatch.                               |
| `error`         | Read the returned message and correct provider settings, permissions, or the reported backend failure.                                  |

Gateway clients can list configured locations with `storage.locations.list` without
storage I/O, and request a health check with `storage.locations.probe { name }`.
Both require operator read scope. Initialization remains an explicit CLI operation.

See [Configuration reference](/gateway/configuration-reference) for other config
domains and [Secrets](/gateway/secrets) for secret provider setup.
