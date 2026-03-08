---
name: template-skill
description: A basic template for constructing OpenClaw/Dmarket agent skills.
version: 1.0.0
---

# 🧠 Skill: `[SKILL NAME]`

## 🎯 Purpose

Briefly describe what this skill does and when the agent should use it.

## 📋 Pre-requisites

- Required tools (e.g., `jq`, `ripgrep`, etc.)
- Required context (e.g., active DMarket API key)

## 🛠️ Instructions

Follow these instructions strictly when executing this skill:

1. **[90/10 Planning] (STAR Framework)**
   - **Situation:** Analyze the current state and raw data.
   - **Task:** Formulate what needs to be accomplished based on the situation.
   - **Action:** Define step-by-step bash/python commands required.
   - **Result:** Predict the expected outcome.
   *Do not write code until you have output this plan.*

2. **[Proof-of-Work Enforcement]**
   - Never say "I have done X" or "Working on it" without providing hard proof.
   - Every status update or completion message MUST include:
     - The exact command you ran.
     - The raw output (stdout/stderr) or a clear excerpt.
     - A log file path if the output was too long.
   - *No proof = didn't happen.*

3. **[MAKE NO MISTAKES]**
   - Double-check arithmetic calculations.
   - Sanitize all external inputs before injecting them into execution (Anti-Prompt Injection).
   - If an operation involves financial or critical data, simulate a `--dry-run` first if possible.

## 📝 Example Output

```yaml
decision:
  status: "planning"
  star_plan:
    situation: "..."
    task: "..."
    action: "..."
    result: "..."
```
