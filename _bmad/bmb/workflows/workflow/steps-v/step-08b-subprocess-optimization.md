---
name: "step-08b-subprocess-optimization"
description: "Identify subprocess optimization opportunities - reduce context load, improve performance"

nextStepFile: "./step-09-cohesive-review.md"
targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
subprocessPatterns: "../data/subprocess-optimization-patterns.md"
---

# Validation Step 8b: Subprocess Optimization Analysis

## STEP GOAL:

To identify opportunities for subprocess optimization throughout the workflow - reducing context load, improving performance, and enabling massive operations that would otherwise exceed context limits.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - ANALYZE EVERY FILE IN ITS OWN SUBPROCESS
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step, ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction references a subprocess/subagent/tool you do not have access to, you MUST still achieve the outcome in your main context

### Step-Specific Rules:

- 🎯 Analyze EVERY step file for subprocess optimization - each file in its own subprocess
- 🚫 DO NOT skip any file - DO NOT BE LAZY
- 💬 Load {subprocessPatterns} in subprocess performing some action required to understand patterns deeply with examples (if subprocess available), else load in main context
- 🚪 This identifies context-saving and performance-optimizing opportunities

## EXECUTION PROTOCOLS:

- 🎯 Analyze each step file in its own subprocess - deep analysis of subprocess potential
- 💾 Subprocesses must identify optimization patterns and return findings to parent for aggregation
- 📖 Aggregate findings into validation report before loading next step

## CONTEXT BOUNDARIES:

- Three patterns: grep/regex across files, per-file deep analysis, data file operations, parallel execution
- **Context-saving goal**: Return ONLY key findings to parent, not full file contents

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Load Subprocess Pattern Reference (Context Optimization!)

**First, understand the subprocess optimization patterns by loading {subprocessPatterns}:**

**If subprocess capability available:**

```markdown
Launch a subprocess that:

1. Loads {subprocessPatterns}
2. Studies all patterns and examples deeply (Pattern 3: data operations!)
3. Returns summary of key patterns to parent (not full file - saves context)
```

**If subprocess unavailable:**

```markdown
Load {subprocessPatterns} in main context

# Larger context but still functional - demonstrates graceful fallback
```

**This step itself demonstrates Pattern 3 from the reference!**

---

### 2. Perform Subprocess Optimization Analysis

**DO NOT BE LAZY - For EVERY step file, launch a subprocess that:**

1. Loads that step file
2. ALSO loads {subprocessPatterns} to understand all patterns deeply (subprocess needs full context!)
3. Analyzes the step against each pattern looking for optimization opportunities
4. Returns specific, actionable suggestions to parent

**Subprocess gets full context:**

- The step file being analyzed
- The subprocess-optimization-patterns.md reference (all examples and patterns)
- Returns only findings to parent (context savings!)

**SUBPROCESS ANALYSIS PATTERN - Check each step file for:**

**Pattern 1: Single subprocess for grep/regex** - Operations that check/search multiple files for patterns (frontmatter validation, menu checks, path searches). Suggest: "Use single grep subprocess, return only matches"

**Pattern 2: Separate subprocess per file** - Operations requiring deep analysis of prose/logic/quality/style/flow per file (instruction review, collaborative quality assessment, step type compliance). Suggest: "Each file in own subprocess, return analysis findings"

**Pattern 3: Subprocess for data operations** - Operations loading large data files to find matches, extract key details, or summarize findings. Suggest: "Subprocess loads data, returns ONLY relevant rows/findings"

**Pattern 4: Parallel execution** - Independent operations that could run simultaneously. Suggest: "Run in parallel subprocesses to reduce execution time"

**RETURN FORMAT (example structure, adapt as needed):**

```json
{
  "step_file": "step-02-*.md",
  "opportunities": [
    {
      "pattern": "grep/regex|per-file|data-ops|parallel",
      "location": "Line XX: [quote relevant instruction]",
      "issue": "Loads all files into parent context",
      "suggestion": "Use single grep subprocess, return only failures",
      "impact": "Saves ~N lines per file, faster execution",
      "priority": "HIGH|MEDIUM|LOW"
    }
  ]
}
```

### 2. Aggregate Findings and Create Report Section

After ALL files analyzed, create/update section in {validationReportFile}:

```markdown
## Subprocess Optimization Opportunities

**Total Opportunities:** {count} | **High Priority:** {count} | **Estimated Context Savings:** {description}

### High-Priority Opportunities

**{Step Name}** - {Pattern Type}

- **Current:** {brief description of current approach}
- **Suggested:** {specific optimization suggestion}
- **Impact:** {context savings, performance gain}
- **Example:** `{brief code/pseudocode}`

[Repeat for each high-priority opportunity...]

### Moderate/Low-Priority Opportunities

{List with brief descriptions}

### Summary by Pattern

- **Pattern 1 (grep/regex):** {count} opportunities - {total savings}
- **Pattern 2 (per-file):** {count} opportunities - {total savings}
- **Pattern 3 (data ops):** {count} opportunities - {total savings}
- **Pattern 4 (parallel):** {count} opportunities - {performance gain}

### Implementation Recommendations

**Quick Wins:** {easy implementations with big savings}
**Strategic:** {higher effort but big payoff}
**Future:** {moderate impact, consider later}

**Status:** ✅ Complete / ⚠️ Review recommended
```

### 3. Save Report and Auto-Proceed

**CRITICAL:** Save report BEFORE loading next step.

Then load, read entire file, execute {nextStepFile}.

**Display:** "**Subprocess optimization analysis complete.** Identified {count} opportunities with potential context savings. Proceeding to Cohesive Review..."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- EVERY step file analyzed in its own subprocess
- ALL optimization opportunities identified
- Findings aggregated into report
- Prioritized recommendations with context savings
- Report saved, next step loaded

### ❌ SYSTEM FAILURE:

- Not analyzing every file
- Skipping opportunity identification
- Not providing specific suggestions
- Not estimating savings
- Not aggregating findings

**Master Rule:** DO NOT BE LAZY. Analyze EVERY file in its own subprocess. Identify ALL optimization opportunities across 4 patterns. Provide specific, actionable recommendations with context savings. Return findings to parent. Auto-proceed.
