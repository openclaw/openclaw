# Tool Registry

Available tools and capabilities the agent can use.

---

## Active Tools

| Tool | Executor | Status | Risk | Brands |
|------|----------|--------|------|--------|
| Grant Scanner | `grant_executor` | Active (stub) | Low | fulldigital |
| Marketing Analyzer | `marketing_executor` | Active (stub) | Medium | both |
| Content Generator | `content_executor` | Active (stub) | Low | both |
| System Health Check | `system_executor` | Active (stub) | Low | both |
| Daily Guidance | `daily_executor` | Active (stub) | Low | both |
| Sales Pipeline | `sales_executor` | Active (stub) | Low | fulldigital |
| Approval Processor | `approval_executor` | Active | Low | both |

---

## Planned Tools

| Tool | Purpose | Dependencies | Target |
|------|---------|-------------|--------|
| Media Renderer | Video cutdowns via Remotion | Remotion, M1 | Phase 2 |
| Web Researcher | Deep web search and synthesis | Ollama 9b | Phase 2 |
| Email Drafter | Client email composition | GHL | Phase 3 |
| Report Generator | Weekly/monthly report compilation | All data sources | Phase 3 |

---

## External Integrations

| Service | Client | Status | Used by |
|---------|--------|--------|---------|
| GoHighLevel | `packages/integrations/ghl/` | Active | Sales, marketing |
| Stripe | `packages/integrations/stripe/` | Active | Finance |
| Trello | `packages/integrations/trello/` | Active | Project management |
| ManyChat | `packages/integrations/manychat/` | Active | Lead capture |
| Ollama | Local inference | Active | All content/reasoning |
| Candid API | Grant discovery | Configured | GrantOps |
| Submittable | Grant submission | Configured | GrantOps |
| Notion | Knowledge management | Planned | Memory sync |

---

## Adding a New Tool

1. Create an executor class implementing the `StepExecutor` protocol
2. Register it in `prompt_engine/executors.py` → `register_default_executors()`
3. Add a planner method in `prompt_engine/planner.py`
4. Add routing in `prompt_engine/router.py`
5. Update this registry
