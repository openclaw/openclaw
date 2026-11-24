---
summary: "Use Gemini through Google Cloud Vertex AI with Application Default Credentials"
title: "Google (Vertex AI)"
read_when:
  - You want Gemini models with Google Cloud project billing
  - You need to configure Vertex AI credentials for a Gateway
---

The bundled Google plugin routes `google-vertex/*` model requests through
Google Cloud Vertex AI. This guide covers Application Default Credentials (ADC),
including gcloud user credentials, service account keys, and metadata-server
credentials on Google Cloud.

For an API key from Google AI Studio, use [Google (Gemini)](/providers/google).

## Prerequisites

Start with an installed OpenClaw Gateway. If this is a new installation, complete
[Getting started](/start/getting-started) first, then configure Vertex AI below.
There is no dedicated Vertex AI onboarding auth choice.

You need a Google Cloud project with billing enabled and an identity allowed to
make Vertex AI requests, for example through `roles/aiplatform.user`.
See [Google's ADC setup guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gcp-auth).
Enable the Vertex AI API for the project:

```bash
gcloud services enable aiplatform.googleapis.com --project your-project-id
```

## Authenticate

Choose the credential source available to the user that runs the Gateway.

<Tabs>
  <Tab title="gcloud user ADC">
    On a workstation, run:

    ```bash
    gcloud auth application-default login
    ```

    This writes an ADC file that OpenClaw can discover. Run it as the Gateway's
    operating-system user. Leave `GOOGLE_APPLICATION_CREDENTIALS` unset to use
    this file; an explicit path takes precedence over gcloud's default file.

    A regular `gcloud auth login` alone does not create user ADC.

  </Tab>
  <Tab title="Service account key">
    If your deployment uses a JSON service account key, follow
    [Google's key creation instructions](https://docs.cloud.google.com/iam/docs/keys-create-delete).
    Grant the service account permission to use Vertex AI in your project and
    keep the key file readable by the Gateway's operating-system user.

    Set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path in the environment
    configuration below.

  </Tab>
  <Tab title="Attached service account">
    On Google Cloud hosts with metadata-server credentials (for example, a GCE VM
    with an attached service account), a credentials file is not required by the
    request transport. However, automatic OpenClaw credential discovery requires
    a recognized ADC file. For a metadata-only deployment, explicitly select ADC:

    ```bash
    openclaw models auth paste-api-key --provider google-vertex
    # Paste exactly: gcp-vertex-credentials
    ```

    This value is a marker, not a secret. The Google authentication library obtains
    the access token from the host's identity. Project and location are still
    required. Leave `GOOGLE_APPLICATION_CREDENTIALS` unset if no file is used.

  </Tab>
</Tabs>

<Warning>
  Do not paste an OAuth access token into an API-key profile. The ADC marker must
  be exactly `gcp-vertex-credentials`; other stored values are sent as
  `x-goog-api-key` instead of selecting ADC.
</Warning>

## Configure the Gateway

Set the project and location in the Gateway service environment or in
`~/.openclaw/.env`:

```bash
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_LOCATION=global

# Only for a service account key or another explicit ADC file:
# GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/credentials.json
```

An interactive shell's exports are not automatically inherited by an already
running Gateway service. Use the Gateway's environment, then restart your Gateway
after changing it. See [Environment variables](/help/environment).

Set the default model in `~/.openclaw/openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "google-vertex/gemini-3.5-flash" },
    },
  },
}
```

The Google plugin supplies a static Vertex model catalog. You do not need a
`models.providers` entry or an API key for ADC. With project, location, and a
recognized ADC file (`authorized_user`, `service_account`, or `external_account`),
OpenClaw discovers the ADC marker automatically. Metadata-only deployments use
the stored marker described above.

### Environment variables

| Variable                         | Purpose                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | Required project ID. `GCLOUD_PROJECT` is an accepted fallback.                                                                                                 |
| `GOOGLE_CLOUD_LOCATION`          | Required endpoint location, such as `global` or `us-central1`. Model availability depends on location.                                                         |
| `GOOGLE_APPLICATION_CREDENTIALS` | Explicit ADC JSON file path. Takes precedence over default file discovery.                                                                                     |
| `CLOUDSDK_CONFIG`                | Optional gcloud directory override. When set, OpenClaw looks only there for `application_default_credentials.json` unless an explicit credentials path is set. |
| `GOOGLE_CLOUD_QUOTA_PROJECT`     | Optional quota project sent as `x-goog-user-project`; overrides the ADC file's `quota_project_id`.                                                             |

## Verify and chat

List the bundled catalog, including models you have not configured:

```bash
openclaw models list --refresh --all --provider google-vertex
```

`--refresh` loads provider discovery; it does not query a live Vertex model
inventory or prove that a token can be obtained. Check local credential resolution:

```bash
openclaw models status
```

Automatically discovered file credentials appear with `source=gcloud adc`.
This label is also used for recognized service account files; it does not mean
that a live request succeeded. To verify the complete path, open the terminal UI
and send a message:

```bash
openclaw tui
```

## Troubleshooting

- **Missing provider auth:** check the Gateway user's ADC file, project, and
  location. Metadata-only hosts need the stored ADC marker. If an explicit
  credentials path or `CLOUDSDK_CONFIG` is set, OpenClaw does not fall back to
  another directory when that selected file is missing.
- **Project or location error:** set `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`)
  and `GOOGLE_CLOUD_LOCATION` in the Gateway's environment.
- **Permission denied:** check the requesting identity's Vertex AI permissions
  and that the API is enabled in the project.
- **Model not found:** select a model from the bundled catalog and check its
  availability in your configured location in Google's documentation.

## Related

- [Google (Gemini)](/providers/google)
- [Model providers](/concepts/model-providers)
- [Authentication](/gateway/authentication)
