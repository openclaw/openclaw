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

Planning is active. Phase 1 benchmarks are scoped but execution is gated by evidence collection, not assumptions. No promises on timelines. Contributions and hardware reports are welcome.

## Getting started

### Prerequisites

- Node.js 22+ and pnpm
- For gemma.cpp backend: cmake, g++ (or clang++), and git
- For gemma.cpp model downloads: a [HuggingFace token](https://huggingface.co/settings/tokens) (`HF_TOKEN` env var)

No pre-installed Ollama, llama.cpp, or gemma.cpp required. Gemmaclaw downloads and manages everything.

### Install

```bash
git clone https://github.com/gemmaclaw/gemmaclaw.git
cd gemmaclaw
pnpm install
pnpm build
```

### Provision a backend

Pick a backend and provision it. This downloads the runtime, pulls the smallest known-working Gemma model, starts the server, and verifies a chat completion:

```bash
# Ollama (recommended for GPU setups, ~815 MB model download)
node gemmaclaw.mjs provision --backend ollama

# llama.cpp (flexible quants, ~726 MB GGUF download)
node gemmaclaw.mjs provision --backend llama-cpp

# gemma.cpp (CPU-first, requires cmake/g++, ~5 GB model download)
HF_TOKEN=hf_... node gemmaclaw.mjs provision --backend gemma-cpp
```

The command prints the API base URL and PID when done. The backend stays running in the background.

### Verify it works

After provisioning, the backend serves an OpenAI-compatible API at `http://127.0.0.1:<port>/v1/chat/completions`. Test it:

```bash
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemma3:1b","messages":[{"role":"user","content":"Say hello"}]}'
```

Ports: Ollama = 11434, llama.cpp = 8080, gemma.cpp = 11436.

### Troubleshooting

- **Ollama download fails**: check network connectivity. The binary is downloaded from GitHub releases.
- **llama.cpp server won't start**: verify the model file exists at `~/.gemmaclaw/models/llama-cpp/`. Re-run provision to re-download.
- **gemma.cpp build fails**: ensure cmake and g++ are installed (`apt-get install cmake g++`). Check that git submodules initialized correctly.
- **gemma.cpp model download fails**: verify `HF_TOKEN` is set and has access to the gated Gemma model on HuggingFace.
- **"Healthcheck failed"**: the backend process started but did not respond in time. Check system resources (RAM, disk). Increase timeout by re-provisioning on a faster machine.
- **Port already in use**: another process is using the default port. Use `--port <N>` to pick a different one.

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

# Test individual backends
docker run --rm gemmaclaw-provision-e2e ollama
docker run --rm gemmaclaw-provision-e2e llama-cpp
docker run --rm -e HF_TOKEN=hf_... gemmaclaw-provision-e2e gemma-cpp

# Test all
docker run --rm -e HF_TOKEN=hf_... gemmaclaw-provision-e2e all
```

## Contributing

Issues and pull requests are welcome. Keep contributions small, reproducible, and backed by data where possible. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Links

- [Upstream OpenClaw](https://github.com/openclaw/openclaw)
- [OpenClaw docs](https://docs.openclaw.ai)
- [gemma.cpp](https://github.com/google/gemma.cpp)

## Disclaimer

This project is composed of volunteers, including both Google engineers and members of the open source community. At this time, Gemmaclaw is not an official Google repository. The actions and opinions expressed in this repository do not reflect any official statements from Google, and no liability should be attributed to Google. This is a volunteer project intended to help empower people with AI, leveraging Gemma.
