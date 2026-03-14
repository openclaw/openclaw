# 🦞 CiwardClaw

<p align="center">
  <strong>A community-maintained, feature-enhanced fork of OpenClaw.</strong>
</p>

## 🌟 Why CiwardClaw?

This repository is an independently maintained fork of [OpenClaw](https://github.com/openclaw/openclaw), created to address upstream maintenance delays and introduce critical stability, compatibility, and usability improvements.

### Key Features & Improvements (from newest to oldest)

- ♊ **Gemini CLI Integration**: Switched to the Gemini CLI request format to effectively avoid short-term API rate limits.
- 🔄 **Codex Multi-Account Rotation**: Added robust support for configuring multiple Codex accounts with seamless rotation and automatic fallback.
- ⚡ **Steer Mode Injection**: Introduced Steer Mode across channels, allowing you to directly inject messages and steer active agent runs without waiting in the queue.
- 🛡️ **Gateway Restart Recovery**: Painless service restarts with inflight agent run resumption—never lose a session's context again.
- 🌐 **Robust Browser Automation**: Enhanced target lookup recovery and strict route timeout budget alignment to eliminate misleading browser failures.

## 📖 Documentation & Upstream

Since CiwardClaw is built on top of OpenClaw, the core installation and usage remain the same. For installation instructions, official documentation, and general OpenClaw features, please refer to the upstream repository:

👉 **[OpenClaw Official README](https://github.com/openclaw/openclaw/blob/main/README.md)**  
👉 **[OpenClaw Official Documentation](https://docs.openclaw.ai)**

[🌐 中文版说明 (README_zh.md)](README_zh.md)

## 🤝 Contributors

- **[@Ciward](https://github.com/Ciward)** - Maintainer and core developer of the CiwardClaw fork.
