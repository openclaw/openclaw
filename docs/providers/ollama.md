---
summary: "Run OpenClaw with Ollama (cloud and local models)"
read_when:
  - You want to run OpenClaw with cloud or local models via Ollama
  - You need Ollama setup and configuration guidance
  - You want Ollama vision models for image understanding
title: "Ollama"
---

OpenClaw talks to Ollama's native API (`/api/chat`), not the OpenAI-compatible
`/v1` endpoint. Three modes are supported:

| Mode          | What it uses                                                                     |
| ------------- | -------------------------------------------------------------------------------- |
| Cloud + Local | A reachable Ollama host, serving local models and (if signed in) `:cloud` models |
| Cloud only    | `https://ollama.com` directly, no local daemon                                   |
| Local only    | A reachable Ollama host, local models only                                       |

For cloud-only setup with the dedicated `ollama-cloud` provider id, see
[Ollama Cloud](/providers/ollama-cloud). Use `ollama-cloud/<model>` refs when
you want cloud routing kept separate from a local `ollama` provider.

<Warning>
Do not use the `/v1` OpenAI-compatible URL (`http://host:11434/v1`). It breaks tool calling and models can emit raw tool-call JSON as plain text. Use the native URL: `baseUrl: "http://host:11434"` (no `/v1`).
</Warning>

The canonical config key is `baseUrl`. `baseURL` is also accepted for
OpenAI-SDK-style examples, but new config should use `baseUrl`.

This page is an index. Ollama is documented on nine pages, one per reader
job. Open the page that matches your task.

| Page                                                                  | Read it when                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [Ollama setup](/providers/ollama/setup)                               | You are connecting an account: auth rules per host type, onboarding and manual setup, and the hybrid cloud-plus-local flow. |
| [Ollama model discovery](/providers/ollama/model-discovery)           | You want to know how models are found: the implicit-discovery table, capability detection, and smoke-test probes.           |
| [Ollama node-local inference](/providers/ollama/node-local-inference) | You are running models on a paired node: setup steps, model filtering, and direct verification commands.                    |
| [Ollama vision and image description](/providers/ollama/vision)       | You are describing or understanding images through a local or hosted Ollama vision model.                                   |
| [Ollama configuration](/providers/ollama/configuration)               | You are writing the provider entry: implicit discovery, an explicit model list, or a custom base URL.                       |
| [Ollama config recipes](/providers/ollama/recipes)                    | You want a working config to copy: per-scenario recipes, model selection, and quick verification.                           |
| [Ollama Web Search](/providers/ollama/web-search)                     | You are using Ollama as the `web_search` provider: host, auth, and requirement rules.                                       |
| [Ollama advanced configuration](/providers/ollama/advanced)           | You are tuning behavior: context windows, thinking control, reasoning, costs, embeddings, and streaming.                    |
| [Ollama troubleshooting](/providers/ollama/troubleshooting)           | Something is broken: detection, connection, tool-JSON, garbled output, timeouts, and WSL2 crash loops.                      |

## Where each section moved

Every anchor the single-page version published still resolves here, so an
existing link such as `/providers/ollama#node-local-inference` keeps working.
Each entry points at the page that now holds the content.

**[Ollama setup](/providers/ollama/setup)**

