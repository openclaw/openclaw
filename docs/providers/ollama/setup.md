---
summary: "Connect OpenClaw to Ollama: auth rules, onboarding, and cloud models through a local host"
read_when:
  - You are connecting OpenClaw to Ollama for the first time
  - You need the auth rules for local, LAN, remote, or cloud hosts
  - You want cloud and local models served through one Ollama host
title: "Ollama setup"
sidebarTitle: "Setup"
---

## Auth rules

<AccordionGroup>
  <Accordion title="Local and LAN hosts">
    Loopback, private-network, `.local`, and bare-hostname Ollama URLs do not need a real bearer token. OpenClaw uses the `ollama-local` marker for these.
  </Accordion>
  <Accordion title="Remote and Ollama Cloud hosts">
    Public remote hosts and `https://ollama.com` require a real credential: `OLLAMA_API_KEY`, an auth profile, or the provider's `apiKey`. For direct hosted use, prefer the `ollama-cloud` provider.
  </Accordion>
  <Accordion title="Custom provider ids">
    A custom provider with `api: "ollama"` follows the same rules. For example, an `ollama-remote` provider pointed at a private LAN host can use `apiKey: "ollama-local"`; sub-agents resolve that marker through the Ollama provider hook instead of treating it as a missing credential. `memory.search.provider` can also point at a custom provider id so embeddings use that Ollama endpoint.
  </Accordion>
  <Accordion title="Auth profiles">
    SQLite auth stores hold the credential for a provider id; put endpoint settings (`baseUrl`, `api`, models, headers, timeouts) in `models.providers.<id>`. Older flat `auth-profiles.json` files such as `{ "ollama-windows": { "apiKey": "ollama-local" } }` are not a runtime format; `openclaw doctor --fix` imports them into SQLite as a canonical `ollama-windows:default` API-key profile with a backup. A `baseUrl` value in that legacy file is noise and should move to provider config.
  </Accordion>
  <Accordion title="Memory embedding scope">
    Bearer auth for Ollama memory embeddings is scoped to the host it was declared for:

    - A provider-level key is sent only to that provider's host.
    - `memory.search.remote.apiKey` and per-agent overrides are sent only to their remote embedding host.
    - A pure `OLLAMA_API_KEY` env value is treated as the Ollama Cloud convention and is not sent to local/self-hosted hosts by default.

  </Accordion>
</AccordionGroup>

## Getting started

<Tabs>
  <Tab title="Onboarding (recommended)">
    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard
        ```

        Select **Ollama**, then pick a mode: **Cloud + Local**, **Cloud only**, or **Local only**.

        On a fresh guided setup, OpenClaw first checks the default or configured
        Ollama host. Automatic discovery considers only models already loaded in
        memory, as reported by `/api/ps`, with tool support and at least 16K of
        context confirmed by `/api/show`. An eligible model installed on disk but
        not loaded is not an automatic candidate. The selected route still needs
        a real completion before OpenClaw saves it; discovery never pulls or
        loads an idle model.

        To use an installed but idle model in desktop Model Setup, choose
        **Choose connection** on the Ollama card, then **Local only**. This
        explicit setup path can prepare an eligible installed model for the live
        check without requiring it to be loaded already.
      </Step>
      <Step title="Select a model">
        `Cloud only` prompts for `OLLAMA_API_KEY` and suggests hosted cloud defaults. `Cloud + Local` and `Local only` prompt for an Ollama base URL and inspect installed models. If no tools-capable model is found, setup can ask permission to pull a recommended model. An installed `:latest` tag such as `gemma4:latest` is shown once instead of duplicating `gemma4`. `Cloud + Local` also checks whether the host is signed in for cloud access.
      </Step>
      <Step title="Verify">
        ```bash
        openclaw models list --provider ollama
        ```
      </Step>
    </Steps>

    Non-interactive:

    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health \
      --auth-choice ollama \
      --custom-base-url "http://ollama-host:11434" \
      --custom-model-id "qwen3.5:27b"
    ```

    `--custom-base-url` and `--custom-model-id` are optional; omitting them uses the local default host and the `gemma4` suggested model.

    A local model advertised as embedding-only cannot be selected as the chat
    default. Setup reports an error and leaves the existing configuration intact;
    reset preflight also rejects an explicitly selected embedding-only model or
    an inventory advertised as entirely embedding-only. Models that support both
    completion and embeddings remain eligible.

  </Tab>

  <Tab title="Manual setup">
    <Steps>
      <Step title="Install and start Ollama">
        Get it from [ollama.com/download](https://ollama.com/download), then pull a model:

        ```bash
        ollama pull gemma4
        ```

        For hybrid cloud access, run `ollama signin` on the same host.
      </Step>
      <Step title="Set a credential">
        ```bash
        export OLLAMA_API_KEY="ollama-local"    # local/LAN host, any value works
        export OLLAMA_API_KEY="your-real-key"   # https://ollama.com only
        ```

        Or in config: `openclaw config set models.providers.ollama.apiKey "OLLAMA_API_KEY"`.
      </Step>
      <Step title="Select the model">
        ```bash
        openclaw models list
        openclaw models set ollama/gemma4
        ```

        Or in config:

        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "ollama/gemma4" },
            },
          },
        }
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Cloud models through a local host

`Cloud + Local` routes both local and `:cloud` models through one reachable
Ollama host — this is Ollama's hybrid flow and the mode to pick during setup
when you want both.

OpenClaw prompts for the base URL, discovers local models, and checks
`ollama signin` status. When signed in, it suggests hosted defaults
(`kimi-k2.5:cloud`, `minimax-m2.7:cloud`, `glm-5.1:cloud`, `glm-5.2:cloud`). If
not signed in, setup stays local-only until you run `ollama signin`.

For cloud-only access without a local daemon, use `openclaw onboard --auth-choice ollama-cloud` and see [Ollama Cloud](/providers/ollama-cloud) — that path does not need `ollama signin` or a running server:

```bash
openclaw onboard --auth-choice ollama-cloud
openclaw models set ollama-cloud/kimi-k2.5:cloud
```

The cloud model list shown during `openclaw onboard` is populated live from
`https://ollama.com/api/tags`, capped at 500 entries, so the picker reflects
the current hosted catalog. If `ollama.com` is unreachable or returns no
models at setup time, OpenClaw falls back to its hardcoded suggested list so
onboarding still completes.
