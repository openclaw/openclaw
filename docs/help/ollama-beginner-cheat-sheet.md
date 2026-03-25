---
summary: "A one page beginner guide to Ollama parts, access, and safe defaults"
read_when:
  - You are new to Ollama
  - You want a quick setup and first run path
title: "Ollama beginner cheat sheet"
---

# Ollama beginner cheat sheet

Use this page to understand Ollama quickly and run your first useful prompt.

## The parts

- `Daemon`: the Ollama service process that serves models.
- `Model store`: downloaded model blobs and metadata on disk.
- `CLI`: commands like `ollama pull`, `ollama run`, and `ollama list`.
- `HTTP API`: endpoints under `/api/*` for apps and scripts.
- `Runtime pipeline`: model load, prompt evaluation, then token generation.

## Fast start

1. Install Ollama from [ollama.com/download](https://ollama.com/download).
2. Start the service if it is not already running:

```bash
ollama serve
```

3. Pull one model:

```bash
ollama pull llama3.2
```

4. Run a first prompt:

```bash
ollama run llama3.2 "Explain TLS in one paragraph."
```

5. Confirm available models:

```bash
ollama list
```

## API access in 60 seconds

List local models:

```bash
curl -s http://127.0.0.1:11434/api/tags | jq
```

Chat with a model:

```bash
curl -s http://127.0.0.1:11434/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "llama3.2",
    "messages": [{"role":"user","content":"Give me three Linux log triage tips."}],
    "stream": false
  }' | jq
```

Inspect model metadata:

```bash
curl -s http://127.0.0.1:11434/api/show \
  -H 'Content-Type: application/json' \
  -d '{"name":"llama3.2"}' | jq
```

## Remote access basics

- Keep local-first while learning: `127.0.0.1:11434`.
- For remote use, prefer a private network path or a reverse proxy with auth.
- Avoid exposing an unauthenticated Ollama port directly to the public internet.

## Top mistakes to avoid

1. Using a model larger than your RAM or VRAM can support.
2. Raising context window too early, which spikes memory and slows responses.
3. Comparing performance without a fixed baseline prompt.
4. Treating first prompt latency as steady-state throughput.
5. Exposing remote Ollama without network controls.

## First 30 minutes workflow

1. Pull one model and run one fixed baseline prompt 3 times.
2. Record response timings from API fields (`total_duration`, `load_duration`, `prompt_eval_duration`, `eval_duration`).
3. Change one parameter only (for example `num_ctx` or model size).
4. Re-run the same prompt and compare latency and output quality.
5. Keep the best setting and repeat.

## Optional OpenClaw add on

If you use Ollama as an OpenClaw model source:

- Use native Ollama URL (`http://host:11434`) and not a `/v1` path.
- Set `OLLAMA_API_KEY` to any marker value, for example `ollama-local`.
- If OpenClaw auto-discovery is disabled by explicit provider config, define model entries manually.
- Local model cost is treated as zero in OpenClaw model metadata.
