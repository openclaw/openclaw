# Workflow: Add a Script to a Skill

<required_reading>
**Read these reference files NOW:**
1. references/using-scripts.md
</required_reading>

<process>
## Step 1: Identify the Skill

Ask (if not already provided):
- Which skill needs a script?
- What operation should the script perform?

## Step 2: Analyze Script Need

Confirm this is a good script candidate:
- [ ] Same code runs across multiple invocations
- [ ] Operation is error-prone when rewritten
- [ ] Consistency matters more than flexibility

If not a good fit, suggest alternatives (inline code in workflow, reference examples).

## Step 3: Create Scripts Directory

```bash
mkdir -p ~/.openclaw/skills/{skill-name}/scripts
```

## Step 4: Design Script

Gather requirements:
- What inputs does the script need?
- What should it output or accomplish?
- What errors might occur?
- Should it be idempotent?

Choose language:
- **bash** - Shell operations, file manipulation, CLI tools
- **python** - Data processing, API calls, complex logic
- **node/ts** - JavaScript ecosystem, async operations

## Step 5: Write Script File

Create `scripts/{script-name}.{ext}` with:
- Purpose comment at top
- Usage instructions
- Input validation
- Error handling
- Clear output/feedback

For bash scripts:
```bash
#!/bin/bash
set -euo pipefail
```

## Step 6: Make Executable (if bash)

```bash
chmod +x ~/.openclaw/skills/{skill-name}/scripts/{script-name}.sh
```

## Step 7: Update Workflow to Use Script

Find the workflow that needs this operation. Add:
```xml
<process>
...
N. Run `scripts/{script-name}.sh [arguments]`
N+1. Verify operation succeeded
...
</process>
```

## Step 8: Test

Invoke the skill workflow and verify:
- Script runs at the right step
- Inputs are passed correctly
- Errors are handled gracefully
- Output matches expectations
</process>

<success_criteria>
Script is complete when:
- [ ] scripts/ directory exists
- [ ] Script file has proper structure (comments, validation, error handling)
- [ ] Script is executable (if bash)
- [ ] At least one workflow references the script
- [ ] No hardcoded secrets or credentials
- [ ] Tested with real invocation
</success_criteria>
