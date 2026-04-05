# HEARTBEAT (Autonomous Thinking Cycle — MAS Edition)

## Cycle Steps:

1. **READ** `BRAIN.md` to understand current context and active components
2. **OBSERVE** system state:
   - Check OpenRouter API health (rate-limit headers, model availability)
   - Check SuperMemory integrity (hot/warm/cold tier sizes, RAG index freshness)
   - Check ClawHub connection status
   - Monitor agent task queue and MAS orchestrator state
3. **PLAN** next action based on `MEMORY.md` best practices:
   - Route tasks to appropriate agents via MAS orchestrator
   - Select optimal model tier via SmartModelRouter (task_type → model mapping)
   - Decide if SuperMemory context injection is needed
4. **EXECUTE** via MAS orchestrator:
   - AgentOrchestrator dispatches tasks to registered agents
   - Each agent runs its pipeline chain (Planner → Foreman → Executors → Auditor)
   - OpenRouter handles all inference via cloud API
   - Tool calls processed through MCP client (6 servers)
5. **PERSIST** results:
   - SuperMemory stores conversation facts, tool outputs, verified knowledge
   - EpisodicMemory records task trajectories for few-shot retrieval
   - RAG index updated with new documentation/knowledge
6. **UPDATE** `BRAIN.md` with new state, findings, and performance metrics

## Autonomous Mode:

- MAS AgentOrchestrator runs continuous loop (configurable interval)
- Agents self-assign tasks from the global task queue
- SuperMemory provides persistent context across sessions (no cold starts)
- ClawHub polls for new external tasks/skills periodically
