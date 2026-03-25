---
summary: "One page operational checklist for monitoring, tuning, and troubleshooting Ollama"
read_when:
  - You operate Ollama day to day
  - You want a repeatable tuning workflow
title: "Ollama operations checklist"
---

# Ollama operations checklist

Use this page to keep Ollama healthy, measurable, and efficient.

## 1. Service availability checks

Process check:

```bash
ps aux | rg "ollama serve|ollama" | cat
```

Port check:

```bash
ss -ltnp | rg 11434 | cat
```

API reachability check:

```bash
curl -sS http://127.0.0.1:11434/api/tags >/dev/null && echo ok
```

Model readiness check:

```bash
ollama list
```

## 2. Monitoring checks

Run a fixed prompt through `/api/chat` and capture these fields:

- `load_duration`: model load or cold-start time.
- `prompt_eval_duration` and `prompt_eval_count`: prompt processing cost.
- `eval_duration` and `eval_count`: generation speed and token output cost.
- `total_duration`: end-to-end request latency.

Example one-liner:

```bash
curl -s http://127.0.0.1:11434/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "llama3.2",
    "messages": [{"role":"user","content":"Summarize kernel scheduling in 100 words."}],
    "stream": false
  }' | jq '{total_duration, load_duration, prompt_eval_count, prompt_eval_duration, eval_count, eval_duration}'
```

Quick interpretation:

- High `load_duration` with normal later runs means cold starts.
- High `prompt_eval_duration` often means prompt or context is too large.
- High `eval_duration` per token indicates generation bottleneck.
- Rising `total_duration` with stable prompt size often indicates resource pressure.

## 3. Optimization sequence

Apply in this order and measure after each change:

1. Match model size to hardware first.
2. Keep a warm model for latency-sensitive workloads.
3. Tune context window (`num_ctx`) only as high as needed.
4. Cap output tokens (`num_predict`) to your real use case.
5. Control concurrency to avoid CPU, RAM, or VRAM thrash.
6. Put model storage on fast local SSD when possible.

## 4. Baseline and compare loop

1. Choose one representative prompt.
2. Run 3 times and save timing fields.
3. Change one setting only.
4. Run 3 times again.
5. Keep the change only if latency or throughput improves without quality regression.

## 5. Incident response matrix

Symptom: API is unreachable  
Fast check: `curl -sS http://127.0.0.1:11434/api/tags`  
Likely cause: service not running or wrong host/port  
Fix: start or restart `ollama serve`, confirm bind address and firewall path.

Symptom: model not found  
Fast check: `ollama list`  
Likely cause: model not pulled on this host  
Fix: run `ollama pull <model>`.

Symptom: very slow first token  
Fast check: compare `load_duration` first vs second run  
Likely cause: cold load  
Fix: pre-warm with a short request and keep hot path models loaded.

Symptom: out of memory or unstable latency spikes  
Fast check: lower `num_ctx`, retry same prompt  
Likely cause: model or context too large for available memory  
Fix: reduce context, reduce model size, or reduce concurrency.

Symptom: remote calls fail intermittently  
Fast check: call `/api/tags` from client network path  
Likely cause: proxy timeout or network path instability  
Fix: increase proxy timeout and simplify routing path.

## 6. Linux log workflow

If installed as a system service:

```bash
journalctl -u ollama -n 200 --no-pager
journalctl -u ollama -f
```

If running in a terminal, keep stdout or stderr open and capture timing fields from API responses for objective comparison.

## Optional OpenClaw add on

If OpenClaw uses Ollama as provider source:

- Keep `baseUrl` on native Ollama root (`http://host:11434`) for tool-calling reliability.
- OpenClaw defaults include a large context window fallback (`128000`) and max tokens (`8192`) when model metadata is incomplete.
- Auto-discovery uses `/api/tags` and best-effort context probing via `/api/show`.
- If you define `models.providers.ollama` explicitly, keep model definitions synchronized with what is installed.
