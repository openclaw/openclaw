# Subprocess Optimization Patterns

**Purpose:** Context-saving and performance patterns for subprocess/subagent usage in BMAD workflows.

---

## Golden Rules

1. **Subprocess when operations benefit from parallelization or context isolation**
2. **Return ONLY findings to parent, not full file contents**
3. **Always provide graceful fallback** for LLMs without subprocess capability
4. **Match pattern to operation type** - grep/regex, deep analysis, or data operations

---

## Pattern 1: Single Subprocess for Grep/Regex Across Many Files

**Use when:** One command across many files, only need matches/failures
**Context savings:** Massive (1000:1 ratio)

**Template:**

```markdown
Launch a subprocess that:

1. Runs grep/regex across all target files
2. Extracts only matching lines or failures
3. Returns structured findings to parent
```

**Good:** "Launch subprocess to grep all files for pattern, return only matches"
**Bad:** "For EACH file, load the file and search for pattern"

**Example return:**

```json
{
  "violations": [{ "file": "step-02.md", "line": 45, "match": "..." }],
  "summary": { "total_files_checked": 10, "violations_found": 3 }
}
```

---

## Pattern 2: Separate Subprocess Per File for Deep Analysis

**Use when:** Reading prose, logic, quality, or flow of each file
**Context savings:** High (10:1 ratio)

**Template:**

```markdown
DO NOT BE LAZY - For EACH file, launch a subprocess that:

1. Loads that file
2. Reads and analyzes content deeply
3. Returns structured analysis findings to parent
```

**Good:** "DO NOT BE LAZY - For EACH step file, launch subprocess to analyze instruction style, return findings"
**Bad:** "Load every step file and analyze its instruction style"

**Use cases:** Instruction style validation, collaborative quality assessment, frontmatter compliance, step type validation

---

## Pattern 3: Subprocess for Data File Operations

**Use when:** Loading reference data, fuzzy/best matching, summarizing large datasets
**Context savings:** Massive (100:1 ratio)

**Template:**

```markdown
Launch a subprocess that:

1. Loads the data file (reference docs, CSV, knowledge base)
2. Performs lookup, matching, or summarization
3. Returns ONLY relevant rows or key findings to parent
```

**Good:** "Launch subprocess to load {dataFile}, find applicable rules, return only those"
**Bad:** "Load {dataFile} with 500 rules and find applicable ones"

**Use cases:** Reference rules lookup, CSV fuzzy matching, document summarization, knowledge base search

---

## Pattern 4: Parallel Execution Opportunities

**Use when:** Multiple independent operations could run simultaneously
**Performance gain:** Reduced total execution time

**Template:**

```markdown
Launch subprocesses in parallel that:

1. Each handles one independent operation
2. All run simultaneously
3. Parent aggregates results when complete
```

**Example:** Instead of sequential checks, launch 3 subprocesses in parallel (frontmatter, menu, step types), then aggregate.

---

## Graceful Fallback Pattern (CRITICAL)

**Universal Rule:**

```markdown
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context thread
```

**Implementation:**

```markdown
### Step-Specific Rules:

- 🎯 Use subprocess optimization when available - [pattern description]
- 💬 If subprocess unavailable, perform operations in main thread
```

---

## Return Pattern for Subprocesses

**Subprocesses must either:**

**Option A: Update report directly** - "Subprocess loads validation report, appends findings, saves"

**Option B: Return structured findings to parent** - "Subprocess returns JSON findings to parent for aggregation"

**Good return:** `{"file": "step-02.md", "violations": ["..."], "opportunities": ["..."], "priority": "HIGH"}`
**Bad:** "Subprocess loads file and returns full content to parent"

---

## When to Use Each Pattern

| Pattern                       | Use When                              | Context Savings  |
| ----------------------------- | ------------------------------------- | ---------------- |
| Pattern 1: Grep/regex         | Finding patterns across many files    | Massive (1000:1) |
| Pattern 2: Per-file analysis  | Understanding prose, logic, quality   | High (10:1)      |
| Pattern 3: Data operations    | Reference data, matching, summarizing | Massive (100:1)  |
| Pattern 4: Parallel execution | Independent operations                | Performance gain |

---

## Step File Integration

### Universal Rule (all steps)

```markdown
### Universal Rules:

- ⚙️ TOOL/SUBPROCESS FALLBACK: If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context thread
```

### Step-Specific Rules

```markdown
### Step-Specific Rules:

- 🎯 [which pattern applies]
- 💬 Subprocess must either update report OR return findings to parent
- 🚫 DO NOT BE LAZY - [specific guidance for Pattern 2]
```

### Command Directives

- Pattern 1: "Launch subprocess that runs [command] across all files, returns [results]"
- Pattern 2: "DO NOT BE LAZY - For EACH file, launch subprocess that [analyzes], returns [findings]"
- Pattern 3: "Launch subprocess that loads [data file], performs [operation], returns [results]"

---

## Validation Checklist

- [ ] Universal fallback rule present
- [ ] Step-specific rules mention which pattern applies
- [ ] Command sequence uses appropriate subprocess directive
- [ ] "DO NOT BE LAZY" language included for Pattern 2
- [ ] Return pattern specified (update report OR return to parent)
- [ ] Graceful fallback addressed
- [ ] Pattern matches operation type (grep/regex, deep analysis, or data ops)

---

## Anti-Patterns to Avoid

| ❌ Anti-Pattern                               | ✅ Correct Approach                                |
| --------------------------------------------- | -------------------------------------------------- |
| "For EACH file, load the file, analyze it"    | "Launch subprocess per file that returns analysis" |
| "Subprocess loads file and returns content"   | "Subprocess returns structured findings only"      |
| "Use subprocess to [operation]" (no fallback) | Include fallback rule for non-subprocess LLMs      |
| "Launch subprocess per file to grep"          | Use Pattern 1 (single subprocess for grep)         |
| "Launch subprocess to analyze files"          | Specify what subprocess returns                    |

---

## See Also

- `step-file-rules.md` - When to extract content to data files
- `step-08b-subprocess-optimization.md` - Validation step for optimization opportunities
- `../steps-v/step-02b-path-violations.md` - Example of Pattern 1
- `../steps-v/step-08b-subprocess-optimization.md` - Example of Pattern 2
