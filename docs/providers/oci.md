---
summary: "OCI Generative AI setup (RSA-signed auth, dual-path transport, embeddings)"
title: "Oracle Cloud Infrastructure GenAI"
read_when:
  - You want to use Oracle Cloud Infrastructure (OCI) Generative AI with OpenClaw
  - You need Cohere R-series, Meta Llama, xAI Grok, Mistral Codestral, or Gemini-via-OCI
  - You need Cohere embeddings via OCI for memory search
---

[OCI Generative AI](https://www.oracle.com/cloud/generative-ai/) hosts foundation models from Cohere, Meta, xAI, Mistral, Google, and OpenAI behind a single Oracle-managed inference plane. OpenClaw includes a bundled OCI provider plugin that authenticates with RSA-signed requests and routes traffic through OCI's OpenAI-compatible endpoint by default.

| Property        | Value                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| Provider id     | `oci`                                                                    |
| Plugin          | bundled, `enabledByDefault: false`                                       |
| Auth env vars   | `OCI_PROFILE`, `OCI_CONFIG_FILE`, `OCI_REGION`, `OCI_COMPARTMENT_ID`     |
| Onboarding flag | `--auth-choice oci-api-key`                                              |
| Direct CLI flag | `--oci-profile <profile-name>`                                           |
| API             | OpenAI-compatible (`openai-completions`) over RSA-signed `Authorization` |
| Default region  | `us-chicago-1` (Free Tier home)                                          |
| Default model   | `oci/meta.llama-3.3-70b-instruct`                                        |

## Two paths in one plugin

OCI Generative AI exposes two transport surfaces, and this plugin uses both:

- **V1 (OpenAI-compatible)** — `POST /openai/v1/chat/completions`. The default for chat. The catalog binds here so the standard `openai-completions` transport handles every chat request.
- **Regular (native OCI)** — `POST /20231130/actions/chat` and `POST /20231130/actions/embedText`. Used by the memory embedding adapter (Cohere `embed-multilingual-v3.0`) and exposed for power users who need OCI-native chat features (Cohere citations, search-grounded RAG, native streaming envelope) through the `OciNativeClient` and `createOciSignedFetch` exports.

Both paths share one credential — an OCI API key on disk in `~/.oci/config`.

## Getting started

<Steps>
  <Step title="Create an OCI API key">
    Generate an API key for your IAM user and download the config block from the [OCI Console](https://cloud.oracle.com/identity/users). Save the config and the private key under `~/.oci/`:

    ```ini
    [DEFAULT]
    user=ocid1.user.oc1..<your-user>
    fingerprint=ab:cd:ef:...
    tenancy=ocid1.tenancy.oc1..<your-tenancy>
    region=us-chicago-1
    key_file=~/.oci/oci_api_key.pem
    ```

    Free Tier accounts can create the `[API_FREE_TIER]` profile and use Llama, Grok, Codestral, and Gemini-via-OCI without charge subject to the published Free Tier limits.

  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice oci-api-key
```

```bash Direct flag
openclaw onboard --non-interactive \
  --auth-choice oci-api-key \
  --oci-profile DEFAULT
```

```bash Env only
export OCI_PROFILE=DEFAULT
```

    </CodeGroup>

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider oci
    ```

    The catalog includes Meta Llama 3.x, xAI Grok 3 and 4, Mistral Codestral, Google Gemini 2.5, OpenAI GPT-OSS, and Cohere Command R, R+, and A. If the OCI profile cannot be loaded, `openclaw models status --json` reports it under `auth.unusableProfiles`.

  </Step>
</Steps>

## Built-in catalog

The bundled catalog tracks the OpenAI-compatible roster published at [`/openai/v1/models`](https://docs.oracle.com/en-us/iaas/Content/generative-ai/overview.htm). Models served only on the native endpoint (Cohere R-series chat) are also listed because OCI maps them through the V1 path with the OpenAI request shape.

| Model ref                           | Name                    | Vision | Reasoning | Tool use |
| ----------------------------------- | ----------------------- | ------ | --------- | -------- |
| `oci/meta.llama-3.3-70b-instruct`   | Meta Llama 3.3 70B      | no     | no        | yes      |
| `oci/meta.llama-3.1-405b-instruct`  | Meta Llama 3.1 405B     | no     | no        | yes      |
| `oci/xai.grok-4`                    | xAI Grok 4              | yes    | yes       | yes      |
| `oci/xai.grok-3`                    | xAI Grok 3              | no     | no        | yes      |
| `oci/mistral.codestral-2506`        | Mistral Codestral 25.06 | no     | no        | yes      |
| `oci/google.gemini-2.5-pro`         | Google Gemini 2.5 Pro   | yes    | yes       | yes      |
| `oci/google.gemini-2.5-flash`       | Google Gemini 2.5 Flash | yes    | no        | yes      |
| `oci/openai.gpt-oss-120b`           | OpenAI GPT-OSS 120B     | no     | no        | yes      |
| `oci/cohere.command-r-08-2024`      | Cohere Command R        | no     | no        | yes      |
| `oci/cohere.command-r-plus-08-2024` | Cohere Command R+       | no     | no        | yes      |
| `oci/cohere.command-a-03-2025`      | Cohere Command A        | no     | no        | yes      |

<Warning>
  Catalog pricing reflects Oracle's published per-token rates at [oracle.com/cloud/generative-ai/pricing](https://www.oracle.com/cloud/generative-ai/pricing/). Numbers move; treat the bundled catalog as a default, not a billing contract.
</Warning>

## Memory embeddings

OCI exposes Cohere embeddings only on the native endpoint. The bundled memory adapter wires the same OCI profile through and posts to `/20231130/actions/embedText`:

| Model                                  | Dimensions | Notes                          |
| -------------------------------------- | ---------- | ------------------------------ |
| `cohere.embed-multilingual-v3.0`       | 1024       | Default                        |
| `cohere.embed-english-v3.0`            | 1024       | English-only                   |
| `cohere.embed-multilingual-light-v3.0` | 384        | Lighter dim for cheaper recall |
| `cohere.embed-english-light-v3.0`      | 384        | Lighter dim for cheaper recall |

The adapter requires a `compartmentId`. It reads in this order:

1. `agents-config plugins.oci-genai.compartmentId`
2. `OCI_COMPARTMENT_ID` env var
3. The `tenancy` from the loaded OCI profile

## Plugin configuration

Most setups need nothing beyond the API key. To override behavior, write under `plugins.entries.oci-genai.config`:

```json5
{
  plugins: {
    entries: {
      "oci-genai": {
        config: {
          region: "us-chicago-1",
          compartmentId: "ocid1.compartment.oc1..<your-compartment>",
          profileName: "DEFAULT",
          configFile: "~/.oci/config",
          authType: "api_key",
        },
      },
    },
  },
}
```

The `authType` field is reserved for future workload-identity flows (`instance_principal`, `resource_principal`). Today only `api_key` is wired end-to-end.

## Native chat for power users

Cohere's native features (citations, search-grounded RAG, deterministic seeds) are available through the exported `OciNativeClient`:

```ts
import { loadOciProfile, OciNativeClient, OciRequestSigner } from "@openclaw/oci-genai-provider";

const profile = await loadOciProfile({ profileName: "DEFAULT" });
const signer = new OciRequestSigner({ profile });
const client = new OciNativeClient({ signer });

const response = await client.chat({
  region: "us-chicago-1",
  modelId: "cohere.command-r-plus-08-2024",
  apiFormat: "COHERE",
  compartmentId: "ocid1.compartment.oc1..<your-compartment>",
  message: "Why is the sky blue?",
  maxTokens: 512,
});
```

The OpenClaw chat loop itself only uses the V1 path; the native client is for direct integrations that need OCI-only features.

## Manual config

The bundled plugin sets `enabledByDefault: false` so OCI does not appear unless you opt in. After onboarding, the standard manual override surface still applies:

```json5
{
  env: { OCI_PROFILE: "DEFAULT" },
  agents: {
    defaults: {
      model: { primary: "oci/meta.llama-3.3-70b-instruct" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      oci: {
        baseUrl: "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1",
        api: "openai-completions",
        models: [
          { id: "meta.llama-3.3-70b-instruct", name: "Meta Llama 3.3 70B" },
          { id: "cohere.command-r-plus-08-2024", name: "Cohere Command R+" },
        ],
      },
    },
  },
}
```

<Note>
  Gateway daemons (launchd, systemd, Docker) need access to `~/.oci/config` and the referenced private key. Mount the config and `oci_api_key.pem` into the runtime image, or point `OCI_CONFIG_FILE` at a path the daemon can read.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Memory search" href="/concepts/memory" icon="database">
    How memory embedding providers are picked and overridden.
  </Card>
  <Card title="Configuration reference" href="/gateway/config-agents#agent-defaults" icon="gear">
    Agent defaults and model configuration.
  </Card>
  <Card title="Models FAQ" href="/help/faq-models" icon="circle-question">
    Auth profiles, switching models, and resolving "no profile" errors.
  </Card>
</CardGroup>
