# OpenClaw Codex

Official OpenClaw plugin for OpenAI Codex app-server integration. It exposes the Codex-managed GPT model catalog, the Codex runtime surfaces used by OpenClaw agents, and opt-in supervision of native Codex sessions.

Install from OpenClaw:

```bash
openclaw plugins install @openclaw/codex
```

Use this plugin when you want OpenClaw to run Codex-backed model turns, media understanding, and prompt overlays through the Codex app-server harness, or to list non-archived native Codex sessions and branch from eligible local sessions in OpenClaw Chat.

For a supervised branch, Codex App Server selects the snapshot fork's model and provider from its current native configuration. OpenClaw locks the canonical harness thread to the returned pair instead of choosing an arbitrary model or fallback; that pair can differ from the source's last recorded model.

See the [Codex harness](https://docs.openclaw.ai/plugins/codex-harness) and [Codex supervision](https://docs.openclaw.ai/plugins/codex-supervision) guides.
