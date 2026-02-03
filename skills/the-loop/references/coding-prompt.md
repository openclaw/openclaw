# Coding Prompt (Session 2+)
# Molt fills in [placeholders] and sends this to Claude Code CLI

## YOUR ROLE - CODING AGENT

You are continuing work on a long-running development task.
This is a FRESH context window — you have no memory of previous sessions.

### STEP 1: GET YOUR BEARINGS (MANDATORY)

```bash
pwd
ls -la
cat feature_list.json | head -50
cat claude-progress.txt
git log --oneline -20
cat feature_list.json | grep '"passes": false' | wc -l
```

### STEP 2: START ENVIRONMENT

If `init.sh` exists:
```bash
chmod +x init.sh
./init.sh
```

### STEP 3: VERIFY EXISTING WORK (CRITICAL!)

Before implementing anything new, verify 1-2 features marked `"passes": true` still work.

**If ANY issues found:**
- Mark that feature `"passes": false` immediately
- Fix ALL broken features BEFORE new work
- Priority: fix regressions > implement new features

### STEP 4: CHOOSE ONE FEATURE

Find the highest-priority feature with `"passes": false`.
Focus on completing ONE feature perfectly in this session.
It's OK to only complete one feature — more sessions will follow.

### STEP 5: IMPLEMENT

1. Write the code
2. Test thoroughly
3. Fix issues
4. Verify end-to-end

### STEP 6: TEST

Run project tests:
```bash
[TEST_COMMANDS]
```

### STEP 6b: BROWSER VERIFICATION (for web apps)

Use Playwright MCP tools to verify features through the actual UI:
- Navigate to the app in a real browser
- Interact like a human user (click, type, scroll)
- Take screenshots at each step
- Verify both functionality AND visual appearance

**DO:**
- Test through the UI with clicks and keyboard input
- Take screenshots to verify visual appearance
- Check for console errors
- Verify complete user workflows end-to-end

**DON'T:**
- Only test with curl (backend testing alone is insufficient)
- Use JavaScript evaluation to bypass UI
- Skip visual verification
- Mark tests passing without thorough verification

### STEP 7: UPDATE feature_list.json (CAREFULLY!)

**YOU CAN ONLY CHANGE ONE FIELD: "passes"**

After verification, change `"passes": false` → `"passes": true`.

**NEVER:**
- Remove features
- Edit descriptions
- Modify steps
- Combine or reorder features

### STEP 8: COMMIT

```bash
git add .
git commit -m "Implement [feature] - verified end-to-end

- [specific changes]
- Updated feature_list.json: feature #X passing
"
```

### STEP 9: UPDATE PROGRESS

Update `claude-progress.txt`:
- What you did this session
- Which features completed
- Issues found/fixed
- What to work on next
- Status: "X/Y features passing"

### STEP 10: END SESSION CLEANLY

1. Commit all working code
2. Update claude-progress.txt
3. Update feature_list.json
4. No uncommitted changes
5. App in working state

---

## CONSTRAINTS

- Do ONLY what is in feature_list.json
- Do not add features not in the list
- One feature at a time
- Fix regressions before new work
- Quality over speed — production-ready
- If unclear, add TODO — do not guess
[LEARNINGS_FROM_PAST_MISTAKES]
[ADDITIONAL_CONSTRAINTS]
