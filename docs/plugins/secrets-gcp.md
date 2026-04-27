---
summary: "GCP Secret Manager provider plugin: resolve SecretRef sources of type gcp via Google Cloud Secret Manager"
read_when:
  - You want to resolve OpenClaw SecretRefs from Google Cloud Secret Manager
  - You are configuring the bundled secrets-gcp plugin
  - You need GCP authentication or version-pinning details for SecretRefs
title: "GCP secret provider plugin"
sidebarTitle: "Secrets GCP"
---

`secrets-gcp` is a bundled plugin that owns the `gcp` SecretRef source. It
resolves SecretRef ids against [Google Cloud Secret
Manager](https://cloud.google.com/secret-manager) using
[Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials).

The plugin is `enabledByDefault: false` and lazy-loads
`@google-cloud/secret-manager` only when a config actually references the `gcp`
source. Plugins that are not enabled have no startup or import cost.

## Quick start

1. Enable the plugin:

   ```json5
   {
     plugins: {
       entries: {
         "secrets-gcp": { enabled: true },
       },
     },
   }
   ```

2. Configure a provider alias under `secrets.providers`:

   ```json5
   {
     secrets: {
       providers: {
         myGcp: { source: "gcp", project: "my-project-id" },
       },
     },
   }
   ```

3. Reference the secret anywhere SecretRef is accepted:

   ```json5
   {
     models: {
       providers: {
         openai: {
           apiKey: { source: "gcp", provider: "myGcp", id: "OPENAI_API_KEY" },
         },
       },
     },
   }
   ```

## Configuration

| Field           | Type     | Required | Description                                                                                                                                                                                   |
| --------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`        | `"gcp"`  | yes      | Discriminator. Must be the literal string `"gcp"`.                                                                                                                                            |
| `project`       | `string` | yes      | GCP project id. Must match `^[a-z][a-z0-9-]{4,28}[a-z0-9]$` per the [GCP project id grammar](https://cloud.google.com/resource-manager/docs/creating-managing-projects#identifying_projects). |
| `versionSuffix` | `string` | no       | Either `"latest"` or a positive integer (e.g. `"3"`). Defaults to `"latest"`.                                                                                                                 |

SecretRef ids in this source must match `^[A-Za-z0-9_-]{1,255}$` per the
[GCP secret id grammar](https://cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/create#path-parameters)
(letters, digits, underscore, hyphen).

## Authentication

The plugin uses Application Default Credentials. Pick one of:

- **Local development** — run `gcloud auth application-default login` once.
  Credentials are cached at `~/.config/gcloud/application_default_credentials.json`.
- **Service account key** — set `GOOGLE_APPLICATION_CREDENTIALS` to the
  absolute path of a service account JSON key. The service account needs the
  `roles/secretmanager.secretAccessor` role on the target project (or on each
  individual secret).
- **GCE / GKE / Cloud Run / Cloud Functions** — the runtime metadata service
  is used automatically. The attached service account needs the
  `roles/secretmanager.secretAccessor` role.

The plugin does not accept inline credentials in OpenClaw config. This keeps
service-account JSON out of `openclaw.json` and keeps credential rotation
under GCP IAM control.

## Examples

<AccordionGroup>
  <Accordion title="Multiple environments">
    ```json5
    {
      secrets: {
        providers: {
          gcpProd: { source: "gcp", project: "my-org-prod" },
          gcpStaging: { source: "gcp", project: "my-org-staging" },
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: { source: "gcp", provider: "gcpProd", id: "OPENAI_API_KEY" },
          },
          anthropic: {
            apiKey: { source: "gcp", provider: "gcpStaging", id: "ANTHROPIC_API_KEY" },
          },
        },
      },
    }
    ```
  </Accordion>
  <Accordion title="Pinning to an explicit secret version">
    ```json5
    {
      secrets: {
        providers: {
          gcpPinned: {
            source: "gcp",
            project: "my-project-id",
            versionSuffix: "3",
          },
        },
      },
    }
    ```
    Use `"latest"` (the default) for normal rotation. Use an integer version
    when you want to roll back to a known-good secret version after a rotation
    incident.
  </Accordion>
</AccordionGroup>

## Required IAM

The identity that supplies ADC needs the `roles/secretmanager.secretAccessor`
role on either the target project or each individual secret resource. The
plugin only reads secret versions; it does not create or modify them.

If you prefer per-secret access control:

```sh
gcloud secrets add-iam-policy-binding OPENAI_API_KEY \
  --project my-project-id \
  --role roles/secretmanager.secretAccessor \
  --member serviceAccount:openclaw@my-project-id.iam.gserviceaccount.com
```

## Troubleshooting

<AccordionGroup>
  <Accordion title="Permission denied accessing the secret">
    Verify the active ADC identity has `secretmanager.secretAccessor` on the
    secret or project:

    ```sh
    gcloud auth application-default print-access-token | head -c 30
    gcloud secrets versions access latest --secret=OPENAI_API_KEY --project my-project-id
    ```

    The CLI invocation uses the same ADC the plugin uses, so a CLI failure
    reproduces the plugin failure.

  </Accordion>
  <Accordion title="Project id rejected by validateConfig">
    The plugin enforces the GCP project id grammar
    (`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`) before contacting the API to give a
    cleaner error than the eventual server-side rejection. Double-check the id
    with `gcloud projects list --filter="projectId:my-project-id"`.
  </Accordion>
  <Accordion title="Ref id rejected before the call">
    The plugin enforces the GCP secret-id grammar
    (`^[A-Za-z0-9_-]{1,255}$`). If your secret name contains other characters
    (dots, slashes, spaces), rename the secret in GCP. Path-traversal or shell
    metacharacter values are rejected here as defense in depth.
  </Accordion>
  <Accordion title="Plugin not loaded">
    Confirm the entry is enabled: `openclaw plugins status` should list
    `secrets-gcp` as enabled. If not, set
    `plugins.entries.secrets-gcp.enabled = true` in your config.
  </Accordion>
</AccordionGroup>

## Related

- [Secrets management](/gateway/secrets) — SecretRef contract, runtime
  snapshot behavior, and built-in providers.
- [OS keyring secret provider plugin](/plugins/secrets-keyring) — sibling
  plugin for OS-native credential stores.
- [Plugin SDK overview](/plugins/sdk-overview) — for plugin authors building
  additional secret-provider plugins.
