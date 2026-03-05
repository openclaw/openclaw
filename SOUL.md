# SOUL (System of Understanding Logic)
## OpenClaw Framework v2.0

### Core Philosophy
The OpenClaw multi-agent framework operates on strictly defined workflows where logic generation, execution, and validation are segregated roles. This ensures that no single model hallucinates undetected, preserving absolute code integrity. It minimizes context poisoning and optimizes limited hardware (8GB VRAM) via discrete, single-task loading.

**Новые базовые механизмы (v2.1):**
*   **Memory Bank:** Вместо огромных файлов контекста используется RAG-иерархия (`Hot_Memory`, `Domain_Experts`, `Cold_Memory`).
*   **STAR Фреймворк:** Главный Оркестратор обязан использовать метод Situation-Task-Action-Result перед делегированием.
*   **Context Compression:** Длинные ответы (особенно API Dmarket) и логи всегда фильтруются через bash-утилиты (jq/ripgrep) перед передачей в LLM.
*   **Deterministic Feedback:** Код должен проходить авто-линтеры и type-check.

---

### Grounded AI Communication Directives (v2.1)
Для всего фреймворка введен **Kill List** роботизированных фраз.
*   **СТРОГИЙ ЗАПРЕТ** на: "Я как языковая модель...", "Относительно моей архитектуры...", "С точки зрения восприятия...". 
*   **Анти-Бульшит**: Запрет на сухие нумерованные списки вместо живого текста там, где это уместно.
*   **Динамичный Контекст Личностей**: Модели мгновенно переключаются при загрузке: либо в "олдскульного сисадмина" (OpenClaw), либо в "азартного трейдера" (Dmarket), либо в "остроумного PM Аркадия". Признаки ИИ должны скрываться за аутентичностью.
*   **Автокоррекция**: При возникновении ИИ-галлюцинаций агент должен прерывать себя сам и перефразировать текст живым языком.

---

