# Gemmaclaw

Gemmaclaw makes it easy to run the best Gemma configuration for your hardware, out of the box. You tell it what you have (GPU, CPU, RAM), and it picks the right model, quantization, and backend so you can get a working Gemma-based assistant without tuning anything yourself. CPU-only setups are first-class, not an afterthought.

Built on top of the [OpenClaw](https://github.com/openclaw/openclaw) personal AI assistant framework. Volunteer-driven, Gemma-first.

## Goal

One command to a working Gemma assistant, regardless of what hardware you have.

- Detect your hardware tier (GPU model and VRAM, CPU cores, available RAM).
- Select the best backend, model size, and quantization profile for that tier.
- Fall back gracefully: high-end GPU setups get full-size models via Ollama, modest GPUs get smaller quants, and CPU-only machines get a viable path through gemma.cpp.
- Verify the result actually works (inference speed, memory headroom, tool-use reliability).

No manual model shopping. No "which quant do I pick?" guesswork. It just works.

## How it works

1. **Hardware detection.** Gemmaclaw probes your system: GPU vendor and VRAM, CPU architecture, total and available RAM. Apple Silicon Metal GPUs are detected with unified memory.
2. **Tier classification.** Based on what it finds, your machine is slotted into a hardware tier (e.g., "48 GB Apple Silicon" or "CPU-only, 8 GB RAM").
3. **Profile selection.** Each tier maps to a tested Gemma 4 model. Known issues (e.g., Flash Attention hangs on the 31B Dense model) are tracked in the model catalog with citations, and the selector automatically falls back to a stable alternative.
4. **Provisioning.** Gemmaclaw downloads Ollama, pulls the model, and runs a smoke test.
5. **Configuration.** Writes gateway config with the local Ollama provider, auth disabled for localhost, and full tool access enabled.
6. **Sandboxed tool execution.** When Docker is available, the agent's tool execution (shell commands, file operations, browser automation) runs inside isolated Docker containers via the OpenClaw sandbox system. The gateway itself runs on the host for simplicity. Pass `--no-container` to disable sandboxing and run tools directly on the host.
7. **Verification.** A smoke test confirms the model responds before the gateway starts.

If something does not fit (too little RAM, model has known issues on your platform), Gemmaclaw tells you what it tried and why it fell back, rather than silently degrading.

## Non-GPU support

CPU-only is a first-class path, not a fallback afterthought.

- Today: Gemma 2 and Gemma 3 run on CPU via [gemma.cpp](https://github.com/google/gemma.cpp) with competitive performance on machines with 8 GB or more RAM.
- Future: as gemma.cpp or other CPU backends add Gemma 4 support, Gemmaclaw will incorporate those profiles automatically.
- The goal is that someone with a laptop and no discrete GPU can still get a useful local assistant running Gemma.

## Roadmap

**Phase 1: Evidence.** Benchmark Gemma models across hardware tiers, backends, and quantizations. Document what actually works, how fast, and at what quality. No opinions without data.

**Phase 2: Productization.** Build the auto-detection and profile-selection tooling. Ship a `gemmaclaw doctor` command that diagnoses your system and recommends (or provisions) the right setup. Package tested profiles so they work out of the box.

**Phase 3: Community loop.** Open the profile registry to contributions. Users report what works on their hardware, profiles get refined, coverage grows. A working group keeps the evidence current as new Gemma releases land.

## Status

Phase 2 tooling is live: `gemmaclaw setup` auto-detects hardware and provisions the best backend. Phase 1 benchmarks continue in parallel. Contributions and hardware reports are welcome.

## Getting started

### Prerequisites

- Node.js 22+
- Docker (recommended, for containerized gateway)
- For gemma.cpp backend (advanced): cmake, g++ (or clang++), git, and a [HuggingFace token](https://huggingface.co/settings/tokens) (`HF_TOKEN`)

No pre-installed Ollama, llama.cpp, or gemma.cpp required. Gemmaclaw downloads and manages everything.

### Install

Clone the repo, build, and install the CLI globally:

```bash
git clone https://github.com/gemmaclaw/gemmaclaw.git
cd gemmaclaw
corepack enable && pnpm install
pnpm build
npm install -g .
```

Then run setup:

```bash
gemmaclaw setup
```

This detects your hardware, picks the best Gemma 4 model, downloads it via Ollama, configures the gateway, and starts it. When Docker is available, agent tool execution is automatically sandboxed in Docker containers. Open the Chat UI URL it prints at the end.

To disable Docker sandboxing (tools run directly on the host):

```bash
gemmaclaw setup --no-container
```

To restart the gateway later:

```bash
gemmaclaw chat
```

### Developer install

Same as above, but skip the global install and run commands directly:

```bash
git clone https://github.com/gemmaclaw/gemmaclaw.git
cd gemmaclaw
corepack enable && pnpm install
pnpm build
node gemmaclaw.mjs setup
node gemmaclaw.mjs chat
```

Example output:

```
Detecting hardware...
  CPU: arm64, 16 cores (Apple M4 Max)
  RAM: 48.0 GB total, 20.6 GB available
  GPU: Apple M4 Max (48 GB unified memory)

Recommended: Gemma 4 26B MoE (4B active) (18.0 GB download)
  Apple Silicon with 48 GB unified memory. Gemma 4 31B Dense skipped due to
  3 open issue(s) on darwin-arm64. 36+ GB RAM, M-series Max/Ultra.

Provisioning ollama on port 11434...
[Ollama] Runtime started on port 11434 (PID 12345).
[Ollama] Model ready.

Smoke test passed. Response: "Hello."

Writing gateway configuration...
  Provider: ollama (http://127.0.0.1:11434/v1)
  Model: ollama/gemma4:26b

Setup complete! Your Gemma assistant is ready.

  Sandbox: Docker (tools run in isolated containers)

Starting gateway on port 18789...
Gateway is ready.

Chat UI: http://127.0.0.1:18789/
```

### Advanced setup

Step-by-step prompts to override backend, model, and port:

```bash
gemmaclaw setup --advanced
```

### Manual provisioning (advanced)

`gemmaclaw provision` is the low-level primitive. Use it when you know exactly what you want:

```bash
# Ollama (recommended for GPU setups, ~815 MB model download)
gemmaclaw provision --backend ollama

# llama.cpp (flexible quants, ~726 MB GGUF download)
gemmaclaw provision --backend llama-cpp

# gemma.cpp (CPU-first, requires cmake/g++, ~5 GB model download)
HF_TOKEN=hf_... gemmaclaw provision --backend gemma-cpp
```

### Verify it works

After setup or provisioning, the backend exposes a local chat completions endpoint. Test it:

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma3:1b","messages":[{"role":"user","content":"Say hello"}]}'
```

Default ports: Ollama = 11434, llama.cpp = 8080, gemma.cpp = 11436.

The API follows the [OpenAI Chat Completions format](https://platform.openai.com/docs/api-reference/chat/create), so any client or library that speaks that protocol will work out of the box. See the OpenAI docs for the full request/response schema if needed.

### Troubleshooting

- **Ollama download fails**: check network connectivity. The binary is downloaded from GitHub releases.
- **llama.cpp server won't start**: verify the model file exists at `~/.gemmaclaw/models/llama-cpp/`. Re-run provision to re-download.
- **gemma.cpp build fails**: ensure cmake and g++ are installed (`apt-get install cmake g++`). Check that git submodules initialized correctly.
- **gemma.cpp model download fails**: verify `HF_TOKEN` is set and has access to the gated Gemma model on HuggingFace.
- **"Healthcheck failed"**: the backend process started but did not respond in time. Check system resources (RAM, disk).
- **Port already in use**: another process is using the default port. Use `--port <N>` to pick a different one, or use advanced setup.

### Data directory

All managed runtimes and models are stored under `~/.gemmaclaw/` (override with `GEMMACLAW_HOME`):

```
~/.gemmaclaw/
  runtimes/       # Downloaded/built backend binaries
  models/         # Downloaded model files
```

### Running E2E tests in Docker

Verify the install path works on a fresh machine:

```bash
docker build --no-cache -f test/e2e/Dockerfile.install .
```

To verify all backends work from a clean environment:

```bash
# Build the E2E image
docker build -f test/e2e/Dockerfile.provision -t gemmaclaw-provision-e2e .

# Test individual backends (direct provision + agent run)
docker run --rm gemmaclaw-provision-e2e ollama
docker run --rm gemmaclaw-provision-e2e llama-cpp
docker run --rm -e HF_TOKEN=hf_... gemmaclaw-provision-e2e gemma-cpp

# Test all
docker run --rm -e HF_TOKEN=hf_... gemmaclaw-provision-e2e all
```

### Benchmarking

Gemmaclaw includes a built-in benchmark suite that tests model quality across instruction following, reasoning, data extraction, safety, and coding tasks. The benchmark is hardware-aware: it detects your GPU, CPU, and RAM, then reports throughput alongside quality scores so you can compare configurations.

```bash
# Run full benchmark with LLM judge scoring
gemmaclaw benchmark

# Run deterministic scoring only (fast, no judge needed)
gemmaclaw benchmark --mock

# Benchmark a specific model
gemmaclaw benchmark --model gemma3:4b

# Run only coding tasks
gemmaclaw benchmark --filter coding

# Tune hardware parameters
gemmaclaw benchmark --context-length 8192 --gpu-layers 35 --batch-size 512
```

Results are written to `results/<model>__<timestamp>/` with three formats:

- `results.json`: machine-readable scores, timing, and hardware info
- `RESULTS.md`: markdown summary table
- `index.html`: GitHub Pages compatible dashboard

## Commands

| Command                          | Description                                                 |
| -------------------------------- | ----------------------------------------------------------- |
| `gemmaclaw setup`                | Auto-detect hardware, provision, configure, and start       |
| `gemmaclaw setup --no-container` | Same as above but disable Docker sandbox for tool execution |
| `gemmaclaw setup --advanced`     | Interactive wizard for manual backend/model/port selection  |
| `gemmaclaw chat`                 | Open a browser-based chat UI for your Gemma assistant       |
| `gemmaclaw chat --no-open`       | Start gateway without auto-opening the browser              |
| `gemmaclaw chat --port 3001`     | Start gateway on a specific port                            |
| `gemmaclaw tui`                  | Open terminal chat (TUI) with your Gemma assistant          |
| `gemmaclaw benchmark`            | Run the benchmark suite (full LLM judge mode)               |
| `gemmaclaw benchmark --mock`     | Run benchmark with deterministic scoring (fast CI mode)     |
| `gemmaclaw provision`            | Low-level: manually provision a specific backend            |
| `gemmaclaw doctor`               | Health checks and quick fixes                               |
| `gemmaclaw config`               | View and edit configuration                                 |

### npm scripts (development)

| Script                    | Description                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `pnpm benchmark`          | Run benchmark locally (full mode)                                  |
| `pnpm benchmark:mock`     | Run benchmark locally (deterministic only)                         |
| `pnpm test:e2e:benchmark` | Docker e2e: build image, install Ollama, pull model, run benchmark |
| `pnpm test:e2e:install`   | Docker e2e: verify clean install works                             |
| `pnpm build`              | Build the project                                                  |
| `pnpm test`               | Run unit tests                                                     |

## Contributing

Issues and pull requests are welcome. Keep contributions small, reproducible, and backed by data where possible. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Links

- [Upstream OpenClaw](https://github.com/openclaw/openclaw) (the framework Gemmaclaw is built on)
- [OpenClaw docs](https://docs.openclaw.ai) (optional reference for advanced configuration)
- [gemma.cpp](https://github.com/google/gemma.cpp)

## Disclaimer

This project is composed of volunteers, including both Google engineers and members of the open source community. At this time, Gemmaclaw is not an official Google repository. The actions and opinions expressed in this repository do not reflect any official statements from Google, and no liability should be attributed to Google. This is a volunteer project intended to help empower people with AI, leveraging Gemma.
