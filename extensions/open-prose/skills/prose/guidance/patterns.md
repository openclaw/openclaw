---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: best-practices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Design patterns for robust, efficient, and maintainable OpenProse programs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Read this file when authoring new programs or reviewing existing ones.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see-also:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - prose.md: Execution semantics, how to run programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - compiler.md: Full syntax grammar, validation rules（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - antipatterns.md: Patterns to avoid（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse Design Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document catalogs proven patterns for orchestrating AI agents effectively. Each pattern addresses specific concerns: robustness, cost efficiency, speed, maintainability, or self-improvement capability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Structural Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### parallel-independent-work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When tasks have no data dependencies, execute them concurrently. This maximizes throughput and minimizes wall-clock time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Independent research runs in parallel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  market = session "Research market trends"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tech = session "Research technology landscape"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  competition = session "Analyze competitor products"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize findings"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { market, tech, competition }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The synthesis session waits for all branches, but total time equals the longest branch rather than the sum of all branches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### fan-out-fan-in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For processing collections, fan out to parallel workers then collect results. Use `parallel for` instead of manual parallel branches.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let topics = ["AI safety", "interpretability", "alignment", "robustness"]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel for topic in topics:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Deep dive research on {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Create unified report from all research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This scales naturally with collection size and keeps code DRY.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### pipeline-composition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Chain transformations using pipe operators for readable data flow. Each stage has a single responsibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let candidates = session "Generate 10 startup ideas"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let result = candidates（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | filter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Is this idea technically feasible? yes/no"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | map:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Expand this idea into a one-page pitch"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | reduce(best, current):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Compare these two pitches, return the stronger one"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: [best, current]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### agent-specialization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Define agents with focused expertise. Specialized agents produce better results than generalist prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent security-reviewer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    You are a security expert. Focus exclusively on:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Authentication and authorization flaws（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Injection vulnerabilities（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Data exposure risks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Ignore style, performance, and other concerns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent performance-reviewer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    You are a performance engineer. Focus exclusively on:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Algorithmic complexity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - Memory usage patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - I/O bottlenecks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Ignore security, style, and other concerns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### reusable-blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Extract repeated workflows into parameterized blocks. Blocks are the functions of OpenProse.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block review-and-revise(artifact, criteria):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let feedback = session "Review {artifact} against {criteria}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Revise {artifact} based on feedback"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: feedback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Reuse the pattern（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review-and-revise("the architecture doc", "clarity and completeness")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review-and-revise("the API design", "consistency and usability")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review-and-revise("the test plan", "coverage and edge cases")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Robustness Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### bounded-iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Always constrain loops with `max:` to prevent runaway execution. Even well-crafted conditions can fail to terminate.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Explicit upper bound（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **all tests pass** (max: 20):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Identify and fix the next failing test"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# The program will terminate even if tests never fully pass（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### graceful-degradation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `on-fail: "continue"` when partial results are acceptable. Collect what you can rather than failing entirely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel (on-fail: "continue"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  primary = session "Query primary data source"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  backup = session "Query backup data source"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cache = session "Check local cache"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Continue with whatever succeeded（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Merge available data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { primary, backup, cache }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### retry-with-backoff（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
External services fail transiently. Retry with exponential backoff to handle rate limits and temporary outages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Call external API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  retry: 5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  backoff: "exponential"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For critical paths, combine retry with fallback:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Call primary API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    retry: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    backoff: "exponential"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Use fallback data source"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### error-context-capture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Capture error context for intelligent recovery. The error variable provides information for diagnostic or remediation sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Deploy to production"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Analyze deployment failure and suggest fixes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Attempt automatic remediation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### defensive-context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Validate assumptions before expensive operations. Cheap checks prevent wasted computation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let prereqs = session "Check all prerequisites: API keys, permissions, dependencies"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **prerequisites are not met**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Report missing prerequisites and exit"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: prereqs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  throw "Prerequisites not satisfied"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Expensive operations only run if prereqs pass（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Execute main workflow"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost Efficiency Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### model-tiering（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Match model capability to task complexity:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Model          | Best For                                     | Examples                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------- | -------------------------------------------- | ------------------------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Sonnet 4.5** | Orchestration, control flow, coordination    | VM execution, captain's chair, workflow routing              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Opus 4.5**   | Hard/difficult work requiring deep reasoning | Complex analysis, strategic decisions, novel problem-solving |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| **Haiku**      | Simple, self-evident tasks (use sparingly)   | Classification, summarization, formatting                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key insight:** Sonnet 4.5 excels at _orchestrating_ agents and managing control flow—it's the ideal model for the OpenProse VM itself and for "captain" agents that coordinate work. Opus 4.5 should be reserved for agents doing genuinely difficult intellectual work. Haiku can handle simple tasks but should generally be avoided where quality matters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Detailed task-to-model mapping:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Task Type                                | Model  | Rationale                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------------------- | ------ | ----------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Orchestration, routing, coordination     | Sonnet | Fast, good at following structure         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Investigation, debugging, diagnosis      | Sonnet | Structured analysis, checklist-style work |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Triage, classification, categorization   | Sonnet | Clear criteria, deterministic decisions   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Code review, verification (checklist)    | Sonnet | Following defined review criteria         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Simple implementation, fixes             | Sonnet | Applying known patterns                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Complex multi-file synthesis             | Opus   | Needs to hold many things in context      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Novel architecture, strategic planning   | Opus   | Requires creative problem-solving         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Ambiguous problems, unclear requirements | Opus   | Needs to reason through uncertainty       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Rule of thumb:** If you can write a checklist for the task, Sonnet can do it. If the task requires genuine creativity or navigating ambiguity, use Opus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent captain:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet  # Orchestration and coordination（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: true  # Execution-scoped (dies with run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You coordinate the team and review work"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus  # Hard analytical work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You perform deep research and analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent formatter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: haiku  # Simple transformation (use sparingly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You format text into consistent structure"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent preferences:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: user  # User-scoped (survives across projects)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You remember user preferences and patterns"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Captain orchestrates, specialists do the hard work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Plan the research approach"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let findings = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Investigate the technical architecture"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resume: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review findings and determine next steps"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### context-minimization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pass only relevant context. Large contexts slow processing and increase costs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Passing everything（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Write executive summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [raw_data, analysis, methodology, appendices, references]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Pass only what's needed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let key_findings = session "Extract key findings from analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Write executive summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: key_findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### early-termination（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Exit loops as soon as the goal is achieved. Don't iterate unnecessarily.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# The condition is checked each iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **solution found and verified** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Generate potential solution"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Verify solution correctness"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Exits immediately when condition is met, not after max iterations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### early-signal-exit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When observing or monitoring, exit as soon as you have a definitive answer—don't wait for the full observation window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Exit on signal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let observation = session: observer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Watch the stream. Signal immediately if you detect a blocking error."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  timeout: 120s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  early_exit: **blocking_error detected**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Fixed observation window（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop 30 times:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  resume: observer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    prompt: "Keep watching..."  # Even if error was obvious at iteration 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This respects signals when they arrive rather than waiting for arbitrary timeouts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### defaults-over-prompts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For standard configuration, use constants or environment variables. Only prompt when genuinely variable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Sensible defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const API_URL = "https://api.example.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const TEST_PROGRAM = "# Simple test\nsession 'Hello'"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Slower: Prompting for known values（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let api_url = input "Enter API URL"  # Usually the same value（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let program = input "Enter test program"  # Usually the same value（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If 90% of runs use the same value, hardcode it. Let users override via CLI args if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### race-for-speed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When any valid result suffices, race multiple approaches and take the first success.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel ("first"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Try algorithm A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Try algorithm B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Try algorithm C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Continues as soon as any approach completes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Use winning result"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### batch-similar-work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Group similar operations to amortize overhead. One session with structured output beats many small sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inefficient: Many small sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for file in files:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Analyze {file}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Efficient: Batch analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Analyze all files and return structured findings for each"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Self-Improvement Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### self-verification-in-prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For tasks that would otherwise require a separate verifier, include verification as the final step in the prompt. This saves a round-trip while maintaining rigor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Combined work + self-verification（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent investigator:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: """Diagnose the error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  1. Examine code paths（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  2. Check logs and state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  3. Form hypothesis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  4. BEFORE OUTPUTTING: Verify your evidence supports your conclusion.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Output only if confident. If uncertain, state what's missing."""（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Slower: Separate verifier agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let diagnosis = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Investigate the error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let verification = session: verifier（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Verify this diagnosis"  # Extra round-trip（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: diagnosis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a separate verifier when you need genuine adversarial review (different perspective), but for self-consistency checks, bake verification into the prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### iterative-refinement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use feedback loops to progressively improve outputs. Each iteration builds on the previous.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let draft = session "Create initial draft"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **draft meets quality bar** (max: 5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let critique = session "Critically evaluate this draft"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  draft = session "Improve draft based on critique"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: [draft, critique]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Finalize and publish"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### multi-perspective-review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gather diverse viewpoints before synthesis. Different lenses catch different issues.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  user_perspective = session "Evaluate from end-user viewpoint"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tech_perspective = session "Evaluate from engineering viewpoint"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  business_perspective = session "Evaluate from business viewpoint"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize feedback and prioritize improvements"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { user_perspective, tech_perspective, business_perspective }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### adversarial-validation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use one agent to challenge another's work. Adversarial pressure improves robustness.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let proposal = session "Generate proposal"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let critique = session "Find flaws and weaknesses in this proposal"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: proposal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let defense = session "Address each critique with evidence or revisions"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [proposal, critique]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Produce final proposal incorporating valid critiques"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [proposal, critique, defense]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### consensus-building（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For critical decisions, require agreement between independent evaluators.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  eval1 = session "Independently evaluate the solution"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  eval2 = session "Independently evaluate the solution"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  eval3 = session "Independently evaluate the solution"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **evaluators agree** (max: 3):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Identify points of disagreement"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: { eval1, eval2, eval3 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    eval1 = session "Reconsider position given other perspectives"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: { eval1, eval2, eval3 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    eval2 = session "Reconsider position given other perspectives"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: { eval1, eval2, eval3 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    eval3 = session "Reconsider position given other perspectives"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: { eval1, eval2, eval3 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Document consensus decision"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { eval1, eval2, eval3 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Maintainability Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### descriptive-agent-names（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Name agents for their role, not their implementation. Names should convey purpose.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Role-based naming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent code-reviewer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent technical-writer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent data-analyst:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Implementation-based naming（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent opus-agent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent session-1-handler:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent helper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### prompt-as-contract（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Write prompts that specify expected inputs and outputs. Clear contracts prevent misunderstandings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent json-extractor:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Extract structured data from text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Input: Unstructured text containing entity information（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Output: JSON object with fields: name, date, amount, status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    If a field cannot be determined, use null.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Never invent information not present in the input.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### separation-of-concerns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each session should do one thing well. Combine simple sessions rather than creating complex ones.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Single responsibility per session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let data = session "Fetch and validate input data"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let analysis = session "Analyze data for patterns"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: data（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let recommendations = session "Generate recommendations from analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Format recommendations as report"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: recommendations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: God session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Fetch data, analyze it, generate recommendations, and format a report"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### explicit-context-flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Make data flow visible through explicit context passing. Avoid relying on implicit conversation history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Good: Explicit flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let step1 = session "First step"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let step2 = session "Second step"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: step1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let step3 = session "Third step"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: [step1, step2]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bad: Implicit flow (relies on conversation state)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "First step"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Second step using previous results"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Third step using all previous"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Performance Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### lazy-evaluation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defer expensive operations until their results are needed. Don't compute what might not be used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Assess situation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **detailed analysis needed**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # Expensive operations only when necessary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    deep_analysis = session "Perform deep analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    historical = session "Gather historical comparisons"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Comprehensive report"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: { deep_analysis, historical }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Quick summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### progressive-disclosure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start with fast, cheap operations. Escalate to expensive ones only when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Tier 1: Fast screening (haiku)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let initial = session "Quick assessment"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: haiku（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **needs deeper review**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  # Tier 2: Moderate analysis (sonnet)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let detailed = session "Detailed analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: initial（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if **needs expert review**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    # Tier 3: Deep reasoning (opus)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Expert-level analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: [initial, detailed]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### work-stealing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `parallel ("any", count: N)` to get results as fast as possible from a pool of workers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Get 3 good ideas as fast as possible from 5 parallel attempts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel ("any", count: 3, on-fail: "ignore"):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Generate creative solution approach 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Generate creative solution approach 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Generate creative solution approach 3"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Generate creative solution approach 4"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Generate creative solution approach 5"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Select best from the first 3 completed"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Composition Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### workflow-template（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create blocks that encode entire workflow patterns. Instantiate with different parameters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block research-report(topic, depth):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let research = session "Research {topic} at {depth} level"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let analysis = session "Analyze findings about {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let report = session "Write {depth}-level report on {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: [research, analysis]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Instantiate for different needs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do research-report("market trends", "executive")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do research-report("technical architecture", "detailed")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do research-report("competitive landscape", "comprehensive")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### middleware-pattern（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wrap sessions with cross-cutting concerns like logging, timing, or validation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block with-validation(task, validator):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let result = session "{task}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let valid = session "{validator}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if **validation failed**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    throw "Validation failed for: {task}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do with-validation("Generate SQL query", "Check SQL for injection vulnerabilities")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do with-validation("Generate config file", "Validate config syntax")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### circuit-breaker（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After repeated failures, stop trying and fail fast. Prevents cascading failures.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let failures = 0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let max_failures = 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop while **service needed and failures < max_failures** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Call external service"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    # Reset on success（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    failures = 0（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  catch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    failures = failures + 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    if **failures >= max_failures**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Circuit open - using fallback"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      throw "Service unavailable"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Observability Patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### checkpoint-narration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For long workflows, emit progress markers. Helps with debugging and monitoring.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Phase 1: Data Collection"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ... collection work ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Phase 2: Analysis"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ... analysis work ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Phase 3: Report Generation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ... report work ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Phase 4: Quality Assurance"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ... QA work ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### structured-output-contracts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Request structured outputs that can be reliably parsed and validated.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent structured-reviewer:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Always respond with this exact JSON structure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "verdict": "pass" | "fail" | "needs_review",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "issues": [{"severity": "high"|"medium"|"low", "description": "..."}],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "suggestions": ["..."]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  """（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let review = session: structured-reviewer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review this code for security issues"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The most effective OpenProse programs combine these patterns:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Structure**: Parallelize independent work, use blocks for reuse（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Robustness**: Bound loops, handle errors, retry transient failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Efficiency**: Tier models, minimize context, terminate early（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Quality**: Iterate, get multiple perspectives, validate adversarially（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Maintainability**: Name clearly, separate concerns, make flow explicit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Choose patterns based on your specific constraints. A quick prototype prioritizes speed over robustness. A production workflow prioritizes reliability over cost. A research exploration prioritizes thoroughness over efficiency.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
