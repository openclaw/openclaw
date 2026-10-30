# OpenClaw Personal Setup Guide

This guide describes how to finalize the personal customization of OpenClaw for Tk at lordlobrau@gmail.com.

## Files Created/Modified
- `personal/config/openclaw.example.json5`: The main config target for `~/.openclaw/openclaw.json` setup for MLX local provider and ClawShield sandbox protections.
- `personal/scripts/memory-compress.sh`: Brotli compression script for episodic memory.
- `personal/scripts/setup.sh`: Script to copy artifacts into `~/.openclaw/`.
- `personal/MEMORY-NOTES.md`: Architecture notes on the tiered memory system.
- `personal/SECURITY.md`: Security config and rejected proxy alternatives.
- `personal/SELF-MODIFICATION.md`: Guidance on Skill Workshop and tools.
- `personal/ROADMAP.md`: Predictive extensions strategy.
- `personal/GAPS.md`: Requirements that could not be fulfilled natively.
- `personal/integrations/spotify/README.md`: `spotify_player` guide.
- `personal/integrations/paperclip/README.md` & `AGENT-MAP.md`: Paperclip setup.
- `personal/templates/SOUL.md`: Identity instructions.
- `personal/templates/USER.md`: User details.
- `personal/AGENTS.personal.md`: Coding style instructions.
- `personal/commands.md`: Cheat sheet.
- `personal/prompts/*`: Task templates.
- `.gitignore`: Updated to ignore secrets and compression artifacts.

## Prompt Claims That Turned Out To Be Wrong
1. **Existing OpenClaw Install**: The prompt claimed a pre-existing environment setup (`~/.openclaw/workspace/` and `~/.openclaw/openclaw.json`), but the sandbox environment was entirely fresh and missing these directories.
2. **45 Agent Docx Files**: The prompt requested importing 45 agent `.docx` files from a known path, but they were completely absent from the environment.
3. **MLX and Paperclip Server**: The prompt assumed the MLX server (`http://127.0.0.1:8080/v1`), Paperclip instance (`3100`), and ClawShield instance were already accessible. The environment audit revealed none were running or installed.
4. **iogpu.wired_limit_mb**: The prompt assumed this was an M5 MacBook, but the runtime environment was a generic Linux devbox (`x86_64`) without Mac-specific `sysctl` capabilities.

## Setup Instructions

1. **Install Dependencies**
   Make sure you have `pnpm` (version 9.15+) and `Node.js` (version 24.16+ or 26.1+).
   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   pnpm ui:build
   ```

2. **Run Initialization Script**
   Run the setup script which will copy files to their proper places without persisting secrets to the repo:
   ```bash
   ./personal/scripts/setup.sh
   ```

3. **Fill Placeholders**
   Open `~/.openclaw/workspace/SOUL.md` and `~/.openclaw/workspace/USER.md` in your text editor and fill out the remaining placeholders.

4. **ClawShield Security**
   ```bash
   git clone https://github.com/SleuthCo/clawshield-public.git
   cd clawshield-public
   cp standalone/.env.template standalone/.env
   # Edit .env with OPENAI_BASE_URL=http://127.0.0.1:8080/v1 and OPENAI_API_KEY=mlx-local
   docker compose up -d
   ```

5. **Security Audit**
   Verify setup with:
   ```bash
   openclaw security audit --deep
   ```
