---
title: "Puter"
summary: "Puter user-pays Gemini access for OpenClaw"
read_when:
  - You want Gemini access in OpenClaw without managing a developer API key
  - You want to use a Puter browser sign-in or Puter auth token
---

# Puter

The Puter plugin adds Gemini models through Puter's OpenAI-compatible endpoint.
This is aimed at the "user-pays" flow: the developer does not need a separate
Gemini API key, but the user still signs in with a Puter account or provides a
Puter auth token.

- Provider: `puter`
- Auth: Puter browser sign-in or `PUTER_AUTH_TOKEN`
- API: Puter OpenAI-compatible endpoint (`https://api.puter.com/puterai/openai/v1/`)
- Default model: `puter/gemini-3.1-pro-preview`

## Getting started

Choose the auth path that fits your setup.

<Tabs>
  <Tab title="Browser sign-in">
    **Best for:** local machines where OpenClaw can open a browser.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice puter-browser
        ```
      </Step>
      <Step title="Complete the Puter login">
        OpenClaw opens the official Puter browser sign-in flow and stores the
        returned auth token as the `puter:default` profile.
      </Step>
      <Step title="Verify the provider">
        ```bash
        openclaw models list --provider puter
        ```
      </Step>
    </Steps>

    <Note>
    This path is meant for local desktop use. On remote or VPS hosts, use a
    dashboard token instead.
    </Note>
  </Tab>

  <Tab title="Auth token">
    **Best for:** remote hosts, CI-style setups, or when you already have a Puter token.

    <Steps>
      <Step title="Copy your token">
        Get a Puter auth token from `https://puter.com/dashboard`.
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice puter-auth-token
        ```

        Or provide it directly:

        ```bash
        openclaw onboard --non-interactive \
          --auth-choice puter-auth-token \
          --puter-auth-token "$PUTER_AUTH_TOKEN"
        ```
      </Step>
      <Step title="Verify the provider">
        ```bash
        openclaw models list --provider puter
        ```
      </Step>
    </Steps>
  </Tab>
</Tabs>

## Bundled Gemini models

The first bundled Puter catalog focuses on the Gemini models from Puter's
official Gemini tutorial:

- `puter/gemini-3.1-pro-preview`
- `puter/gemini-3.1-flash-lite-preview`
- `puter/gemini-3-flash-preview`
- `puter/gemini-3-pro-preview`

OpenClaw also normalizes the common bare Gemini preview aliases for this
provider, including:

- `puter/gemini-3.1-pro` -> `puter/gemini-3.1-pro-preview`
- `puter/gemini-3.1-flash-lite` -> `puter/gemini-3.1-flash-lite-preview`
- `puter/gemini-3.1-flash-preview` -> `puter/gemini-3-flash-preview`
- `puter/gemini-3-pro` -> `puter/gemini-3-pro-preview`

## Example config

```json5
{
  agents: {
    defaults: {
      model: { primary: "puter/gemini-3.1-pro-preview" },
    },
  },
}
```

## Notes

- This plugin avoids a developer-managed Gemini API key, but it is not
  anonymous access. A Puter user session or Puter auth token is still required.
- The transport is OpenAI-compatible, so OpenClaw uses the shared
  OpenAI-compatible replay/tooling path for this provider.
- The current bundled catalog is Gemini-first. Puter exposes additional models
  through the same endpoint, which can be expanded later.

## Related

- [Provider Directory](/providers)
- [Google (Gemini)](/providers/google)
- [Model Providers](/concepts/model-providers)
