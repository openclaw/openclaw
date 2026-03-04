---
name: sysinfo
description: Quick system information and resource monitoring. Use when the user asks about CPU usage, memory, disk space, uptime, running processes, network info, or system health. Lightweight alternative to full monitoring stacks. NOT for: historical metrics, alerting setup, or detailed performance profiling.
metadata:
  { "openclaw": { "emoji": "🖥️" } }
---

# System Info

Quickly check system resources and health using standard Unix tools.

## Usage

Run the bundled script for a full overview:

```bash
bash SKILL_DIR/scripts/sysinfo.sh [SECTION]
```

### Sections

| Section | Description |
|---------|-------------|
| `all` | Full system overview (default) |
| `cpu` | CPU info and load averages |
| `memory` | RAM and swap usage |
| `disk` | Disk usage by mount point |
| `network` | Network interfaces and connections |
| `processes` | Top processes by CPU/memory |
| `uptime` | Uptime and boot time |
| `docker` | Docker container status (if docker is available) |

### Examples

```bash
# Full overview
bash SKILL_DIR/scripts/sysinfo.sh

# Just memory info
bash SKILL_DIR/scripts/sysinfo.sh memory

# Check disk space
bash SKILL_DIR/scripts/sysinfo.sh disk
```

## Output

Present results cleanly:
- Use progress bars for percentages: `[████████░░] 80%`
- Highlight warnings when usage > 80%
- Keep output concise for chat delivery
