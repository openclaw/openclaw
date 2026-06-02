# Atomic Chat Provider

Bundled provider plugin for Atomic Chat discovery and setup.

[Atomic Chat](https://github.com/AtomicBot-ai/Atomic-Chat) is a cross-platform
desktop/mobile app that runs local LLMs and exposes a single OpenAI-compatible
HTTP API at `http://127.0.0.1:1337/v1`. OpenClaw connects to it using the
`openai-completions` API and auto-discovers available models from
`/v1/models`.
