# Example Delegation Policy

Adopt or adapt this policy to govern how your agent delegates tasks to Claude Code and Codex sub-processes.

## When to Delegate

Delegate when the task involves:
- Writing or modifying code (Python, TypeScript, shell scripts, etc.)
- Generating files (documents, spreadsheets, presentations)
- Complex multi-step coding workflows (build, test, commit)
- Refactoring or code review

Do NOT delegate:
- Trivial one-liners (a single sed/awk/jq command)
- JSON/YAML config edits
- Tasks that only need MCP tools (email, calendar, search)

## Pre-Delegation Checklist

Before spawning a sub-process, complete these steps:

1. **Identify context** — what project, codebase, or domain does this relate to?
2. **Gather facts** — collect all data the sub-process will need (it has no conversation history or MCP access, only filesystem access in the working directory)
3. **Compose a self-contained prompt** — include context, facts, requirements, and output format
4. **Apply anti-hallucination rules** — list verified facts and instruct the sub-process to use only those

## Prompt Template

```markdown
# Task: [description]

## Context
[Background the sub-process needs to understand the task]

## Verified Facts (use ONLY these)
- [Fact 1]
- [Fact 2]
- [Fact N]

## Anti-Hallucination Rule
Do not invent facts, numbers, names, or data not listed above.
If information is missing, use [TBD] as placeholder.

## Requirements
[Deliverable specifications — structure, format, audience, constraints]

## Output
[File format, naming convention, save location]
```

## Agent Selection Policy

- **Default to Claude Code** for all coding and generation tasks
- **Use Codex only when the user explicitly requests it**
- Never auto-select Codex based on task type

## Security Policy

- Always strip AI provider API keys from the sub-process environment
- The delegation scripts strip 23 known provider keys (see `SKILL.md` for the full list). The list is not exhaustive — add any additional keys your environment uses
- This forces subscription/OAuth auth and prevents key leakage
- For manual invocations, use `env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY ...` at minimum

## Result Handling

1. Always poll for completion — never end your turn after launching a background task
2. Verify the output file exists
3. Summarize results (do not dump raw logs)
4. If the sub-process failed, read the log and either retry with fixes or report the failure

## Session Resumption

When the user requests changes to a previous delegation:
- Resume the existing session with `--continue` or `--resume <session-id>`
- No need to re-compose the full context
- State only the amendments needed
