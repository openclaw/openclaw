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

Until Gemmaclaw ships its own tooling, the recommended path is:

1. Follow the upstream [OpenClaw getting started guide](https://docs.openclaw.ai/start/getting-started).
2. Check this repo for Gemma-specific notes, configs, and examples as they land.

## Contributing

Issues and pull requests are welcome. Keep contributions small, reproducible, and backed by data where possible. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Links

- [Upstream OpenClaw](https://github.com/openclaw/openclaw)
- [OpenClaw docs](https://docs.openclaw.ai)
- [gemma.cpp](https://github.com/google/gemma.cpp)

## Disclaimer

This project is composed of volunteers, including both Google engineers and members of the open source community. At this time, Gemmaclaw is not an official Google repository. The actions and opinions expressed in this repository do not reflect any official statements from Google, and no liability should be attributed to Google. This is a volunteer project intended to help empower people with AI, leveraging Gemma.
