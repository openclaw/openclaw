---
summary: "CLI reference for `openclaw completion` (generate/install shell completion scripts)"
read_when:
  - You want shell completions for zsh/bash/fish/PowerShell
  - You need to install shell completion profile hooks
title: "Completion"
---

# `openclaw completion`

Generate shell completion scripts and optionally install them into your shell profile.

## Usage

```bash
openclaw completion
openclaw completion --shell zsh
openclaw completion --install
openclaw completion --shell fish --install
```

## Options

- `-s, --shell <shell>`: shell target (`zsh`, `bash`, `powershell`, `fish`; default: `zsh`)
- `-i, --install`: install completion by adding a source line to your shell profile
- `-y, --yes`: skip install confirmation prompts

## Notes

- `--install` writes a small "OpenClaw Completion" block into your shell profile that generates completions from the CLI.
- Without `--install`, the command prints the script to stdout.
- Completion generation eagerly loads command trees so nested subcommands are included.
- OpenClaw does not write shell completion cache files under state.

## Related

- [CLI reference](/cli)
