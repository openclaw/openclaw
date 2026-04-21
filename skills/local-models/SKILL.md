---
name: local-models
description: Run local language models from the Hugging Face Hub with llama.cpp and GGUF. Use when finding a llama.cpp-compatible repo, reading the `?local-app=llama.cpp` snippet, confirming exact `.gguf` filenames from the Hub tree API, choosing an existing GGUF that fits local hardware, or writing `llama-cli` / `llama-server` commands for ready-to-run GGUF repos.
metadata:
  {
    "openclaw":
      {
        "emoji": "🦙",
        "homepage": "https://huggingface.co/docs/hub/gguf-llamacpp",
        "requires": { "anyBins": ["llama-cli", "llama-server"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "llama.cpp",
              "bins": ["llama-cli", "llama-server"],
              "label": "Install llama.cpp (brew)",
            },
          ],
      },
  }
---

# Local models with llama.cpp

Find the right Hugging Face GGUF repo, choose the existing file or Hub snippet that matches the user's hardware, and launch it with `llama-cli` or `llama-server`.

## Quick start

Install llama.cpp:

```bash
brew install llama.cpp
winget install llama.cpp
```

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
make
```

Authenticate for gated repos:

```bash
hf auth login
```

Search the Hub:

```text
https://huggingface.co/models?apps=llama.cpp&sort=trending
https://huggingface.co/models?search=Qwen3.6&apps=llama.cpp&sort=trending
https://huggingface.co/models?search=<term>&apps=llama.cpp&num_parameters=min:0,max:24B&sort=trending
```

Run directly from the Hub:

```bash
llama-cli -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
```

Run an exact GGUF file:

```bash
llama-server \
    --hf-repo unsloth/Qwen3.6-35B-A3B-GGUF \
    --hf-file Qwen3.6-35B-A3B-UD-Q4_K_M.gguf \
    -c 4096
```

Smoke-test a local server:

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
```

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer no-key" \
  -d '{
    "messages": [
      {"role": "user", "content": "Write a limerick about exception handling"}
    ]
  }'
```

## Workflow

1. Search the Hub with `apps=llama.cpp`.
2. Open `https://huggingface.co/<repo>?local-app=llama.cpp`.
3. Prefer the exact HF local-app snippet and hardware recommendation when it is visible.
4. Confirm exact `.gguf` filenames with `https://huggingface.co/api/models/<repo>/tree/main?recursive=true`.
5. Launch with `llama-cli -hf <repo>:<QUANT>` or `llama-server -hf <repo>:<QUANT>`.
6. Fall back to `--hf-repo` plus `--hf-file` when the repo uses custom file naming.
7. If the repo does not already expose runnable GGUF files, stop and say the repo is out of scope for this skill.

## GGUF choice

- Prefer the exact quant that HF marks as compatible on the `?local-app=llama.cpp` page.
- Keep repo-native labels such as `UD-Q4_K_M` instead of normalizing them.
- Default to `Q4_K_M` unless the repo page or hardware profile suggests otherwise.
- Prefer `Q5_K_M` or `Q6_K` for code or technical workloads when memory allows.
- Consider `Q3_K_M`, `Q4_K_S`, or repo-specific `IQ` / `UD-*` variants for tighter RAM or VRAM budgets.
- Treat `mmproj-*.gguf` files as projector weights, not the main checkpoint.

## References

- `references/hub-discovery.md` for URL-first workflows, Hub search, tree API extraction, and command reconstruction.
- `references/model-selection.md` for GGUF variant selection, memory guidance, and existing-file tradeoffs.
- `references/hardware.md` for Metal, CUDA, ROCm, or CPU build and acceleration details.

## Resources

- llama.cpp: `https://github.com/ggml-org/llama.cpp`
- Hugging Face GGUF + llama.cpp docs: `https://huggingface.co/docs/hub/gguf-llamacpp`
- Hugging Face Local Apps docs: `https://huggingface.co/docs/hub/main/local-apps`
- Hugging Face Local Agents docs: `https://huggingface.co/docs/hub/agents-local`
