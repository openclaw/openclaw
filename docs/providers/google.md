---
summary: "Google Gemini setup (API key + OAuth, image generation, media understanding, TTS, web search)"
title: "Google (Gemini)"
read_when:
  - You want to use Google Gemini models with OpenClaw
  - You need the API key or OAuth auth flow
---

The Google plugin provides access to Gemini models through Google AI Studio, plus
image generation, media understanding (image/audio/video), text-to-speech, and web search via
Gemini Grounding.

- Provider: `google`
- Auth: `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- API: Google Gemini API
- Optional local CLI harness: `google-gemini-cli`, enabled for direct bundled runtime registration only when `OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS=1` is set in the Gateway or daemon environment.

## Getting started

Choose your preferred auth method and follow the setup steps.

<Tabs>
  <Tab title="API key">
    **Best for:** standard Gemini API access through Google AI Studio.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice gemini-api-key
        ```

        Or pass the key directly:

        ```bash
        openclaw onboard --non-interactive \
          --mode local \
          --auth-choice gemini-api-key \
          --gemini-api-key "$GEMINI_API_KEY"
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "google/gemini-3.1-pro-preview" },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider google
        ```
      </Step>
    </Steps>

    <Tip>
    The environment variables `GEMINI_API_KEY` and `GOOGLE_API_KEY` are both accepted. Use whichever you already have configured.
    </Tip>

  </Tab>

  <Tab title="Gemini CLI (OAuth)">
    **Best for:** reusing an existing Gemini CLI login via PKCE OAuth instead of a separate API key.

    <Warning>
    The `google-gemini-cli` provider is an optional local CLI harness. Direct bundled runtime registration requires `OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS=1` in the Gateway or daemon environment before OpenClaw starts.
    </Warning>

    <Steps>
      <Step title="Enable the optional runtime harness">
        Set the opt-in flag in the same environment that starts the Gateway or daemon:

        ```bash
        OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS=1
        ```
      </Step>
      <Step title="Install the Gemini CLI">
        The local `gemini` command must be available on `PATH`.

        ```bash
        # Homebrew
        brew install gemini-cli

        # or npm
        npm install -g @google/gemini-cli
        ```
      </Step>
      <Step title="Log in via OAuth">
        ```bash
        openclaw models auth login --provider google-gemini-cli --set-default
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider google
        ```
      </Step>
    </Steps>

    - Default model: `google/gemini-3.1-pro-preview`
    - Runtime: `google-gemini-cli`
    - Alias: `gemini-cli`
    - Direct bundled runtime registration: requires `OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS=1`

    Gemini 3.1 Pro's Gemini API model id is `gemini-3.1-pro-preview`. OpenClaw accepts the shorter `google/gemini-3.1-pro` as a convenience alias and normalizes it before provider calls.

    **Environment variables:**

    - `OPENCLAW_ENABLE_GOOGLE_GEMINI_CLI_HARNESS`
    - `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`
    - `OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`

    (Or the `GEMINI_CLI_*` variants for the OAuth client values.)

    `google-gemini-cli/*` model refs are legacy compatibility aliases. New
    configs should use `google/*` model refs plus the `google-gemini-cli`
    runtime when they want local Gemini CLI execution.

  </Tab>
</Tabs>

## Capabilities

| Capability             | Supported                     |
| ---------------------- | ----------------------------- |
| Chat completions       | Yes                           |
| Image generation       | Yes                           |
| Music generation       | Yes                           |
| Text-to-speech         | Yes                           |
| Realtime voice         | Yes (Google Live API)         |
| Image understanding    | Yes                           |
| Audio transcription    | Yes                           |
| Video understanding    | Yes                           |
| Web search (Grounding) | Yes                           |
| Thinking/reasoning     | Yes (Gemini 2.5+ / Gemini 3+) |
| Gemma 4 models         | Yes                           |

## Related

For the current Google provider rebuild boundary and compatibility policy, see [Google provider rebuild boundary](/providers/google-provider-rebuild).
