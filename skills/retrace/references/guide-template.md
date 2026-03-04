# How-To Guide Template

Use this structure when generating a how-to guide from a retraced session.

---

```markdown
# How to <accomplish goal>

<1-2 sentence summary of what this guide covers and the end result.>

## Prerequisites

- <Tool/binary required> (install: `<install command>`)
- <Access/credentials needed>
- <Prior knowledge assumed>

## Steps

### 1. <Action verb> <what>

<Brief explanation of why this step is needed.>

```bash
<command or code>
```

**Expected outcome:** <what you should see/have after this step>

### 2. <Action verb> <what>

...

### N. Verify the result

<Final verification step — how to confirm the task succeeded.>

```bash
<verification command>
```

## Helper Scripts

If any multi-step commands were extracted into standalone scripts, list them here:

| Script | Purpose |
|--------|---------|
| `scripts/<name>.sh` | <what it does> |

## Troubleshooting

### <Error or issue encountered>

**Symptom:** <what went wrong>
**Cause:** <why it happened>
**Fix:** <how it was resolved>

## Notes

- <Any caveats, alternatives, or tips discovered during the task>
```

---

## Guidelines for filling in the template

1. Replace all `<placeholders>` with session-specific content, then generalize paths/names to `<placeholder>` style for reuse.
2. Each step should be independently verifiable — a reader should be able to check their progress.
3. Commands should be copy-pasteable. Use full paths or explain how to determine the right path.
4. If a step involves editing a file, show the specific change (diff or before/after) rather than saying "edit the file."
5. Extract any command longer than 3 lines into `scripts/` and reference it from the step.
6. The troubleshooting section should only include issues actually encountered during the session, not hypothetical ones.
