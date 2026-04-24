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

1. **Hardware detection.** Gemmaclaw probes your system: GPU vendor and VRAM, CPU architecture, total and available RAM.
2. **Tier classification.** Based on what it finds, your machine is slotted into a hardware tier (e.g., "16 GB VRAM, mid-range GPU" or "CPU-only, 8 GB RAM").
3. **Profile selection.** Each tier maps to a tested configuration profile: which backend to use (Ollama, llama.cpp, or gemma.cpp), which Gemma model size, and which quantization level.
4. **Provisioning.** Gemmaclaw pulls the model and configures the backend automatically.
5. **Verification.** A quick smoke test confirms the setup works: inference runs, latency is acceptable, and tool-use prompts parse correctly.

If something does not fit (too little RAM, unsupported GPU), Gemmaclaw tells you what it tried and why it fell back, rather than silently degrading.

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

- Node.js 22+ and [pnpm](https://pnpm.io/installation)
- For gemma.cpp backend (advanced): cmake, g++ (or clang++), git, and a [HuggingFace token](https://huggingface.co/settings/tokens) (`HF_TOKEN`)

No pre-installed Ollama, llama.cpp, or gemma.cpp required. Gemmaclaw downloads and manages everything under `~/.gemmaclaw/`.

### Quick start

Clone, build, and run the setup wizard. Copy and paste the block below:

```bash
git clone https://github.com/gemmaclaw/gemmaclaw.git
cd gemmaclaw
pnpm install
pnpm build
node gemmaclaw.mjs setup
```

The setup command detects your hardware, picks the best backend, downloads the model, and runs a smoke test. When it finishes, your Gemma assistant is ready.

Example output:

```
Detecting hardware...
  CPU: x64, 12 cores (AMD Ryzen 9 5900X)
  RAM: 31.3 GB total, 22.1 GB available
  GPU: NVIDIA RTX 3090 (24 GB VRAM)

Recommended: Gemma 3 1B (Ollama) (815 MB download)
  NVIDIA GPU detected. Ollama provides the best GPU acceleration.

Provisioning ollama on port 11434...
[Ollama] Runtime started on port 11434 (PID 12345).
[Ollama] Model ready.

Smoke test passed. Response: "Hello!"

Setup complete! Your Gemma assistant is ready.
  API: http://127.0.0.1:11434/v1/chat/completions
  Model: gemma3:1b
  PID: 12345
```

### Advanced setup

Step-by-step prompts to override backend, model, and port:

```bash
node gemmaclaw.mjs setup --advanced
```

### Manual provisioning (advanced)

`gemmaclaw provision` is the low-level primitive. Use it when you know exactly what you want:

```bash
# Ollama (recommended for GPU setups, ~815 MB model download)
node gemmaclaw.mjs provision --backend ollama

# llama.cpp (flexible quants, ~726 MB GGUF download)
node gemmaclaw.mjs provision --backend llama-cpp

# gemma.cpp (CPU-first, requires cmake/g++, ~5 GB model download)
HF_TOKEN=hf_... node gemmaclaw.mjs provision --backend gemma-cpp
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

## Contributing

Issues and pull requests are welcome. Keep contributions small, reproducible, and backed by data where possible. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Links

- [Upstream OpenClaw](https://github.com/openclaw/openclaw) (the framework Gemmaclaw is built on)
- [OpenClaw docs](https://docs.openclaw.ai) (optional reference for advanced configuration)
- [gemma.cpp](https://github.com/google/gemma.cpp)

## Disclaimer

This project is composed of volunteers, including both Google engineers and members of the open source community. At this time, Gemmaclaw is not an official Google repository. The actions and opinions expressed in this repository do not reflect any official statements from Google, and no liability should be attributed to Google. This is a volunteer project intended to help empower people with AI, leveraging Gemma.
