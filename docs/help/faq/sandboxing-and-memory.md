---
summary: "Sandbox modes, host folder binds, and how agent memory persists"
title: "Sandboxing and memory"
read_when:
  - You are enabling or loosening the sandbox
  - Memory is not persisting the way you expect
---

## Sandboxing and memory

<AccordionGroup>
  <Accordion title="Is there a dedicated sandboxing doc?">
    Yes: [Sandboxing](/gateway/sandboxing). For Docker-specific setup (full gateway in Docker or sandbox images), see [Docker](/install/docker).
  </Accordion>

  <Accordion title="Docker feels limited - how do I enable full features?">
    The default image is security-first and runs as the `node` user, so it excludes system packages, Homebrew, and bundled browsers. For a fuller setup:

    - Persist `/home/node` with `OPENCLAW_HOME_VOLUME` so caches survive.
    - Bake system deps into the image with `OPENCLAW_IMAGE_APT_PACKAGES`.
    - Bake Playwright Chromium and its system dependencies into the image with `OPENCLAW_INSTALL_BROWSER=1`.

    Docs: [Docker](/install/docker), [Browser](/tools/browser).

  </Accordion>

  <Accordion title="Can I keep DMs personal but make groups public/sandboxed with one agent?">
    Yes, if private traffic is **DMs** and public traffic is **groups**. Set `agents.defaults.sandbox.mode: "non-main"` so group/channel sessions (non-main keys) run in the configured sandbox backend while the main DM session stays on-host. Select `backend: "docker"` for Docker or `backend: "podman"` for Podman. Restrict tools available in sandboxed sessions via `tools.sandbox.tools`.

    Setup walkthrough: [Groups: personal DMs + public groups](/channels/groups#pattern-personal-dms-public-groups-single-agent). Key reference: [Gateway configuration](/gateway/config-agents/sandbox#agentsdefaultssandbox).

  </Accordion>

  <Accordion title="How do I bind a host folder into the sandbox?">
    Set `agents.defaults.sandbox.docker.binds` to `["host:container:mode"]` (for example `"/home/user/src:/src:ro"`). Global and per-agent binds merge; per-agent binds are ignored when `scope: "shared"`. Use `:ro` for anything sensitive; binds bypass the sandbox filesystem walls.

    OpenClaw validates bind sources against both the normalized path and the canonical path resolved through the deepest existing ancestor, so symlink-parent escapes fail closed even when the final path segment does not exist yet.

    See [Sandboxing](/gateway/sandboxing#multiple-folders-for-one-agent) and [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#bind-mounts-security-quick-check).

  </Accordion>

  <Accordion title="How does memory work?">
    OpenClaw memory is Markdown files in the agent workspace: daily notes in `memory/YYYY-MM-DD.md`, curated long-term notes in `MEMORY.md` (main/private sessions only).

    OpenClaw also runs a silent **pre-compaction memory flush** before compaction summarizes the conversation, reminding the model to write durable notes first. It only runs when the workspace is writable (read-only sandboxes skip it); disable with `agents.defaults.compaction.memoryFlush.enabled: false`. See [Memory](/concepts/memory).

  </Accordion>

  <Accordion title="Memory keeps forgetting things. How do I make it stick?">
    Ask the bot to **write the fact to memory**: long-term notes go in `MEMORY.md`, short-term context in `memory/YYYY-MM-DD.md`. Reminding the model to store memories usually resolves it. If it keeps forgetting, verify the Gateway uses the same workspace on every run.

    Docs: [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace).

  </Accordion>

  <Accordion title="Does memory persist forever? What are the limits?">
    Memory files live on disk and persist until deleted; the limit is your storage, not the model. **Session context** is still limited by the model context window, so long conversations can compact or truncate - that is why memory search exists, pulling only the relevant parts back into context.

    Docs: [Memory](/concepts/memory), [Context](/concepts/context).

  </Accordion>

  <Accordion title="Does semantic memory search require an OpenAI API key?">
    Only if you use **OpenAI embeddings**, which is the default provider. Codex OAuth covers chat/completions and does **not** grant embeddings access, so signing in with Codex (OAuth or the Codex CLI login) does not enable semantic memory search. OpenAI embeddings still need a real API key (`OPENAI_API_KEY` or `models.providers.openai.apiKey`).

    To stay local, set `memory.search.provider: "local"` (GGUF/llama.cpp). Other supported providers: Bedrock, DeepInfra, Gemini (`GEMINI_API_KEY` or `memory.search.remote.apiKey`), GitHub Copilot, LM Studio, Mistral, Ollama, OpenAI-compatible, and Voyage. See [Memory](/concepts/memory) and [Memory search](/concepts/memory-search) for setup details.

  </Accordion>
</AccordionGroup>
