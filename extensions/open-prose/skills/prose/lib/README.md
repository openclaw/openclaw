# OpenProse Standard Library（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core programs that ship with OpenProse. Production-quality, well-tested programs for common tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Evaluation & Improvement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Program                  | Description                                                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------------------ | -------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `inspector.prose`        | Post-run analysis for runtime fidelity and task effectiveness  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `vm-improver.prose`      | Analyzes inspections and proposes PRs to improve the VM        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `program-improver.prose` | Analyzes inspections and proposes PRs to improve .prose source |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `cost-analyzer.prose`    | Token usage and cost pattern analysis                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `calibrator.prose`       | Validates light evaluations against deep evaluations           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `error-forensics.prose`  | Root cause analysis for failed runs                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Program                | Description                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------- | ---------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `user-memory.prose`    | Cross-project persistent personal memory |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `project-memory.prose` | Project-scoped institutional memory      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Improvement Loop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The evaluation programs form a recursive improvement cycle:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
┌─────────────────────────────────────────────────────────────┐（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│                                                             │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│   Run Program  ──►  Inspector  ──►  VM Improver ──► PR     │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│        ▲                │                                   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│        │                ▼                                   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│        │         Program Improver ──► PR                    │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│        │                │                                   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│        └────────────────┘                                   │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
│                                                             │（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
└─────────────────────────────────────────────────────────────┘（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Supporting analysis:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **cost-analyzer** — Where does the money go? Optimization opportunities.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **calibrator** — Are cheap evaluations reliable proxies for expensive ones?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **error-forensics** — Why did a run fail? Root cause analysis.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Usage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inspect a completed run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run lib/inspector.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inputs: run_path, depth (light|deep), target (vm|task|all)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Propose VM improvements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run lib/vm-improver.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inputs: inspection_path, prose_repo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Propose program improvements（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run lib/program-improver.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inputs: inspection_path, run_path（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Analyze costs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run lib/cost-analyzer.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inputs: run_path, scope (single|compare|trend)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Validate light vs deep evaluation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run lib/calibrator.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inputs: run_paths, sample_size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Investigate failures（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run lib/error-forensics.prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inputs: run_path, focus (vm|program|context|external)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Memory programs (recommend sqlite+ backend)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run lib/user-memory.prose --backend sqlite+（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inputs: mode (teach|query|reflect), content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
prose run lib/project-memory.prose --backend sqlite+（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Inputs: mode (ingest|query|update|summarize), content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Memory Programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The memory programs use persistent agents to accumulate knowledge:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**user-memory** (`persist: user`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Learns your preferences, decisions, patterns across all projects（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remembers mistakes and lessons learned（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Answers questions from accumulated knowledge（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**project-memory** (`persist: project`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Understands this project's architecture and decisions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tracks why things are the way they are（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Answers questions with project-specific context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Both recommend `--backend sqlite+` for durable persistence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Design Principles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Production-ready** — Tested, documented, handles edge cases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Composable** — Can be imported via `use` in other programs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **User-scoped state** — Cross-project utilities use `persist: user`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Minimal dependencies** — No external services required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Clear contracts** — Well-defined inputs and outputs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Incremental value** — Useful in simple mode, more powerful with depth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
