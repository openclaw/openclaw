# OpenProse Help（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Load this file when a user invokes `prose help` or asks about OpenProse.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Welcome（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse is a programming language for AI sessions. You write structured programs that orchestrate AI agents, and the VM (this session) executes them by spawning real subagents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**A long-running AI session is a Turing-complete computer. OpenProse is a programming language for it.**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What Do You Want to Automate?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a user invokes `prose help`, guide them toward defining what they want to build. Use the AskUserQuestion tool:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Question: "What would you like to automate with OpenProse?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Header: "Goal"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  1. "Run a workflow" - "I have a .prose file to execute"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  2. "Build something new" - "Help me create a program for a specific task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  3. "Learn the syntax" - "Show me examples and explain how it works"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  4. "Explore possibilities" - "What can OpenProse do?"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**After the user responds:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Run a workflow**: Ask for the file path, then load `prose.md` and execute（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Build something new**: Ask them to describe their task, then help write a .prose program (load `guidance/patterns.md`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Learn the syntax**: Show examples from `examples/`, explain the VM model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Explore possibilities**: Walk through key examples like `37-the-forge.prose` or `28-gas-town.prose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Available Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command                | What it does                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | --------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose help`           | This help - guides you to what you need |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose run <file>`     | Execute a .prose program                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose compile <file>` | Validate syntax without running         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose update`         | Migrate legacy workspace files          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose examples`       | Browse and run example programs         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick Start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Run an example:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run examples/01-hello-world.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Create your first program:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose help（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
→ Select "Build something new"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
→ Describe what you want to automate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## FAQs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What AI assistants are supported?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Claude Code, OpenCode, and Amp. Any harness that runs a sufficiently intelligent model and supports primitives like subagents are considered "Prose Complete".（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How is this a VM?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
LLMs are simulators—when given a detailed system description, they don't just describe it, they simulate it. The `prose.md` spec describes a VM with enough fidelity that reading it induces simulation. But simulation with sufficient fidelity is implementation: each session spawns a real subagent, outputs are real artifacts, state persists in conversation history or files. The simulation is the execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What's "intelligent IoC"?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Traditional IoC containers (Spring, Guice) wire up dependencies from configuration files. OpenProse's container is an AI session that wires up agents using understanding. It doesn't just match names—it understands context, intent, and can make intelligent decisions about execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### This looks like Python.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The syntax is intentionally familiar—Python's indentation-based structure is readable and self-evident. But the semantics are entirely different. OpenProse has no functions, no classes, no general-purpose computation. It has agents, sessions, and control flow. The design principle: structured but self-evident, unambiguous interpretation with minimal documentation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why not English?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
English is already an agent framework—we're not replacing it, we're structuring it. Plain English doesn't distinguish sequential from parallel, doesn't specify retry counts, doesn't scope variables. OpenProse uses English exactly where ambiguity is a feature (inside `**...**`), and structure everywhere else. The fourth wall syntax lets you lean on AI judgment precisely when you want to.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why not YAML?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We started with YAML. The problem: loops, conditionals, and variable declarations aren't self-evident in YAML—and when you try to make them self-evident, it gets verbose and ugly. More fundamentally, YAML optimizes for machine parseability. OpenProse optimizes for intelligent machine legibility. It doesn't need to be parsed—it needs to be understood. That's a different design target entirely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Why not LangChain/CrewAI/AutoGen?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Those are orchestration libraries—they coordinate agents from outside. OpenProse runs inside the agent session—the session itself is the IoC container. This means zero external dependencies and portability across any AI assistant. Switch from Claude Code to Codex? Your .prose files still work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Syntax at a Glance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "prompt"              # Spawn subagent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent name:                   # Define agent template（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let x = session "..."         # Capture result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:                     # Concurrent execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat N:                     # Fixed loop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for x in items:               # Iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **condition**:     # AI-evaluated loop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try: ... catch: ...           # Error handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **condition**: ...         # Conditional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **criteria**: option   # AI-selected branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block name(params):           # Reusable block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do blockname(args)            # Invoke block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
items | map: ...              # Pipeline（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For complete syntax and validation rules, see `compiler.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `examples/` directory contains 37 example programs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Range | Category                                                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----- | --------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 01-08 | Basics (hello world, research, code review, debugging)                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 09-12 | Agents and skills                                                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 13-15 | Variables and composition                                                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 16-19 | Parallel execution                                                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 20-21 | Loops and pipelines                                                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 22-23 | Error handling                                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 24-27 | Advanced (choice, conditionals, blocks, interpolation)                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 28    | Gas Town (multi-agent orchestration)                                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 29-31 | Captain's chair pattern (persistent orchestrator)                                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 33-36 | Production workflows (PR auto-fix, content pipeline, feature factory, bug hunter) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 37    | The Forge (build a browser from scratch)                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Recommended starting points:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `01-hello-world.prose` - Simplest possible program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `16-parallel-reviews.prose` - See parallel execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `37-the-forge.prose` - Watch AI build a web browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
