---
name: pipeline-executor
description: Chain-of-Agents pipeline engine that orchestrates multi-role sequential execution with AFlow dynamic chain generation, LATS tree search, Reflexion fallback, SAGE self-evolution, MARCH hallucination control, Counterfactual Credit, and ProRL reward modeling.
metadata:
  openclaw:
    emoji: "⚙️"
    category: ai
---

# Pipeline Executor

Core agent orchestration engine (`src/pipeline/_core.py`).

## Architecture

```
PipelineExecutor
├── AFlow Engine — dynamic chain generation from task intent
├── LATS Engine — Language Agent Tree Search (arXiv:2310.04406)
├── MARCH Protocol — hallucination control
├── Reflexion — failure recovery via self-reflection (arXiv:2303.11366)
├── SAGE Engine — self-evolution from auditor feedback
├── Counterfactual Credit — Shapley-inspired role attribution
├── ProRL Engine — lightweight process reward model
├── ConstitutionalChecker — safety/ethics constraints
├── MAC Constitution — dynamic rule adaptation
├── ReAct Reasoner — thought-action-observation loop
├── SmartModelRouter — model selection per role
├── DynamicSandbox — isolated code execution
├── SuperMemory — recall + trajectory storage
├── ContextBridge — cross-model context transfer (disabled in cloud mode)
└── MCP Clients — OpenClaw + Dmarket tool servers
```

## Default Chains (Brigades)

| Brigade           | Chain                                                                                         | Purpose                       |
| ----------------- | --------------------------------------------------------------------------------------------- | ----------------------------- |
| **Dmarket-Dev**   | Planner → Coder → Auditor                                                                     | Dmarket bot development tasks |
| **OpenClaw-Core** | Planner → Foreman → Executor_Tools → Executor_Architect → Auditor → State_Manager → Archivist | Framework self-improvement    |
| **Research-Ops**  | Researcher → Analyst → Summarizer                                                             | Deep research tasks           |

## Pipeline Roles (20 total)

**Planning**: Planner, Architect, Foreman
**Execution**: Coder, Executor_Architect, Executor_Tools, Executor_Research
**Quality**: Auditor, Test_Writer, Security_Auditor
**Analysis**: Researcher, Analyst, Summarizer
**Management**: State_Manager, Archivist, Risk_Analyst
**Specialized**: Orchestrator, Prompt_Engineer, Data_Engineer, DevOps_Engineer

## Execution Flow

1. **Intent Classification** → SmartModelRouter selects model
2. **AFlow** → generates optimal chain for the task (or uses default)
3. **Semantic Decomposer** → splits complex multi-paragraph tasks
4. **For each role in chain**:
   a. Recall context from SuperMemory
   b. Build system prompt with role-specific instructions
   c. Inject few-shot patterns from `special_skills.json`
   d. LLM inference via OpenRouter (with Reflexion fallback)
   e. MARCH hallucination check
   f. Context compression for next role
5. **Post-pipeline**: SAGE evolution, trajectory storage, credit assignment

## Key Features

- **Cloud-only mode**: `force_cloud=true` disables local models and ContextBridge
- **Adaptive token budget**: adjusts per available GPU memory (or cloud limits)
- **Auto-rollback**: reverts git changes if pipeline produces broken code
- **CodeValidator**: static analysis before committing generated code
- **Non-fatal MCP**: MCP initialization failures don't block pipeline
