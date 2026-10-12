---
summary: "Configure Cloudflare R2 as an encrypted OpenClaw storage location"
title: "Cloudflare"
read_when:
  - You want to store OpenClaw artifacts in Cloudflare R2
  - You need to configure an R2 bucket, credentials, or jurisdiction
  - You are diagnosing R2 storage access
---

# Cloudflare

The bundled Cloudflare plugin provides `r2` storage locations through Cloudflare's
S3-compatible API. OpenClaw handles location identity and encryption; the plugin
transfers objects to your bucket. Configuring a location does not schedule backups
or move existing data.

## Create a bucket and credentials

1. In the Cloudflare dashboard, open **R2 object storage** and create a private
   bucket, such as `openclaw-artifacts`. Bucket names must contain 3–63 lowercase
   letters, digits, or hyphens, and cannot begin or end with a hyphen.
2. Record your Cloudflare account ID and the bucket's jurisdiction, if any.
3. From R2's **Account Details**, select **Manage** next to **API Tokens**, then
   **Create Account API token**.
4. Select **Object Read & Write** and limit access to the bucket you created.
5. Save the **Access Key ID** and **Secret Access Key** in your secret manager.
   Cloudflare shows the secret access key only once.

Use the R2 S3 credentials from this flow. See Cloudflare's
[bucket creation guide](https://developers.cloudflare.com/r2/buckets/create-buckets/)
and [R2 token guide](https://developers.cloudflare.com/r2/api/tokens/).

## Configure a location

Make the saved credentials available as `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` in the environment that runs the CLI and Gateway. Create a
separate encryption passphrase, keep a recoverable copy in your secret manager,
and provide it as `OPENCLAW_STORAGE_PASSPHRASE` in that environment.

Add this to your OpenClaw config, replacing the example account ID and bucket:

```json5
{
  storage: {
    locations: {
      offsite: {
        provider: "r2",
        settings: {
          accountId: "00000000000000000000000000000000",
          bucket: "openclaw-artifacts",
          prefix: "openclaw",
          accessKeyId: {
            source: "env",
            provider: "default",
            id: "R2_ACCESS_KEY_ID",
          },
          secretAccessKey: {
            source: "env",
            provider: "default",
            id: "R2_SECRET_ACCESS_KEY",
          },
        },
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

R2 credential settings require [SecretRefs](/gateway/secrets/secretref-contract);
plaintext credential strings are rejected. You can use another configured secret
provider instead of environment variables. A Gateway running as a service needs
the values in its own environment, not just in your interactive shell.

Referencing `provider: "r2"` automatically enables the bundled `cloudflare` plugin
under the normal plugin policy. Explicit disablement and deny rules still apply.

## Initialize and test

Confirm the bucket and prefix, then initialize the location and verify a complete
write/read/delete cycle:

```bash
openclaw storage init offsite
openclaw storage test offsite
openclaw storage list --json
```

Initialization writes the location marker at
`openclaw/openclaw-storage.json` for the example above. The displayed target is
`r2://openclaw-artifacts/openclaw`. A successful test confirms that it wrote, read,
verified, and deleted its check object; add `--json` for `state: "ok"`.
Keep the marker and encryption passphrase: losing either can make encrypted
objects unreadable. R2 health checks verify bucket access without reporting free
or total space.

## Settings

All fields below belong to `storage.locations.<name>.settings`.

| Field             | Required | Meaning                                                                                                                                                                                        |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountId`       | Yes      | Cloudflare account ID: exactly 32 lowercase hexadecimal characters.                                                                                                                            |
| `bucket`          | Yes      | Existing R2 bucket name, following the naming rules above.                                                                                                                                     |
| `prefix`          | No       | Object-key prefix. Use slash-separated segments containing only letters, digits, `.`, `_`, and `-`; no empty, `.` or `..` segments, or leading/trailing slash. Omit it to use the bucket root. |
| `jurisdiction`    | No       | `"eu"` or `"fedramp"`, matching the bucket's jurisdiction. Omit for the default endpoint.                                                                                                      |
| `accessKeyId`     | Yes      | SecretRef for the R2 access key ID.                                                                                                                                                            |
| `secretAccessKey` | Yes      | SecretRef for the R2 secret access key.                                                                                                                                                        |
| `sessionToken`    | No       | SecretRef for the session token when using R2 temporary credentials.                                                                                                                           |

The plugin uses region `auto`. It chooses
`https://<accountId>.r2.cloudflarestorage.com` by default,
`https://<accountId>.eu.r2.cloudflarestorage.com` for `"eu"`, or
`https://<accountId>.fedramp.r2.cloudflarestorage.com` for `"fedramp"`.
No custom endpoint is required. A prefix is a namespace within the bucket, not a
separate permission boundary; the token remains scoped to the bucket.

## Troubleshooting

For a 401 or 403 error, check that the R2 token has **Object Read & Write** on the
configured bucket and that both SecretRefs resolve in the process running the
command. For temporary credentials, also verify that the session token is present
and has not expired.

If the bucket is missing, create it in the configured account or correct
`accountId`, `bucket`, and `jurisdiction`. OpenClaw does not create buckets.

If the location has no initialization marker, confirm that the prefix is correct before
running `openclaw storage init <name>`. Changing the prefix selects a different
location root. For `wrong-key`, restore the original encryption passphrase;
replacing the marker does not recover encrypted data.

See [Storage locations](/concepts/storage-locations) for encryption and location
lifecycle, and the [storage CLI reference](/cli/storage) for command output.
