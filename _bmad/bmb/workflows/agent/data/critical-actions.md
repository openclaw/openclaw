# critical_actions

Numbered steps executing FIRST on agent activation.

---

## Quick Reference

| hasSidecar | critical_actions                                                  |
| ---------- | ----------------------------------------------------------------- |
| `true`     | **MANDATORY** - load memories, instructions, restrict file access |
| `false`    | OPTIONAL - only if activation behavior needed                     |

---

## Patterns

### hasSidecar: true (MANDATORY)

```yaml
critical_actions:
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/memories.md"
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/instructions.md"
  - "ONLY read/write files in {project-root}/_bmad/_memory/{sidecar-folder}/"
```

### hasSidecar: false (OPTIONAL)

```yaml
critical_actions:
  - "Show inspirational quote before menu"
  - "Fetch latest stock prices before displaying menu"
  - "Review {project-root}/finances/ for most recent data"
```

### hasSidecar: true + extras

```yaml
critical_actions:
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/memories.md"
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/instructions.md"
  - "ONLY read/write files in {project-root}/_bmad/_memory/{sidecar-folder}/"
  - "Search web for biotech headlines, display before menu"
```

---

## Path Patterns

| Use            | Pattern                                                 |
| -------------- | ------------------------------------------------------- |
| Sidecar memory | `{project-root}/_bmad/_memory/{sidecar-folder}/file.md` |
| Project data   | `{project-root}/path/to/file.csv`                       |
| Output         | `{output_folder}/results/`                              |

**Key:** `{project-root}` = literal text in YAML, resolved at runtime

---

## Dos & Don'ts

| ✅ DO                             | ❌ DON'T                                               |
| --------------------------------- | ------------------------------------------------------ |
| Use `Load COMPLETE file`          | Use `Load file` or `Load ./path/file.md`               |
| Restrict file access for sidecars | Duplicate compiler functions (persona, menu, greeting) |
| Use for activation-time behavior  | Put philosophical guidance (use `principles`)          |

---

## Compiler Auto-Adds (Don't Duplicate)

- Load persona
- Load configuration
- Menu system initialization
- Greeting/handshake
