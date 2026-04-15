# Keeper documentation entry points

Use official Keeper docs to verify syntax and operating expectations.

Primary docs mentioned by Keeper Agent Kit:

- Docs home: https://docs.keeper.io
- KSM overview: https://docs.keeper.io/en/keeperpam/secrets-manager/overview
- Commander CLI commands reference: https://docs.keeper.io/en/keeperpam/commander-cli/command-reference
- Keeper notation: https://docs.keeper.io/en/keeperpam/secrets-manager/about/keeper-notation

## Operating rules

- Do not guess install commands.
- Do not guess subcommand names if `--help` can confirm them.
- Treat Keeper notation and injection mechanisms as preferable to copying secrets into files.
- For interactive auth, use tmux so the session survives across shell tool calls.
- Prefer the installed CLI help output when version-specific behavior matters.
