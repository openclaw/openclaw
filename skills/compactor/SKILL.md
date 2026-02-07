# Compactor Skill (Native)

Use the agent's own reasoning capabilities to compress conversation transcripts into high-density Markdown summaries.

## How to Use

When the user asks to "compact" or "summarize" a session log, you can:

1.  **Direct Instruction:** Read the target file and follow the rules below.
2.  **Command Shim:** Run `openclaw compact <file>` to trigger the reasoning process explicitly.

## Compression Rules (Strict)

**KEEP:**

- **User Decisions**: Explicit choices, approvals, or rejections made by the user.
- **Key Information**: Facts, data, credentials, file paths, specific requirements provided.
- **Final Outcomes**: What was actually built, written, fixed, or solved. The "result" state.
- **Action Items**: Pending tasks or next steps.

**DISCARD:**

- **Chit-chat / Pleasantries**: "Hello", "Thank you", "You're welcome".
- **Intermediate Thinking**: Your own `<think>` blocks, internal reasoning logs, or planning steps that didn't result in user-visible changes.
- **Failed Attempts**: Errors that were eventually corrected (unless the failure _is_ the final state or a blocking issue).
- **Repetitive Acknowledgments**: "I will do that", "Understood".

## Output Format

Provide a strictly Markdown formatted summary. Use clear headers or bullet points. Be concise.

```markdown
# Session Summary: <Date/Topic>

## Key Decisions

- User chose option A over B.
- Validated X feature.

## Outcomes

- Created `file.ts`.
- Fixed bug in `logic.js`.

## Pending / Next Steps

- [ ] Deploy to prod.
```
