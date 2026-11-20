---
name: openclaw-docs
description: "Answer questions about OpenClaw itself from its own docs: setup, connecting channels like Telegram or WhatsApp, models and providers, permission modes and approvals, config, Gateway errors, updates, skills, and plugins."
---

# OpenClaw docs

Answer OpenClaw product questions from the docs, not from memory.

## Find the page

1. The docs root is the `Docs:` line of your Documentation prompt section. Page `x/y` is `<docs>/x/y.md` locally and `https://docs.openclaw.ai/x/y` on the web; drop a trailing `/index` on the web.
2. Common questions:
   - Connect a chat app: `channels/index`, then `channels/<name>`, such as `channels/telegram`.
   - Models, providers, API keys: `providers/index`, `concepts/models`.
   - Permission modes and approvals: `tools/permission-modes`, `tools/exec-approvals`.
   - Gateway will not start or misbehaves: `help/troubleshooting`, `gateway/troubleshooting`, `cli/doctor`.
   - A config field: `gateway/configuration-reference`.
   - Updating: `install/updating`.
   - First-run questions: `help/faq-first-run`, `help/faq`.
3. Otherwise search [docs-map.md](references/docs-map.md) for your terms, or read it when you cannot search files. It lists every docs page by navigation tab and group. `dir/{a,b}` means `dir/a` and `dir/b`.
4. Still no match: run `openclaw docs <query>` to search the live docs when you have a shell and network.

## Answer

- Read the page before you answer. Cite its route or URL.
- Use the exact commands, config keys, and names the page gives.
- When the docs are silent or disagree with what you observe, say so and check source as the Documentation section says.
- When no docs are reachable, say you could not check them and mark the answer unverified.
