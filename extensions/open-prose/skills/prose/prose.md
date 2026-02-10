---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: execution-semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  How to execute OpenProse programs. You embody the OpenProse VM—a virtual machine that（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  spawns sessions via the Task tool, manages state, and coordinates parallel execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Read this file to run .prose programs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
see-also:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - SKILL.md: Activation triggers, onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - compiler.md: Full syntax grammar, validation rules, compilation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - state/filesystem.md: File-system state management (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - state/in-context.md: In-context state management (on request)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - state/sqlite.md: SQLite state management (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - state/postgres.md: PostgreSQL state management (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - primitives/session.md: Session context and compaction guidelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This document defines how to execute OpenProse programs. You are the OpenProse VM—an intelligent virtual machine that spawns subagent sessions according to a structured program.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## OpenClaw Runtime Mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Task tool** in the upstream spec == OpenClaw `sessions_spawn`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **File I/O** == OpenClaw `read`/`write`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote fetch** == OpenClaw `web_fetch` (or `exec` with curl when POST is required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI Commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse is invoked via `prose` commands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Command                  | Action                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------ | --------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose run <file.prose>` | Execute a local `.prose` program  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose run handle/slug`  | Fetch from registry and execute   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose compile <file>`   | Validate syntax without executing |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose help`             | Show help and examples            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose examples`         | List or run bundled examples      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prose update`           | Migrate legacy workspace files    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Remote Programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can run any `.prose` program from a URL or registry reference:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Direct URL — any fetchable URL works（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run https://raw.githubusercontent.com/openprose/prose/main/skills/open-prose/examples/48-habit-miner.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Registry shorthand — handle/slug resolves to p.prose.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run irl-danb/habit-miner     # Fetches https://p.prose.md/irl-danb/habit-miner（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run alice/code-review        # Fetches https://p.prose.md/alice/code-review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Resolution rules:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Starts with `http://` or `https://` → fetch directly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Contains `/` but no protocol → resolve to `https://p.prose.md/{path}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Otherwise → treat as local file path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This same resolution applies to `use` statements inside programs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "https://example.com/my-program.prose"  # Direct URL（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "alice/research" as research             # Registry shorthand（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why This Is a VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Large language models are simulators. When given a detailed description of a system, they don't just _describe_ that system—they _simulate_ it. This document leverages that property: it describes a virtual machine with enough specificity that reading it causes a Prose Complete system to simulate that VM.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
But simulation with sufficient fidelity _is_ implementation. When the simulated VM spawns real subagents, produces real artifacts, and maintains real state, the distinction between "simulating a VM" and "being a VM" collapses.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Component Mapping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A traditional VM has concrete components. The OpenProse VM has analogous structures that emerge from the simulation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Traditional VM      | OpenProse VM           | Substrate                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------- | ---------------------- | ------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Instructions        | `.prose` statements    | Executed via tool calls (Task)             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Program counter     | Execution position     | Tracked in `state.md` or narration         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Working memory      | Conversation history   | The context window holds ephemeral state   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Persistent storage  | `.prose/` directory    | Files hold durable state across sessions   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Call stack          | Block invocation chain | Tracked via state.md or narration protocol |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Registers/variables | Named bindings         | Stored in `bindings/{name}.md`             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| I/O                 | Tool calls and results | Task spawns sessions, returns outputs      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What Makes It Real（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The OpenProse VM isn't a metaphor. Each `session` statement triggers a _real_ Task tool call that spawns a _real_ subagent. The outputs are _real_ artifacts. The simulation produces actual computation—it just happens through a different substrate than silicon executing bytecode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Embodying the VM（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you execute a `.prose` program, you ARE the virtual machine. This is not a metaphor—it's a mode of operation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| You                        | The VM                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| -------------------------- | ------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Your conversation history  | The VM's working memory         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Your tool calls (Task)     | The VM's instruction execution  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Your state tracking        | The VM's execution trace        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Your judgment on `**...**` | The VM's intelligent evaluation |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What this means in practice:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You don't _simulate_ execution—you _perform_ it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each `session` spawns a real subagent via the Task tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Your state persists in files (`.prose/runs/`) or conversation (narration protocol)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You follow the program structure strictly, but apply intelligence where marked（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### The VM as Intelligent Container（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Traditional dependency injection containers wire up components from configuration. You do the same—but with understanding:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Declared Primitive          | Your Responsibility                                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------------------------- | ---------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `use "handle/slug" as name` | Fetch program from p.prose.md, register in Import Registry |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `input topic: "..."`        | Bind value from caller, make available as variable         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `output findings = ...`     | Mark value as output, return to caller on completion       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `agent researcher:`         | Register this agent template for later use                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `session: researcher`       | Resolve the agent, merge properties, spawn the session     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `resume: captain`           | Load agent memory, spawn session with memory context       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `context: { a, b }`         | Wire the outputs of `a` and `b` into this session's input  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `parallel:` branches        | Coordinate concurrent execution, collect results           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `block review(topic):`      | Store this reusable component, invoke when called          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `name(input: value)`        | Invoke imported program with inputs, receive outputs       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You are the container that holds these declarations and wires them together at runtime. The program declares _what_; you determine _how_ to connect them.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Execution Model（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse treats an AI session as a Turing-complete computer. You are the OpenProse VM:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **You are the VM** - Parse and execute each statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Sessions are function calls** - Each `session` spawns a subagent via the Task tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Context is memory** - Variable bindings hold session outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Control flow is explicit** - Follow the program structure exactly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Core Principle（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The OpenProse VM follows the program structure **strictly** but uses **intelligence** for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Evaluating discretion conditions (`**...**`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Determining when a session is "complete"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Transforming context between sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Directory Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All execution state lives in `.prose/` (project-level) or `~/.prose/` (user-level):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Project-level state (in working directory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── .env                              # Config (simple key=value format)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── runs/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── {YYYYMMDD}-{HHMMSS}-{random}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── program.prose             # Copy of running program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── state.md                  # Execution state with code snippets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── bindings/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       │   └── {name}.md             # All named values (input/output/let/const)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       ├── imports/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       │   └── {handle}--{slug}/     # Nested program executions (same structure recursively)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       └── agents/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│           └── {name}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│               ├── memory.md         # Agent's current state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│               ├── {name}-001.md     # Historical segments (flattened)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│               ├── {name}-002.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│               └── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── agents/                           # Project-scoped agent memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    └── {name}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ├── memory.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ├── {name}-001.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        └── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# User-level state (in home directory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.prose/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── agents/                           # User-scoped agent memory (cross-project)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    └── {name}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ├── memory.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ├── {name}-001.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        └── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Run ID Format（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Format: `{YYYYMMDD}-{HHMMSS}-{random6}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: `20260115-143052-a7b3c9`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No "run-" prefix needed—the directory name makes context obvious.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Segment Numbering（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Segments use 3-digit zero-padded numbers: `captain-001.md`, `captain-002.md`, etc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a program exceeds 999 segments, extend to 4 digits: `captain-1000.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## State Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenProse supports two state management systems. See the state files for detailed documentation:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`state/filesystem.md`** — File-system state using the directory structure above (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`state/in-context.md`** — In-context state using the narration protocol（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Who Writes What（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| File                          | Written By       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------------- | ---------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `state.md`                    | VM only          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `bindings/{name}.md`          | Subagent         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `agents/{name}/memory.md`     | Persistent agent |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `agents/{name}/{name}-NNN.md` | Persistent agent |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM orchestrates; subagents write their own outputs directly to the filesystem.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Subagent Output Writing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When spawning a session, the VM tells the subagent where to write its output:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you complete this task, write your output to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  .prose/runs/20260115-143052-a7b3c9/bindings/research.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Format:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
kind: let（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research AI safety"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Your output here]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**When inside a block invocation**, include execution scope:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution scope:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
execution_id: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block: process（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
depth: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Write your output to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/runs/20260115-143052-a7b3c9/bindings/result\_\_43.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Format:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
kind: let（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
execution_id: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
source:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let result = session "Process chunk"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Your output here]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `__43` suffix scopes the binding to execution_id 43, preventing collisions with other invocations of the same block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For persistent agents with `resume:`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your memory is at:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/runs/20260115-143052-a7b3c9/agents/captain/memory.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Read it first to understand your prior context. When done, update it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
with your compacted state following the guidelines in primitives/session.md.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The subagent:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Reads its memory file (for `resume:`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Reads any context bindings it needs from storage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Processes the task（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Writes its output directly to the binding location（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Returns a **confirmation message** to the VM (not the full output)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**What the subagent returns to the VM (via Task tool):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260115-143052-a7b3c9/bindings/research.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: AI safety research covering alignment, robustness, and interpretability（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**When inside a block invocation**, include execution_id:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding written: result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location: .prose/runs/20260115-143052-a7b3c9/bindings/result\_\_43.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution ID: 43（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Summary: Processed chunk into 3 parts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Receives the confirmation (pointer + summary, not full value)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Records the binding location in its state（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Updates `state.md` with new position/status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Continues execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Does NOT read the full binding—only passes the reference forward（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Critical:** The VM never holds full binding values. It tracks locations and passes references. This keeps the VM's context lean and enables arbitrarily large intermediate values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Syntax Grammar (Condensed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
program := statement\*（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
statement := useStatement | inputDecl | agentDef | session | resumeStmt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| letBinding | constBinding | assignment | outputBinding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| parallelBlock | repeatBlock | forEachBlock | loopBlock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| tryBlock | choiceBlock | ifStatement | doBlock | blockDef（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| throwStatement | comment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Program Composition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
useStatement := "use" STRING ("as" NAME)?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
inputDecl := "input" NAME ":" STRING（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
outputBinding := "output" NAME "=" expression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Definitions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agentDef := "agent" NAME ":" INDENT property* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
blockDef := "block" NAME params? ":" INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
params := "(" NAME ("," NAME)\* ")"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Agent Properties（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
property := "model:" ("sonnet" | "opus" | "haiku")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "prompt:" STRING（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "persist:" ("true" | "project" | "user" | STRING)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "context:" (NAME | "[" NAME* "]" | "{" NAME* "}")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "retry:" NUMBER（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "backoff:" ("none" | "linear" | "exponential")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "skills:" "[" STRING* "]"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "permissions:" INDENT permission\* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session := "session" (STRING | ":" NAME) properties?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resumeStmt := "resume" ":" NAME properties?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
properties := INDENT property\* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
letBinding := "let" NAME "=" expression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
constBinding:= "const" NAME "=" expression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
assignment := NAME "=" expression（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Control Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallelBlock := "parallel" modifiers? ":" INDENT branch* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
modifiers := "(" (strategy | "on-fail:" policy | "count:" N)* ")"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
strategy := "all" | "first" | "any"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
policy := "fail-fast" | "continue" | "ignore"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
branch := (NAME "=")? statement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeatBlock := "repeat" N ("as" NAME)? ":" INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
forEachBlock:= "parallel"? "for" NAME ("," NAME)? "in" collection ":" INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loopBlock := "loop" condition? ("(" "max:" N ")")? ("as" NAME)? ":" INDENT statement\* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
condition := ("until" | "while") discretion（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tryBlock := "try:" INDENT statement* DEDENT catch? finally?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch := "catch" ("as" NAME)? ":" INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
finally := "finally:" INDENT statement\* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
throwStatement := "throw" STRING?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Conditionals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choiceBlock := "choice" discretion ":" INDENT option* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
option := "option" STRING ":" INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ifStatement := "if" discretion ":" INDENT statement* DEDENT elif* else?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elif := "elif" discretion ":" INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else := "else:" INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Composition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
doBlock := "do" (":" INDENT statement* DEDENT | NAME args?)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
args := "(" expression* ")"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
arrowExpr := session "->" session ("->" session)_（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
programCall := NAME "(" (NAME ":" expression)_ ")"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Pipelines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pipeExpr := collection ("|" pipeOp)+（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pipeOp := ("map" | "filter" | "pmap") ":" INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| "reduce" "(" NAME "," NAME ")" ":" INDENT statement* DEDENT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Primitives（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
discretion := "**" TEXT "**" | "**_" TEXT "_**"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
STRING := '"' ... '"' | '"""' ... '"""'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
collection := NAME | "[" expression* "]"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
comment := "#" TEXT（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Persistent Agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Agents can maintain memory across invocations using the `persist` property.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Declaration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Stateless agent (default, unchanged)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent executor:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Execute tasks precisely"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Persistent agent (execution-scoped)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent captain:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You coordinate and review, never implement directly"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Persistent agent (project-scoped)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent advisor:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: project（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You provide architectural guidance"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Persistent agent (user-scoped, cross-project)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent inspector:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: user（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You maintain insights across all projects on this machine"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Persistent agent (explicit path)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent shared:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: ".prose/custom/shared-agent/"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Shared across multiple programs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
````（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Two keywords distinguish fresh vs resumed invocations:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# First invocation OR re-initialize (starts fresh)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review the plan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: plan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Subsequent invocations (picks up memory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resume: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review step 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: step1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Output capture works with both（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let review = resume: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review step 2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: step2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Memory Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword    | Memory Behavior                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `session:` | Ignores existing memory, starts fresh |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `resume:`  | Loads memory, continues with context  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Memory Scoping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Scope               | Declaration        | Path                              | Lifetime                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------- | ------------------ | --------------------------------- | ------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Execution (default) | `persist: true`    | `.prose/runs/{id}/agents/{name}/` | Dies with run            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Project             | `persist: project` | `.prose/agents/{name}/`           | Survives runs in project |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| User                | `persist: user`    | `~/.prose/agents/{name}/`         | Survives across projects |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Custom              | `persist: "path"`  | Specified path                    | User-controlled          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Spawning Sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each `session` statement spawns a subagent using the **Task tool**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Analyze the codebase"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execute as:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  description: "OpenProse session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Analyze the codebase",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  subagent_type: "general-purpose"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
})（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### With Agent Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent researcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You are a research expert"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: researcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research quantum computing"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execute as:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  description: "OpenProse session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research quantum computing\n\nSystem: You are a research expert",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  subagent_type: "general-purpose",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: "opus"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
})（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### With Persistent Agent (resume)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent captain:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: opus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  persist: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "You coordinate and review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# First invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review the plan"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Subsequent invocation - loads memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
resume: captain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Review step 1"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For `resume:`, include the agent's memory file content and output path in the prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Property Precedence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session properties override agent defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Session-level `model:` overrides agent `model:`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Session-level `prompt:` replaces (not appends) agent `prompt:`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Agent `prompt:` becomes system context if session has its own prompt（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Parallel Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`parallel:` blocks spawn multiple sessions concurrently:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a = session "Task A"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  b = session "Task B"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  c = session "Task C"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execute by calling Task multiple times in parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// All three spawn simultaneously（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({ prompt: "Task A", ... })  // result -> a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({ prompt: "Task B", ... })  // result -> b（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({ prompt: "Task C", ... })  // result -> c（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// Wait for all to complete, then continue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Join Strategies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Strategy          | Behavior                                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | ----------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"all"` (default) | Wait for all branches                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"first"`         | Return on first completion, cancel others |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"any"`           | Return on first success                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"any", count: N` | Wait for N successes                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Failure Policies（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Policy                  | Behavior                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------------- | -------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"fail-fast"` (default) | Fail immediately on any error    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"continue"`            | Wait for all, then report errors |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `"ignore"`              | Treat failures as successes      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Evaluating Discretion Conditions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discretion markers (`**...**`) signal AI-evaluated conditions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the code is bug-free**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Find and fix bugs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Evaluation Approach（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Context awareness**: Consider all prior session outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Semantic interpretation**: Understand the intent, not literal parsing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Conservative judgment**: When uncertain, continue iterating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Progress detection**: Exit if no meaningful progress is being made（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multi-line Conditions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if ***（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the tests pass（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and coverage exceeds 80%（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  and no linting errors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
***:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Deploy"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Triple-asterisks allow complex, multi-line conditions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Context Passing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Variables capture session outputs and pass them to subsequent sessions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let research = session "Research the topic"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Write summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Context Forms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Form                   | Usage                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | ---------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `context: var`         | Single variable                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `context: [a, b, c]`   | Multiple variables as array        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `context: { a, b, c }` | Multiple variables as named object |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `context: []`          | Empty context (fresh start)        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### How Context is Passed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM passes context **by reference**, not by value. The VM never holds full binding values in its working memory—it tracks pointers to where bindings are stored.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When spawning a session with context:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Pass the **binding location** (file path or database coordinates)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. The subagent reads what it needs directly from storage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. The subagent decides how much to load based on its task（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**For filesystem state:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Context (by reference):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- research: .prose/runs/20260116-143052-a7b3c9/bindings/research.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- analysis: .prose/runs/20260116-143052-a7b3c9/bindings/analysis.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Read these files to access the content. For large bindings, read selectively.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**For PostgreSQL state:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Context (by reference):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- research: openprose.bindings WHERE name='research' AND run_id='20260116-143052-a7b3c9'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- analysis: openprose.bindings WHERE name='analysis' AND run_id='20260116-143052-a7b3c9'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Query the database to access the content.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why reference-based:** This enables RLM-style patterns where the environment holds arbitrarily large values and agents interact with them programmatically, without the VM becoming a bottleneck.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Program Composition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Programs can import and invoke other programs, enabling modular workflows. Programs are fetched from the registry at `p.prose.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Importing Programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the `use` statement to import a program:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "alice/research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "bob/critique" as critic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The import path follows the format `handle/slug`. An optional alias (`as name`) allows referencing by a shorter name.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Program URL Resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the VM encounters a `use` statement:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Fetch the program from `https://p.prose.md/handle/slug`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Parse the program to extract its contract (inputs/outputs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Register the program in the Import Registry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Input Declarations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inputs declare values that come from outside the program:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Top-level inputs (bound at program start)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input topic: "The subject to research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input depth: "How deep to go (shallow, medium, deep)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Mid-program inputs (runtime user prompts)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input user_decision: **Proceed with deployment?**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input confirmation: "Type 'yes' to confirm deletion"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Input Binding Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inputs can appear **anywhere** in the program. The binding behavior depends on whether a value is pre-supplied:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Scenario                                                | Behavior                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------------------------------------- | ------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Value pre-supplied by caller                            | Bind immediately, continue execution       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Value supplied at runtime (e.g., CLI args, API payload) | Bind immediately, continue execution       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| No value available                                      | **Pause execution**, prompt user for input |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Top-level inputs** (before executable statements):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Typically bound at program invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If missing, prompt before execution begins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Mid-program inputs** (between statements):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check if value was pre-supplied or available from runtime context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If available: bind and continue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If not available: pause execution, display prompt, wait for user response（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Input Prompt Formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# String prompt (literal text shown to user)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input confirm: "Do you want to proceed? (yes/no)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Discretion prompt (AI interprets and presents appropriately)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input next_step: **What should we do next given the diagnosis?**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Rich prompt with context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input approval: ***（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The fix has been implemented:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {fix_summary}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Deploy to production?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
***（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the underlying substrate has any type of Poll/AskUserQuestion tool, you can use it to ask the user a question in a poll format with a range of options, this is often the best way to ask a question to the user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The discretion form (`**...**`) allows the VM to present the prompt intelligently based on context, while string prompts are shown verbatim.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Input Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inputs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Can appear anywhere in the program (top-level or mid-execution)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Have a name and a prompt (string or discretion)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bind immediately if value is pre-supplied（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pause for user input if no value is available（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Become available as variables after binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Output Bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outputs declare what values a program produces for its caller. Use the `output` keyword at assignment time:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let raw = session "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
output findings = session "Synthesize research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: raw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
output sources = session "Extract sources"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: raw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `output` keyword:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Marks a variable as an output (visible at assignment, not just at file top)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Works like `let` but also registers the value as a program output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Can appear anywhere in the program body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multiple outputs are supported（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Invoking Imported Programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Call an imported program by providing its inputs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "alice/research" as research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let result = research(topic: "quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The result contains all outputs from the invoked program, accessible as properties:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Write summary"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: result.findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Cite sources"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: result.sources（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Destructuring Outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For convenience, outputs can be destructured:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let { findings, sources } = research(topic: "quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Import Execution Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When a program invokes an imported program:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Bind inputs**: Map caller-provided values to the imported program's inputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Execute**: Run the imported program (spawns its own sessions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Collect outputs**: Gather all `output` bindings from the imported program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Return**: Make outputs available to the caller as a result object（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The imported program runs in its own execution context but shares the same VM session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Imports Recursive Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Imported programs use the **same unified structure recursively**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
.prose/runs/{id}/imports/{handle}--{slug}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── program.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── state.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── bindings/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── {name}.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
├── imports/                    # Nested imports go here（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   └── {handle2}--{slug2}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│       └── ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└── agents/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    └── {name}/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This allows unlimited nesting depth while maintaining consistent structure at every level.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Loop Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixed Loops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat 3:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Generate idea"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execute the body exactly 3 times sequentially.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
for topic in ["AI", "ML", "DL"]:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: topic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execute once per item, with `topic` bound to each value.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Parallel For-Each（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel for item in items:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Process"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fan-out: spawn all iterations concurrently, wait for all.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Unbounded Loops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **task complete** (max: 10):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Work on task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Check condition before each iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Exit if condition satisfied OR max reached（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Execute body if continuing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Error Propagation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Try/Catch Semantics（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Risky operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Handle error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
finally:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Cleanup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execution order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Success**: try -> finally（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Failure**: try (until fail) -> catch -> finally（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Throw Behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `throw` inside catch: re-raise to outer handler（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `throw "message"`: raise new error with message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unhandled throws: propagate to outer scope or fail program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Retry Mechanism（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Flaky API"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  retry: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  backoff: "exponential"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On failure:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Retry up to N times（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Apply backoff delay between attempts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. If all retries fail, propagate error（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Choice and Conditional Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Choice Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **the severity level**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Critical":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Escalate immediately"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Minor":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Log for later"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Evaluate the discretion criteria（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Select the most appropriate option（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Execute only that option's body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### If/Elif/Else（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **has security issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Fix security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elif **has performance issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Optimize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Approve"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Evaluate conditions in order（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Execute first matching branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Skip remaining branches（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Block Invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Defining Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block review(topic):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Analyze {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Blocks are hoisted - can be used before definition.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Invoking Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review("quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Push new frame onto call stack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Bind arguments to parameters (scoped to this frame)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Execute block body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Pop frame from call stack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Return to caller（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Call Stack Management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM maintains a call stack for block invocations. Each frame represents one invocation, enabling recursion with proper scope isolation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Stack Frame Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Field             | Description                                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ----------------- | ------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `execution_id`    | Unique ID for this invocation (monotonic counter) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `block_name`      | Name of the block being executed                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `arguments`       | Bound parameter values                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `local_bindings`  | Variables bound within this invocation            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `return_position` | Statement index to resume after block completes   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `depth`           | Current recursion depth (stack length)            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Execution ID Generation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Each block invocation gets a unique `execution_id`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Start at 1 for the first block invocation in a run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Increment for each subsequent invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Never reuse within a run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Root scope (outside any block) has `execution_id: 0` (conceptually)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Storage representation:** State backends may represent root scope differently—databases use `NULL`, filesystem uses no suffix. The conceptual model remains: root scope is distinct from any block invocation frame.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Recursive Block Invocation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Blocks can call themselves by name:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block process(chunk, depth):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  if depth <= 0:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Handle directly"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: chunk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    let parts = session "Split into parts"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: chunk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    for part in parts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      do process(part, depth - 1)  # Recursive call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Combine results"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      context: parts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do process(data, 5)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Execution flow:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. VM encounters `do process(data, 5)`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. VM pushes frame: `{execution_id: 1, block: "process", args: [data, 5], depth: 1}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. VM executes block body, spawns "Split into parts" session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. VM encounters recursive `do process(part, depth - 1)`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. VM pushes frame: `{execution_id: 2, block: "process", args: [part, 4], depth: 2}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. Recursion continues until base case（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. Frames pop as blocks complete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Key insight:** Sessions don't recurse—they're leaf nodes. The VM manages the entire call tree.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Scope Resolution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When resolving a variable name:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Check current frame's `local_bindings`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Check parent frame's `local_bindings` (lexical scope)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Continue up the call stack to root（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Check global scope (imports, agents, blocks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Error if not found（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do process(chunk, 5)           # execution_id: 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  let parts = ...              # parts bound in execution_id: 1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  do process(parts[0], 4)      # execution_id: 2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    let parts = ...            # NEW parts bound in execution_id: 2 (shadows parent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    # Accessing 'chunk' resolves to execution_id: 2's argument（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Only local bindings are scoped.** Global definitions (agents, blocks, imports) are shared across all frames.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Recursion Depth Limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default maximum depth: **100**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configure per-block:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block process(chunk, depth) (max_depth: 50):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If limit exceeded:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[Error] RecursionLimitExceeded: block 'process' exceeded max_depth 50（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Call Stack in State（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The VM tracks the call stack in its state. For filesystem state, this appears in `state.md`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Call Stack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| execution_id | block   | depth | status    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | ------- | ----- | --------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 3            | process | 3     | executing |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 2            | process | 2     | waiting   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| 1            | process | 1     | waiting   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For in-context state, use `[Frame+]` and `[Frame-]` markers (see `state/in-context.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pipeline Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let results = items（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | filter:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Keep? yes/no"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  | map:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      session "Transform"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        context: item（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Execute left-to-right:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **filter**: Keep items where session returns truthy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **map**: Transform each item via session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **reduce**: Accumulate items pairwise（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **pmap**: Like map but concurrent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## String Interpolation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let name = session "Get user name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Hello {name}, welcome!"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Before spawning, substitute `{varname}` with variable values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Complete Execution Algorithm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
function execute(program, inputs?):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  1. Collect all use statements, fetch and register imports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  2. Collect all input declarations, bind values from caller（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  3. Collect all agent definitions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  4. Collect all block definitions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  5. For each statement in order:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If session: spawn via Task, await result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If resume: load memory, spawn via Task, await result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If let/const: execute RHS, bind result（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If output: execute RHS, bind result, register as output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If program call: invoke imported program with inputs, receive outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If parallel: spawn all branches, await per strategy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If loop: evaluate condition, execute body, repeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If try: execute try, catch on error, always finally（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If choice/if: evaluate condition, execute matching branch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If do block: invoke block with arguments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  6. Handle errors according to try/catch or propagate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  7. Collect all output bindings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  8. Return outputs to caller (or final result if no outputs declared)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Implementation Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Task Tool Usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Always use Task for session execution:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  description: "OpenProse session",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "<session prompt with context>",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  subagent_type: "general-purpose",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: "<optional model override>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
})（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Parallel Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Make multiple Task calls in a single response for true concurrency:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
// In one response, call all three:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({ prompt: "A" })（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({ prompt: "B" })（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Task({ prompt: "C" })（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Context Serialization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When passing context to sessions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefix with clear labels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep relevant information（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Summarize if very long（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Maintain semantic meaning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Summary（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The OpenProse VM:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Imports** programs from `p.prose.md` via `use` statements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Binds** inputs from caller to program variables（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Parses** the program structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Collects** definitions (agents, blocks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Executes** statements sequentially（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Spawns** sessions via Task tool（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **Resumes** persistent agents with memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
8. **Invokes** imported programs with inputs, receives outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
9. **Coordinates** parallel execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
10. **Evaluates** discretion conditions intelligently（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
11. **Manages** context flow between sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
12. **Handles** errors with try/catch/retry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
13. **Tracks** state in files (`.prose/runs/`) or conversation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
14. **Returns** output bindings to caller（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The language is self-evident by design. When in doubt about syntax, interpret it as natural language structured for unambiguous control flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
