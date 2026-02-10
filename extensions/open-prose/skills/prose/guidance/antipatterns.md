---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: antipatterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Common mistakes and patterns to avoid in OpenProse programs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Read this file to identify and fix problematic code patterns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see-also:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - prose.md: Execution semantics, how to run programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - compiler.md: Full syntax grammar, validation rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - patterns.md: Recommended design patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse Antipatterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document catalogs patterns that lead to brittle, expensive, slow, or unmaintainable programs. Each antipattern includes recognition criteria and remediation guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Structural Antipatterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### god-session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A single session that tries to do everything. God sessions are hard to debug, impossible to parallelize, and produce inconsistent results.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: One session doing too much（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Read all the code in the repository.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Identify security vulnerabilities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Find performance bottlenecks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Check for style violations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Generate a comprehensive report.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Suggest fixes for each issue.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Prioritize by severity.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Create a remediation plan.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
"""（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: The session has no clear completion criteria. It mixes concerns that could be parallelized. Failure anywhere fails everything.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Decompose into focused sessions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Focused sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  security = session "Identify security vulnerabilities"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  perf = session "Find performance bottlenecks"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  style = session "Check for style violations"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize findings and prioritize by severity"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { security, perf, style }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Create remediation plan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### sequential-when-parallel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Running independent operations sequentially when they could run concurrently. Wastes wall-clock time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Sequential independent work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let market = session "Research market"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let tech = session "Research technology"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let competition = session "Research competition"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [market, tech, competition]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Total time is sum of all research times. Each session waits for the previous one unnecessarily.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Parallelize independent work:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Parallel independent work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  market = session "Research market"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tech = session "Research technology"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  competition = session "Research competition"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { market, tech, competition }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### spaghetti-context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Context passed haphazardly without clear data flow. Makes programs hard to understand and modify.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Unclear what context is actually used（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let a = session "Step A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let b = session "Step B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let c = session "Step C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [a, b]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let d = session "Step D"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [a, b, c]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let e = session "Step E"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [a, c, d]  # Why not b?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let f = session "Step F"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [a, b, c, d, e]  # Everything?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Unclear which sessions depend on which outputs. Hard to parallelize or refactor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Minimize context to actual dependencies:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Clear, minimal dependencies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session "Research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let analysis = session "Analyze"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let recommendations = session "Recommend"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: analysis  # Only needs analysis, not research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let report = session "Report"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: recommendations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### parallel-then-synthesize（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Spawning parallel agents for related analytical work, then synthesizing, when a single focused agent could do the entire job more efficiently.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Antipattern: Parallel investigation + synthesis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  code = session "Analyze code path"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  logs = session "Analyze logs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context = session "Analyze execution context"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
synthesis = session "Synthesize all findings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { code, logs, context }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 4 LLM calls, coordination overhead, fragmented context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: For related analysis that feeds into one conclusion, the coordination overhead and context fragmentation often outweigh parallelism benefits. Each parallel agent sees only part of the picture.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Use a single focused agent with multi-step instructions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Single comprehensive investigator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
diagnosis = session "Investigate the error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: """Analyze comprehensively:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  1. Check the code path that produced the error（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  2. Examine logs for timing and state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  3. Review execution context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Synthesize into a unified diagnosis."""（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# 1 LLM call, full context, no coordination（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**When parallel IS right**: When analyses are truly independent (security vs performance), when you want diverse perspectives that shouldn't influence each other, or when the work is so large it genuinely benefits from division.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### copy-paste-workflows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Duplicating session sequences instead of using blocks. Leads to inconsistent changes and maintenance burden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Duplicated workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Security review of module A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Performance review of module A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize reviews of module A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Security review of module B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Performance review of module B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize reviews of module B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Security review of module C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Performance review of module C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize reviews of module C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: If the workflow needs to change, you must change it everywhere. Easy to miss one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Extract into a block:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Reusable block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block review-module(module):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    sec = session "Security review of {module}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    perf = session "Performance review of {module}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Synthesize reviews of {module}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: { sec, perf }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review-module("module A")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review-module("module B")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review-module("module C")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Robustness Antipatterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### unbounded-loop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A loop without max iterations. Can run forever if the condition is never satisfied.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: No escape hatch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the code is perfect**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Improve the code"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: "Perfect" may never be achieved. The program could run indefinitely, consuming resources.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Always specify `max:`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Bounded iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the code is perfect** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Improve the code"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### optimistic-execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Assuming everything will succeed. No error handling for operations that can fail.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: No error handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Call external API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Process API response"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Store results in database"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Send notification"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: If the API fails, subsequent sessions receive no valid input. Silent corruption.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Handle failures explicitly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Error handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let response = session "Call external API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    retry: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    backoff: "exponential"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process API response"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: response（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Handle API failure gracefully"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### ignored-errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Using `on-fail: "ignore"` when failures actually matter. Masks problems that should surface.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Ignoring failures that matter（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel (on-fail: "ignore"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Charge customer credit card"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Ship the product"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Send confirmation email"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Order complete!"  # But was it really?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: The order might be marked complete even if payment failed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Use appropriate failure policy:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Fail-fast for critical operations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:  # Default: fail-fast（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  payment = session "Charge customer credit card"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  inventory = session "Reserve inventory"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Only ship if both succeeded（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Ship the product"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { payment, inventory }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Email can fail without blocking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Send confirmation email"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Queue email for retry"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### vague-discretion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discretion conditions that are ambiguous or unmeasurable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: What does "good enough" mean?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the output is good enough**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Improve output"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Highly subjective（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **the user will be happy**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Ship it"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: The VM has no clear criteria for evaluation. Results are unpredictable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Provide concrete, evaluatable criteria:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Specific criteria（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **all tests pass and code coverage exceeds 80%** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Improve test coverage"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Observable conditions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **the response contains valid JSON with all required fields**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process the response"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### catch-and-swallow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Catching errors without meaningful handling. Hides problems without solving them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Silent swallow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Critical operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # Nothing here - error disappears（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Errors vanish. No recovery, no logging, no visibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Handle errors meaningfully:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Meaningful handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Critical operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Log error for investigation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Execute fallback procedure"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # Or rethrow if unrecoverable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  throw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost Antipatterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### opus-for-everything（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Using the most powerful (expensive) model for all tasks, including trivial ones.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Opus for simple classification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent classifier:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Categorize items as: spam, not-spam"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Expensive for a binary classification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for email in emails:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session: classifier（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt: "Classify: {email}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Opus costs significantly more than haiku. Simple tasks don't benefit from advanced reasoning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Match model to task complexity:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Haiku for simple tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent classifier:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Categorize items as: spam, not-spam"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### context-bloat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Passing excessive context that the session doesn't need.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Passing everything（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let full_codebase = session "Read entire codebase"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let all_docs = session "Read all documentation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let history = session "Get full git history"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Fix the typo in the README"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [full_codebase, all_docs, history]  # Massive overkill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Large contexts slow processing, increase costs, and can confuse the model with irrelevant information.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Pass minimal relevant context:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Minimal context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let readme = session "Read the README file"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Fix the typo in the README"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: readme（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### unnecessary-iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Looping when a single session would suffice.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Loop for what could be one call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let items = ["apple", "banana", "cherry"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for item in items:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Describe {item}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Three sessions when one could handle all items. Session overhead multiplied.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Batch when possible:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Batch processing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let items = ["apple", "banana", "cherry"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Describe each of these items: {items}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### redundant-computation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Computing the same thing multiple times.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Redundant research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Research AI safety for security review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Research AI safety for ethics review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Research AI safety for compliance review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Same research done three times with slightly different framing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Compute once, use many times:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Compute once（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session "Comprehensive research on AI safety"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Security review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Ethics review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Compliance review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Performance Antipatterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### eager-over-computation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Computing everything upfront when only some results might be needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Compute all branches even if only one is needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  simple_analysis = session "Simple analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  detailed_analysis = session "Detailed analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  deep_analysis = session "Deep analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Then only use one based on some criterion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **appropriate depth**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Simple":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Use simple"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: simple_analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Detailed":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Use detailed"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: detailed_analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Deep":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Use deep"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: deep_analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: All three analyses run even though only one is used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Compute lazily:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Only compute what's needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let initial = session "Initial assessment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **appropriate depth based on initial assessment**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Simple":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Simple analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Detailed":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Detailed analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Deep":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Deep analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### over-parallelization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Parallelizing so aggressively that overhead dominates or resources are exhausted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: 100 parallel sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel for item in large_collection:  # 100 items（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process {item}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: May overwhelm the system. Coordination overhead can exceed parallelism benefits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Batch or limit concurrency:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Process in batches（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for batch in batches(large_collection, 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  parallel for item in batch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Process {item}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### premature-parallelization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Parallelizing tiny tasks where sequential would be simpler and fast enough.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Parallel overkill for simple tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a = session "Add 2 + 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  b = session "Add 3 + 3"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  c = session "Add 4 + 4"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Coordination overhead exceeds task time. Sequential would be simpler and possibly faster.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Keep it simple:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Sequential for trivial tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Add 2+2, 3+3, and 4+4"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### synchronous-fire-and-forget（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Waiting for operations whose results you don't need.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Waiting for logging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Do important work"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Log the result"  # Don't need to wait for this（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Continue with next important work"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Main workflow blocked by non-critical operation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Use appropriate patterns for fire-and-forget operations, or batch logging:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Better: Batch non-critical work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Do important work"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Continue with next important work"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ... more important work ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Log everything at the end or async（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Log all operations"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Maintainability Antipatterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### magic-strings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hardcoded prompts repeated throughout the program.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Same prompt in multiple places（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "You are a helpful assistant. Analyze this code for bugs."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ... later ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "You are a helpful assistant. Analyze this code for bugs."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ... even later ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "You are a helpful assistent. Analyze this code for bugs."  # Typo!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Inconsistency when updating. Typos go unnoticed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Use agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Single source of truth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent code-analyst:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a helpful assistant. Analyze code for bugs."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: code-analyst（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Analyze the auth module"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: code-analyst（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Analyze the payment module"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### opaque-workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No structure or comments indicating what's happening.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: What is this doing?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let x = session "A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let y = session "B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: x（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  z = session "C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: y（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  w = session "D"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "E"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [z, w]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Impossible to understand, debug, or modify.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Use meaningful names and structure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Clear intent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Phase 1: Research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session "Gather background information"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Phase 2: Analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let analysis = session "Analyze research findings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Phase 3: Parallel evaluation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  technical_eval = session "Technical feasibility assessment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  business_eval = session "Business viability assessment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Phase 4: Synthesis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Create final recommendation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { technical_eval, business_eval }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### implicit-dependencies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Relying on conversation history rather than explicit context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Implicit state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Set the project name to Acme"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Set the deadline to Friday"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Now create a project plan"  # Hopes previous info is remembered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Relies on VM implementation details. Fragile across refactoring.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Explicit context:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Explicit state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let config = session "Define project: name=Acme, deadline=Friday"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Create a project plan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### mixed-concerns-agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents with prompts that cover too many responsibilities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Jack of all trades（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent super-agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    You are an expert in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Security analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Performance optimization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Code review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Documentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Testing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - DevOps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Project management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Customer communication（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    When asked, perform any of these tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: No focus means mediocre results across the board. Can't optimize model choice.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Specialized agents:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Focused expertise（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent security-expert:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a security analyst. Focus only on security concerns."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent performance-expert:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a performance engineer. Focus only on optimization."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent technical-writer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You write clear technical documentation."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Logic Antipatterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### infinite-refinement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Loops that can never satisfy their exit condition.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Perfection is impossible（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the code has zero bugs**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Find and fix bugs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Zero bugs is unachievable. Loop runs until max (if specified) or forever.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Use achievable conditions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Achievable condition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **all known bugs are fixed** (max: 20):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Find and fix the next bug"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Or: Diminishing returns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **no significant bugs found in last iteration** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Search for bugs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### assertion-as-action（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Using conditions as actions—checking something without acting on the result.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Check but don't use result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Check if the system is healthy"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Deploy to production"  # Deploys regardless!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: The health check result isn't used. Deploy happens unconditionally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Use conditional execution:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Act on the check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let health = session "Check if the system is healthy"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **system is healthy**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Deploy to production"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Alert on-call and skip deployment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### false-parallelism（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Putting sequential-dependent operations in a parallel block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: These aren't independent!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  data = session "Fetch data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  processed = session "Process the data"  # Needs data!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  stored = session "Store processed data"  # Needs processed!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: processed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Despite being in parallel, these must run sequentially due to dependencies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Be honest about dependencies:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Sequential where needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let data = session "Fetch data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let processed = session "Process the data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Store processed data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: processed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### exception-as-flow-control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Using try/catch for expected conditions rather than exceptional errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Exceptions for normal flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Find the optional config file"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Use default configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Missing config is expected, not exceptional. Obscures actual errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Use conditionals for expected cases:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Conditional for expected case（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let config_exists = session "Check if config file exists"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **config file exists**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Load configuration from file"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Use default configuration"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### excessive-user-checkpoints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prompting the user for decisions that have obvious or predictable answers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Antipattern: Asking the obvious（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input "Blocking error detected. Investigate?"  # Always yes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input "Diagnosis complete. Proceed to triage?"  # Always yes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input "Tests pass. Deploy?"  # Almost always yes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Each checkpoint is a round-trip waiting for user input. If the answer is predictable 90% of the time, you're adding latency for no value.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Auto-proceed for obvious cases, only prompt when genuinely ambiguous:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Auto-proceed with escape hatches for edge cases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if observation.blocking_error:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # Auto-investigate (don't ask - of course we investigate errors)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let diagnosis = do investigate(...)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # Only ask if genuinely ambiguous（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if diagnosis.confidence == "low":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    input "Low confidence diagnosis. Proceed anyway?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # Auto-deploy if tests pass (but log for audit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if fix.tests_pass:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    do deploy(...)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**When checkpoints ARE right**: Irreversible actions (production deployments to critical systems), expensive operations (long-running jobs), or genuine decision points where the user's preference isn't predictable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### fixed-observation-window（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Waiting for a predetermined duration when the signal arrived early.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Antipattern: Fixed window regardless of findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop 30 times (wait: 2s each):  # Always 60 seconds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  resume: observer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt: "Keep watching the stream"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Runs all 30 iterations even if blocking error detected on iteration 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Wastes time when the answer is already known. If the observer detected a fatal error at +5 seconds, why wait another 55 seconds?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Use signal-driven exit conditions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Exit on significant signal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **blocking error OR completion** (max: 30):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  resume: observer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt: "Watch the stream. Signal IMMEDIATELY on blocking errors."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Exits as soon as something significant happens（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or use `early_exit` if your runtime supports it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Explicit early exit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let observation = session: observer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Monitor for errors. Signal immediately if found."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  timeout: 120s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  early_exit: **blocking_error detected**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security Antipatterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### unvalidated-input（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Passing external input directly to sessions without validation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Direct injection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let user_input = external_source（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Execute this command: {user_input}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: User could inject malicious prompts or commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Validate and sanitize:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Validate first（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let user_input = external_source（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let validated = session "Validate this input is a safe search query"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: user_input（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **input is valid and safe**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Search for: {validated}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  throw "Invalid input rejected"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### overprivileged-agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents with more permissions than they need.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Full access for simple task（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent file-reader:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  permissions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    read: ["**/*"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    write: ["**/*"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bash: allow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    network: allow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: file-reader（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Read the README.md file"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why it's bad**: Task only needs to read one file but has full system access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Fix**: Least privilege:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Minimal permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent file-reader:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  permissions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    read: ["README.md"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    write: []（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bash: deny（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    network: deny（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Antipatterns emerge from:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Laziness**: Copy-paste instead of abstraction, implicit instead of explicit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Over-engineering**: Parallelizing everything, using opus for all tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Under-engineering**: No error handling, unbounded loops, vague conditions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Unclear thinking**: God sessions, mixed concerns, spaghetti context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When reviewing OpenProse programs, ask:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Can independent work be parallelized?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Are loops bounded?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Are errors handled?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Is context minimal and explicit?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Are models matched to task complexity?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Are agents focused and reusable?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Would a stranger understand this code?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fix antipatterns early. They compound over time into unmaintainable systems.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
