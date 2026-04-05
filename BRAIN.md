# BRAIN (Live Working Memory)

## Current Architecture (v2 — MAS + OpenRouter Primary)

- **Primary LLM Provider:** OpenRouter API (cloud, multi-model routing)
- **Orchestration:** Multi-Agent System (MAS) — autonomous agent lifecycle with AgentOrchestrator
- **Memory:** SuperMemory (RAG + TieredMemory + EpisodicMemory + ChromaDB) — persistent cross-session context
- **Integration:** ClawHub platform connector for skills/tasks marketplace

## Active Components

- **AgentOrchestrator** (`src/mas/orchestrator.py`): manages agent lifecycle, task routing, autonomous loop
- **OpenRouter Client** (`src/openrouter_client.py`): primary cloud inference with rate-limit tracking and retry logic
- **Unified LLM Gateway** (`src/llm_gateway.py`): single entry point `route_llm()` for all inference — SmartModelRouter, TokenBudget, Metrics, Circuit Breaker
- **SmartModelRouter** (`src/ai/inference/router.py`): tier-based routing (fast/balanced/premium/reasoning) per task type — replaces legacy ModelSelector
- **SuperMemory** (`src/supermemory.py`): unified RAG + tiered memory (hot/warm/cold) + episodic recall + SQLite persistence + decay scheduling
- **Multi-Source Parser** (`src/parsers/`): Habr, Reddit, GitHub content ingestion
- **DeepResearch v3** (`src/deep_research.py`): multi-perspective iterative research with adaptive stopping
- **ClawHub integration** (`src/clawhub/`): connector to ClawHub platform API
- **Pipeline Executor** (`src/pipeline_executor.py`): Chain-of-Agents (20 roles across 2 brigades)
- **Safety Stack:** PromptInjectionDefender (5-layer), HallucinationDetector, CodeValidator, AutoRollback

## Recent Changes (2026-03-28 — v12.1-CODING-ENGINE):

- **Coding Engine Upgrade v12.1**: Pipeline roles принудительно используют современные стандарты из KnowledgeStore
- **Knowledge Injection** (`pipeline_utils.py`): `build_role_prompt()` инъектирует \_KNOWLEDGE_INJECTION_CODER для ролей Coder/Executor_Architect/Test_Writer (PY314+Rust2024+TS5.8 директивы) и \_KNOWLEDGE_INJECTION_ARCHITECT для Planner/Architect/Foreman (concurrent.interpreters, Async Traits, --isolatedDeclarations)
- **Knowledge-First RAG** (`pipeline/_state.py`): `recall_memory_context()` автоматически подтягивает знания из KnowledgeStore по ключевым словам (async→PY314+RUST2026, typescript→TS58, код/напиши/рефактор→все теги)
- **Sandbox Modernization** (`tools/dynamic_sandbox.py`): Docker образ обновлён до `python:3.14-slim`, добавлены `node:22-slim` (TypeScript) и `rust:1.85-slim` (Rust), принудительный `edition = "2024"` в Cargo.toml, target es2024 для TS
- **Syntactic Evolution Test** (`tests/test_syntactic_evolution.py`): 28 тестов — верификация Knowledge Injection, Sandbox, Knowledge-First RAG, KnowledgeStore completeness

## Recent Changes (2026-03-28 — v12.0-ASCENDED):

- **Knowledge Ascension v12.0**: Deep ingestion of Python 3.14, Rust 2024 Edition, and TypeScript 5.4–5.8 standards
- **KnowledgeStore** (`src/memory/knowledge_store.py`): Structured knowledge base with **38 entries** — 13 Python 3.14 (PEP 649, 734, 750, 758, 765, 768, 784, asyncio, free-threading) + 10 Rust 2024 (RPIT, unsafe extern, gen keyword, never type, IntoIterator for Box) + **15 TypeScript 5.4–5.8** (NoInfer, Object.groupBy, Inferred Type Predicates, Isolated Declarations, Iterator Helpers, --rewriteRelativeImportExtensions, --erasableSyntaxOnly, Import Attributes, require() of ESM)
- **Enriched Graph-RAG**: `DependencyGraphEngine.get_enriched_context()` auto-injects language-aware knowledge — Python → `PY314`, Rust → `RUST2024`, TypeScript/JavaScript → `TYPESCRIPT_MODERN_58`
- **Skills JSON** (`src/ai/agents/special_skills.json`): **24 best-practice patterns** — `STANDARD_LIBRARY_PY314` (8), `RUST_STABLE_2026` (8), and `TYPESCRIPT_MODERN_58` (8) tags for FeedbackLoopEngine

## Recent Changes (2026-03-25):

- Transitioned to OpenRouter as primary LLM provider (cloud-only architecture)
- Implemented MAS (Multi-Agent System) orchestrator for autonomous agent lifecycle
- Created SuperMemory system (RAG + TieredMemory fusion with cross-session persistence)
- Added ClawHub platform integration module
- Added multi-source parsers: Habr, Reddit, GitHub
- Enhanced DeepResearch v3 with OpenRouter multi-model support
- Updated Dockerfile and docker-compose.yml for new architecture

## Previous State (archived):

- Previously used local inference (removed in cloud-only migration)
- Context Bridge (3-layer: Summary→SQLite→ChromaDB) — archived

## Models (OpenRouter Primary):

- **fast_free:** arcee-ai/trinity-mini:free, stepfun/step-3.5-flash:free
- **balanced:** nvidia/nemotron-3-super-120b-a12b:free
- **premium:** deepseek/deepseek-chat-v3-0324:free, qwen/qwen-2.5-coder-32b-instruct:free
- **reasoning:** deepseek/deepseek-r1:free

## Hardware:

- RTX 5060 Ti 16GB
- SuperMemory persistence: data/supermemory/
