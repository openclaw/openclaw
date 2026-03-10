# Thought Leadership Research-to-Post Pipeline

Claude Code + OpenClaw Implementation

User: [Author]
Environment: Cursor + Claude Code
Gateway: OpenClaw (Telegram)

Purpose:
Automate discovery, research, drafting, and publishing preparation for Medium and LinkedIn thought leadership posts.

Primary Output Location:

```text
outputs/content/
```

---

# 1. Pipeline Overview

The pipeline converts **raw ideas and news signals** into **publishable content assets**.

Workflow:

```text
Topic discovery
↓
Research aggregation
↓
Thesis generation
↓
Medium article draft
↓
LinkedIn post derivatives
↓
Archive and reuse
```

Three internal subagents execute this pipeline:

```text
researcher
writer
editor
```

---

# 2. Required Directory Setup

```text
.claude/subagents
.claude/commands
memory/brand
data/research
outputs/content
```

Create your brand voice file before running the pipeline:

```bash
cp .claude/templates/writing_style.md.example memory/brand/writing_style.md
# Then edit memory/brand/writing_style.md with your own name, style, and audience
```

> `memory/` is gitignored and never committed. The template lives at `.claude/templates/writing_style.md.example`.

---

# 3. Brand Memory

See: `memory/brand/writing_style.md`

---

# 4. Subagents

See: `.claude/subagents/`

- researcher.md
- writer.md
- editor.md

---

# 5. Commands

See: `.claude/commands/`

- content-scan.md → /content-scan
- build-source-pack.md → /build-source-pack
- draft-medium.md → /draft-medium
- repurpose-linkedin.md → /repurpose-linkedin

Also available as OpenClaw skills (Telegram):
See: `skills/content-scan/`, `skills/build-source-pack/`, `skills/draft-medium/`, `skills/repurpose-linkedin/`

---

# 6. OpenClaw Usage (Telegram)

Trigger from Telegram:

```
content-scan

draft medium on AI pilots failing in enterprises

repurpose article for linkedin
```

---

# 7. Weekly Automation Routine

1. `/content-scan` — generate 5 ideas
2. Select strongest idea
3. `/build-source-pack` — research pack
4. `/draft-medium` — full article
5. `/repurpose-linkedin` — LinkedIn posts

---

# 8. Expected Outputs

```text
outputs/content/
  ideas.md
  source-pack.md
  article.md
  linkedin-posts.md
```

---

# 9. Quality Gate

- [ ] Strong hook
- [ ] Clear thesis
- [ ] Evidence included
- [ ] Actionable takeaway
- [ ] Readable length

---

# 10. Success Metrics

| Metric                   | Target                  |
| ------------------------ | ----------------------- |
| Idea generation          | 5 strong ideas per week |
| Draft creation time      | < 20 minutes            |
| Research time reduction  | 40%                     |
| Posts produced per month | 4–6                     |
