# @openclaw/ai example: minimal chat completion

Smallest possible consumer of the published `@openclaw/ai` package: creates an
isolated runtime, registers the built-in API providers, and streams one
completion. No OpenClaw application code is involved — inside this repo the
workspace link resolves to the package's built `dist`, the same artifact npm
consumers install, so `pnpm build` must have run first.

```sh
ANTHROPIC_API_KEY=sk-ant-... node index.mjs "Say hello"
OPENAI_API_KEY=sk-... node index.mjs --provider openai "Say hello"
# keyless, against a local Ollama server (OLLAMA_MODEL overrides the model id)
node index.mjs --provider ollama "Say hello"
```

Text deltas stream to stdout; stop reason and token usage go to stderr.

Notes for library consumers:

- `createLlmRuntime()` gives you an isolated registry; nothing is registered
  globally by importing the package.
- `registerBuiltInApiProviders(runtime.registry)` opts into the eight built-in
  transports (Anthropic, OpenAI Completions/Responses, Azure OpenAI, ChatGPT
  Responses, Google, Vertex, Mistral). Provider SDK modules load lazily on
  first use.
- Host policy (custom fetch, secret redaction, strict-tool defaults, logging)
  is injectable via `configureAiTransportHost`; the defaults are inert.
- Full TypeScript types ship with the package; this example uses plain ESM so
  it runs with bare `node`.
