---
summary: "The basic, explicit, and custom base URL config shapes for the Ollama provider"
read_when:
  - You are writing the Ollama provider entry in your config
  - You want implicit discovery, a manual model list, or a custom base URL
title: "Ollama configuration"
sidebarTitle: "Configuration"
---

## Configuration

<Tabs>
  <Tab title="Basic (implicit discovery)">
    ```bash
    export OLLAMA_API_KEY="ollama-local"
    ```

    <Tip>
    If `OLLAMA_API_KEY` is set, you can omit `apiKey` in the provider entry; OpenClaw fills it in for availability checks.
    </Tip>

  </Tab>

  <Tab title="Explicit (manual models)">
    Use explicit config for hosted cloud setup, a non-default host/port, forced
    context windows, or fully manual model lists:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "https://ollama.com",
            apiKey: "OLLAMA_API_KEY",
            api: "ollama",
            models: [
              {
                id: "kimi-k2.5:cloud",
                name: "kimi-k2.5:cloud",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192
              }
            ]
          }
        }
      }
    }
    ```

  </Tab>

  <Tab title="Custom base URL">
    This example uses a nonempty manual model list, so it skips discovery:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            apiKey: "ollama-local",
            baseUrl: "http://ollama-host:11434", // No /v1 - native Ollama API URL
            api: "ollama", // Explicit: guarantees native tool-calling behavior
            timeoutSeconds: 300, // Optional: longer connect/stream budget for cold local models
            models: [
              {
                id: "qwen3:32b",
                name: "qwen3:32b",
                params: {
                  keep_alive: "15m", // Optional: keep the model loaded between turns
                },
              },
            ],
          },
        },
      },
    }
    ```

    <Warning>
    Do not add `/v1`. That path selects OpenAI-compatible mode, where tool calling is not reliable.
    </Warning>

  </Tab>
</Tabs>
