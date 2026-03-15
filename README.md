# 🦅 OpenClaw Blackwell Core (2026)

> **Sentinel Edition: High-Performance Autonomous Agentic Framework**

OpenClaw has been evolved into the **Blackwell Core**, a streamlined, high-performance engine optimized for the **NVIDIA Blackwell 2026** architecture (RTX 5060 Ti, 16GB VRAM). This repository now serves as the "source of truth" for core framework logic, strictly separated from specialized trading implementations (DMarket Bot).

## 🚀 Blackwell Core Features

- **vLLM Inference Backend:** All LLM inference served via vLLM (WSL2) with OpenAI-compatible HTTP API (`/v1/chat/completions`). AWQ quantization (`awq_marlin`) for optimal throughput on 16GB VRAM.
- **Sequential Load Management (SLM):** Zero-OOM guarantee for 16GB VRAM using dynamic model loading orchestration.
- **Per-Role Temperature Control:** Fine-grained temperature settings (0.0–0.5) per brigade role for deterministic vs creative outputs.
- **Background Health Monitor:** Automatic vLLM health checks (30s interval) with auto-restart on failure.
- **Sentinel Agent Workforce:** Specialized roles for high-stakes operations:
  - **SRE (Gromov):** System reliability and performance optimization.
  - **OSINT (Veremeev):** External data ingestion and threat analysis.
  - **TradeOps (Klimov):** High-frequency execution and risk management integration.
- **Rust-Optimized Infrastructure:** Critical paths (checksums, data parsing) offloaded to native `rust_core` extensions.
- **HMM Regime Engine:** Advanced Markov models for predictive market and system state transitions.

## 🛠 Project Separation

Following the **2026 Sentinel Update**, the ecosystem is split into two distinct entities:

1.  **OpenClaw Core (`D:\openclaw_bot\openclaw_bot`):** The engine, the logic, and the agentic framework.
2.  **DMarket Bot (`D:\Dmarket_bot`):** Pure trading strategies, HFT logic, and DMarket integration.

## 📦 Installation & Launch

```bash
# Ensure Node 22+ and Python 3.11+ are installed
pnpm install
pip install -r requirements.txt

# Launch the Blackwell Core
openclaw daemon run
```

## 📜 Documentation

- [VISION.md](/VISION.md) - The 2026 Roadmap.
- [IDENTITY.md](/IDENTITY.md) - Core system personality and directives.
- [AGENTS.md](/AGENTS.md) - Specialized Sentinel role documentation.

---
*Developed by the OpenClaw Foundation. Optimized for the 2026 Blackwell Edge.*
