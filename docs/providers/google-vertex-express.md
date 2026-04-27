---
summary: "Google Vertex AI Express Mode setup (Global endpoint access via API key)"
title: "Google Vertex AI (Express Mode)"
read_when:
  - You want to use Gemini models via Vertex AI's global endpoint
  - You have a Vertex AI Express API key
---

The Google Vertex AI (Express Mode) extension provides access to Gemini models through the Vertex AI global endpoint using a simple API key, similar to the Google AI Studio experience but within the Vertex AI ecosystem.

- Provider: `google-vertex-express`
- Auth: `GOOGLE_VERTEX_EXPRESS_API_KEY`
- Endpoint: `https://aiplatform.googleapis.com/v1/publishers/google/models/{model}:streamGenerateContent` (handled automatically)

## Getting started

<Steps>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice google-vertex-express-api-key
    ```

    Or pass the key directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice google-vertex-express-api-key \
      --google-vertex-express-api-key "$VERTEX_API_KEY"
    ```
  </Step>
  <Step title="Set a default model">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "google-vertex-express/gemini-3-flash-preview" },
        },
      },
    }
    ```
  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider google-vertex-express
    ```
  </Step>
</Steps>

## Capabilities

| Capability             | Supported |
| ---------------------- | --------- |
| Chat completions       | Yes       |
| Function calling       | Yes       |
| Streaming responses    | Yes       |
| Multi-modal (Image/Video) | Yes    |

<Note>
This extension is specifically designed for the **Express Mode** of Vertex AI, which uses a simplified authentication flow. For standard GCP OAuth or Service Account authentication, use the core `google` provider if supported or the upcoming enterprise Vertex provider.
</Note>
