# OpenClaw Upgraded Architecture

## Overview

The OpenClaw stack supports automation, tool use, and cloud integration, while enforcing isolated execution when necessary. 

### Services:

- **openclaw-gateway**: This service handles external API requests, core session logic, and routes communication internally. Needs to be highly available.
- **openclaw-cli**: Runs agent-like loops, handling execution steps and interactions without binding to ports, sharing the gateway network mode. Allows running commands directly against the gateway logic.
- **browser-worker**: Based on the Microsoft Playwright Jammy image, this service handles actual web-based tasks (Overleaf, Colab, scraping, or screenshots). 

### Directories & Mounts:

- **workspace/**: The active project or directory being managed.
- **scripts/**: Shell wrappers that abstract repeatable tasks (e.g. workspace backups, log reading, deployment). These run natively inside containers for automation safety.
- **artifacts/**: Output folder for screenshots, log archives, downloaded datasets, generated videos or PDFs.
- **logs/**: Captured application logs for debugging and record-keeping without needing `docker log` constantly. Mounted explicitly.

### Network and Security:

- Only the Gateway binds external ports.
- `browser-worker` runs with Seccomp unconfined to enable full browser sandbox operation but acts within its isolated container runtime, restricted to mounted directories.
- Credentials (`VERCEL_TOKEN`, `GITHUB_TOKEN`, API keys) are passed via environment explicitly and not persisted in source control.

### Extensibility

You can continue adding specific workers (model evaluator containers, LLM hosts, DB nodes) to this `docker-compose.yml` file, giving them constrained access to `artifacts/`, `logs/`, and `workspace/` mapped directories.
