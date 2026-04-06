# inferrs Provider

Bundled provider plugin for inferrs discovery and setup.

inferrs is a fast, local LLM inference server with an OpenAI-compatible API.
It supports models like Gemma 4, Qwen3, and others from HuggingFace.

## Quick start

Install inferrs and start serving Gemma 4:

```sh
brew tap ericcurtin/inferrs
brew install inferrs
inferrs serve google/gemma-4-E2B-it
```

The server listens on `http://127.0.0.1:8080` by default, which OpenClaw
auto-discovers. Run `openclaw configure` to point OpenClaw at a custom URL.