- <a id="auth-rules" />[Auth rules](/providers/ollama/setup#auth-rules)
- <a id="getting-started" />[Getting started](/providers/ollama/setup#getting-started)
- <a id="cloud-models-through-a-local-host" />[Cloud models through a local host](/providers/ollama/setup#cloud-models-through-a-local-host)
- <a id="local-and-lan-hosts" />[Local and LAN hosts](/providers/ollama/setup#local-and-lan-hosts)
- <a id="remote-and-ollama-cloud-hosts" />[Remote and Ollama Cloud hosts](/providers/ollama/setup#remote-and-ollama-cloud-hosts)
- <a id="custom-provider-ids" />[Custom provider ids](/providers/ollama/setup#custom-provider-ids)
- <a id="auth-profiles" />[Auth profiles](/providers/ollama/setup#auth-profiles)
- <a id="memory-embedding-scope" />[Memory embedding scope](/providers/ollama/setup#memory-embedding-scope)
- <a id="onboarding-recommended" />[Onboarding (recommended)](/providers/ollama/setup#onboarding-recommended)
- <a id="run-onboarding" />[Run onboarding](/providers/ollama/setup#run-onboarding)
- <a id="select-a-model" />[Select a model](/providers/ollama/setup#select-a-model)
- <a id="verify" />[Verify](/providers/ollama/setup#verify)
- <a id="manual-setup" />[Manual setup](/providers/ollama/setup#manual-setup)
- <a id="install-and-start-ollama" />[Install and start Ollama](/providers/ollama/setup#install-and-start-ollama)
- <a id="set-a-credential" />[Set a credential](/providers/ollama/setup#set-a-credential)
- <a id="select-the-model" />[Select the model](/providers/ollama/setup#select-the-model)

**[Ollama model discovery](/providers/ollama/model-discovery)**

- <a id="model-discovery-(implicit-provider)" /><a id="model-discovery-implicit-provider" />[Model discovery (implicit provider)](/providers/ollama/model-discovery#model-discovery-implicit-provider)
- <a id="smoke-tests" />[Smoke tests](/providers/ollama/model-discovery#smoke-tests)

**[Ollama node-local inference](/providers/ollama/node-local-inference)**

- <a id="node-local-inference" />[Node-local inference](/providers/ollama/node-local-inference#node-local-inference)
- <a id="start-ollama-on-the-node" />[Start Ollama on the node](/providers/ollama/node-local-inference#start-ollama-on-the-node)
- <a id="connect-the-node-host" />[Connect the node host](/providers/ollama/node-local-inference#connect-the-node-host)
- <a id="use-it-from-an-agent" />[Use it from an agent](/providers/ollama/node-local-inference#use-it-from-an-agent)

**[Ollama vision and image description](/providers/ollama/vision)**

- <a id="vision-and-image-description" />[Vision and image description](/providers/ollama/vision#vision-and-image-description)

**[Ollama configuration](/providers/ollama/configuration)**

- <a id="configuration" />[Configuration](/providers/ollama/configuration#configuration)
- <a id="basic-implicit-discovery" />[Basic (implicit discovery)](/providers/ollama/configuration#basic-implicit-discovery)
- <a id="explicit-manual-models" />[Explicit (manual models)](/providers/ollama/configuration#explicit-manual-models)
- <a id="custom-base-url" />[Custom base URL](/providers/ollama/configuration#custom-base-url)

**[Ollama config recipes](/providers/ollama/recipes)**

- <a id="common-recipes" />[Common recipes](/providers/ollama/recipes#common-recipes)
- <a id="model-selection" />[Model selection](/providers/ollama/recipes#model-selection)
- <a id="quick-verification" />[Quick verification](/providers/ollama/recipes#quick-verification)
- <a id="local-model-with-auto-discovery" />[Local model with auto-discovery](/providers/ollama/recipes#local-model-with-auto-discovery)
- <a id="lan-ollama-host-with-manual-models" />[LAN Ollama host with manual models](/providers/ollama/recipes#lan-ollama-host-with-manual-models)
- <a id="ollama-cloud-only" />[Ollama Cloud only](/providers/ollama/recipes#ollama-cloud-only)
- <a id="cloud-plus-local-through-a-signed-in-daemon" />[Cloud plus local through a signed-in daemon](/providers/ollama/recipes#cloud-plus-local-through-a-signed-in-daemon)
- <a id="multiple-ollama-hosts" />[Multiple Ollama hosts](/providers/ollama/recipes#multiple-ollama-hosts)
- <a id="small-local-model-profile" />[Small local model profile](/providers/ollama/recipes#small-local-model-profile)

**[Ollama Web Search](/providers/ollama/web-search)**

- <a id="ollama-web-search" />[Ollama Web Search](/providers/ollama/web-search#ollama-web-search)

**[Ollama advanced configuration](/providers/ollama/advanced)**

- <a id="advanced-configuration" />[Advanced configuration](/providers/ollama/advanced#advanced-configuration)
- <a id="legacy-openai-compatible-mode" />[Legacy OpenAI-compatible mode](/providers/ollama/advanced#legacy-openai-compatible-mode)
- <a id="context-windows" />[Context windows](/providers/ollama/advanced#context-windows)
- <a id="thinking-control" />[Thinking control](/providers/ollama/advanced#thinking-control)
- <a id="reasoning-models" />[Reasoning models](/providers/ollama/advanced#reasoning-models)
- <a id="model-costs" />[Model costs](/providers/ollama/advanced#model-costs)
- <a id="memory-embeddings" />[Memory embeddings](/providers/ollama/advanced#memory-embeddings)
- <a id="streaming-configuration" />[Streaming configuration](/providers/ollama/advanced#streaming-configuration)

**[Ollama troubleshooting](/providers/ollama/troubleshooting)**

- <a id="troubleshooting" />[Troubleshooting](/providers/ollama/troubleshooting#troubleshooting)
- <a id="wsl2-crash-loop-repeated-reboots" />[WSL2 crash loop (repeated reboots)](/providers/ollama/troubleshooting#wsl2-crash-loop-repeated-reboots)
- <a id="ollama-not-detected" />[Ollama not detected](/providers/ollama/troubleshooting#ollama-not-detected)
- <a id="no-models-available" />[No models available](/providers/ollama/troubleshooting#no-models-available)
- <a id="connection-refused" />[Connection refused](/providers/ollama/troubleshooting#connection-refused)
- <a id="remote-host-works-with-curl-but-not-openclaw" />[Remote host works with curl but not OpenClaw](/providers/ollama/troubleshooting#remote-host-works-with-curl-but-not-openclaw)
- <a id="model-outputs-tool-json-as-text" />[Model outputs tool JSON as text](/providers/ollama/troubleshooting#model-outputs-tool-json-as-text)
- <a id="kimi-or-glm-returns-garbled-symbols" />[Kimi or GLM returns garbled symbols](/providers/ollama/troubleshooting#kimi-or-glm-returns-garbled-symbols)
- <a id="cold-local-model-times-out" />[Cold local model times out](/providers/ollama/troubleshooting#cold-local-model-times-out)
- <a id="large-context-model-is-too-slow-or-runs-out-of-memory" />[Large-context model is too slow or runs out of memory](/providers/ollama/troubleshooting#large-context-model-is-too-slow-or-runs-out-of-memory)

## Related

<CardGroup cols={2}>
  <Card title="Ollama Cloud" href="/providers/ollama-cloud" icon="cloud">
    Cloud-only setup with the dedicated `ollama-cloud` provider.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Model selection" href="/concepts/models" icon="brain">
    How to choose and configure models.
  </Card>
  <Card title="Ollama Web Search" href="/tools/ollama-search" icon="magnifying-glass">
    Full setup and behavior details for Ollama-powered web search.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
</CardGroup>