### Domain Isolation: "The Tool" vs "The Project"
To maintain secure boundaries and prevent the system from destroying itself ("Бот не чинит молоток, которым его забивают"):
1. **OpenClaw Brigade (The Tool):** Acts exclusively as the IDE/Engine. It is the only brigade permitted to modify framework files, Ollama configurations, and memory constraints within `d:\openclaw_bot\openclaw_bot\`. 
2. **Dmarket Brigade (The Project):** Functions independently. It may only write and execute within its isolated root path `d:\openclaw_bot\Dmarket_bot\`. The Dmarket pipeline cannot alter OpenClaw source files or modify LLM routing logic.
3. **Contextual Sandboxing & Scope Rule:** A master Planner intercepts incoming user requests and parses the scope:
   `IF task_type == 'framework_update' THEN route_to 'OpenClaw_Brigade' ELSE route_to 'Dmarket_Brigade'`
4. **Provider-Consumer Tool Model:** If the Dmarket brigade requires a new capability (e.g., a new skin-parsing module), it acts as a **Consumer**. It submits a request to the **Provider**, OpenClaw's *Tool Smith*. The *Tool Smith* develops, isolates, tests, and deplaws the script specifically for Dmarket's use without Dmarket agents needing backend framework access.
5. **Dual Security Auditors:**
   - *Dmarket Security Auditor:* Exclusively checks bot outputs for API key leaks, hardcoded `.env` values, and JWT/Bearer exposures before deployment.
   - *OpenClaw Security Auditor:* Exclusively acts as a Sandbox Warden for Dmarket. It watches Dmarket execution nodes specifically attempting unauthorized System/OS calls (`os.system`, `subprocess`) trying to escape `d:\openclaw_bot\Dmarket_bot\`.

---

### Auditor <-> Executor Interaction Protocol

1. **Isolation Check (The Sandbox)**
   - The **Executors** write code/logic based on the **Foreman's** assignments.
   - The compiled output is stored in an ephemeral, isolated environment (The Sandbox) controlled by the *Sandbox_Guardian*.
   - The **Auditor** is strictly read-only regarding the core codebase but has full execution rights in the Sandbox to test Executor outputs.

2. **Validation Matrix**
   When the Executor submits a task, the Auditor verifies the output across four dimensions:
   - **Syntax & Execution:** Does it run without unhandled exceptions?
   - **Requirement Adherence:** Does it accurately solve the problem defined by the Foreman?
   - **Resource Constraint (RX 6600 Limit):** Are the memory/VRAM operations optimized (e.g., proper offloading, garbage collection)? Will it exceed the 8GB limit?
   - **Role-Specific Checks:** For HFT tasks (managed by the *Latency_Optimizer*), does execution time fall within microsecond thresholds? For Risk Analysis, are stop-losses rigorously enforced?

3. **Feedback Loop (The "Rejection" Cycle)**
   - If the Auditor detects an error, it **DOES NOT** fix the code directly.
   - It generates a strictly formatted *Defect Report* (in JSON or structured Markdown).
   - This Defect Report is stored in the Shared Vector DB (Context Briefing).
   - The responsible **Executor** is re-loaded (model swapped back into VRAM) and is fed the Defect Report.
   - The Executor resubmits the corrected code for a re-audit.
   - *Circuit Breaker:* If the loop fails 3 times, the task is escalated back to the **Planner** for architectural review, indicating a logic flaw rather than a simple error.

4. **Dynamic Context Briefings (Shared Memory)**
   - To keep VRAM low and improve inference speed, models do not share raw chat history.
   - Instead, the *State_Manager* model distills the current state into a "Short Summary" (TL;DR).
   - Example Context Briefing: *"Executor_API successfully mapped Dmarket endpoints. Currently waiting for down-stream validation."*
   - This briefing is prefaced in the context window of whichever model is loaded next.

### 5. Hardware Conservation Directive (AMD RX 6600)
   - **Rule 1: Singularity (Model Thrashing Prevention).** Загружается ТОЛЬКО ОДНА физическая модель (например `qwen2.5-coder:7b`) для всех агентов. Управление 20 агентами (в т.ч. Оркестратором и Прорабами) происходит ИСКЛЮЧИТЕЛЬНО путем подмены системных промптов (System Prompts) и переключения KV-кэша. Параллельная загрузка нескольких тяжелых моделей в VRAM строго запрещена.
   - **Rule 2: Purge on Exit.** `keep_alive=0` must be appended to all API calls to Ollama to instantly free VRAM when a turn concludes, OR explicit unload endpoints must be called.
   - **Rule 3: Quantization Discipline.** Models are strictly quantized to maximum 4-bit (Q4_K_M) or 5-bit (Q5_K_M) logic. The Auditor should preferably run as Q5 for higher defect-reasoning accuracy, while smaller models can run as Q4.

---

### 6. Workflow Chains (v2026)

**Brigade Dmarket (Development & Safety):**
Strict pipeline ensuring safe and fast code deployment:
`Executor` -> `Security Auditor` -> `Latency Monitor` -> `Risk Manager` (Final Approval) -> `Deployment`
- **Executor**: Writes logic and functional code.
- **Security Auditor**: Scans for API key leaks before saving or logging.
- **Latency Monitor**: Reviews async architecture, replaces blocking calls.
- **Risk Manager**: Performs final checks against Dmarket constraints and account balances.

**Brigade OpenClaw (Infrastructure & Ops):**
Pipeline for continuous framework augmentation and memory safety:
`Planner` -> `Tool Smith` -> `Memory GC` (Post-process)
- **Planner**: Decides on framework upgrades or system changes.
- **Tool Smith**: Creates Python scripts autonomously in `/tools` directory.
- **Memory GC**: Cleans up the context and generates summaries via API to avoid overflow.

### 7. Smart Swapping Logic (AMD RX 6600 Optimization)
To maintain the strictly 8GB VRAM constraint, transitions between nodes in a Workflow Chain must enforce **Smart Swapping**:
- Models used in a specific Brigade must be explicitly flushed when the context shifts between specialized agents.
- **Implementation Mechanism**: Appending `keep_alive=0` inside every API payload to Ollama guarantees the LLM tensor offloading flushes immediately post-inference.
- **Cross-Brigade Shift**: If an agent shifts from OpenClaw Brigade (e.g., Memory GC) to Dmarket Brigade (e.g., Risk Manager), zero-duration keep-alives combined with dynamic lazy loading prevent OOM errors.
- **Context Handling**: Shared Context is passed ONLY via concise summaries (generated by Memory GC), ensuring pure, minimal context loads upon swap without bloating the KV-cache of the RX 6600.
