# UX Refactoring Report v11.5 — 15 Improvements

**Дата:** 2025-07-22
**Этап:** RESEARCH & UX REFACTORING (v11.5)
**Исследованные источники:** Reflexion (Shinn et al., 2023), Context Engineering (promptingguide.ai), Prompt Chaining, Self-Consistency (Wang et al., 2022), Generated Knowledge Prompting, Brex Prompt Engineering Guide

---

## ✅ РЕАЛИЗОВАНО в этом цикле

### 1. Устранение дублирования ответа в Telegram

**Файл:** `src/handlers/prompt_handler.py` → `_send_response()`
**Проблема:** `archivist.send_summary()` включал полный `llm_response`, дублируя его с основным `status_msg.edit_text()`. Пользователь видел ответ дважды.
**Решение:** Summary теперь содержит только метаданные (pipeline chain, бригада, кол-во ролей, GC stats). Ответ показывается ровно один раз.

### 2. Новый формат вывода: Answer + Spoiler Metadata

**Файл:** `src/handlers/prompt_handler.py`
**Изменение:** Telegram-сообщение теперь содержит:

1. Чистый ответ (без заголовков бригады/pipeline — это метаданные)
2. `<tg-spoiler>` блок внизу: бригада, цепочка, время, шаги, токены, hallucination risk
   **Эффект:** Ответ выглядит чисто и профессионально. Метаданные доступны по клику.

### 3. Инъекция Kill List во ВСЕ роли pipeline

**Файл:** `src/pipeline_utils.py` → `build_role_prompt()`
**Проблема:** Kill List из SOUL.md/IDENTITY.md ("Я как языковая модель...") инжектился только в BRAIN.md → Planners. Executor и Archivist ролям он не доставался — они генерировали роботизированные фразы.
**Решение:** Добавлена `_KILL_LIST` строка-константа, инжектируемая в system prompt ВСЕХ ролей через `build_role_prompt()`.

### 4. IDENTITY.md контекст для Archivist и Planner

**Файл:** `src/pipeline_utils.py` → `build_role_prompt()`
**Проблема:** Archivist форматировал ответы без знания о персонах системы — результат был «сухим».
**Решение:** Для Archivist и Planner ролей инжектируется компактная выжимка из IDENTITY.md (Kill List + персона).

---

## 🔧 РЕКОМЕНДАЦИИ (не реализовано, требуют follow-up)

### 5. Self-Consistency для Auditor (Wang et al., 2022)

**Файл:** `src/pipeline/_core.py` → `_run_single_step()` для Auditor роли
**Идея:** Вместо одного вызова Auditor, генерировать 3 verdict-а параллельно (`asyncio.gather`) с temperature=0.7 и выбирать majority verdict. Повышает надёжность финального качества.
**Сложность:** Средняя. Требует 3x API-вызовов для Auditor-шага. Рекомендуется только для `complexity=complex`.
**Research basis:** Self-Consistency (Wang et al., 2022) — выборка нескольких путей рассуждения повышает точность на 5-20% на reasoning-задачах.

### 6. Episodic Reflexion Memory

**Файл:** `src/pipeline/_reflexion.py` + `src/memory_enhanced.py`
**Идея:** При `verdict=fail` от Auditor, сохранять reflexion (что пошло не так, какое альтернативное действие помогло бы) в `EpisodicMemory` с тегом `reflexion`. При следующих запросах того же типа — recall и инжект в Planner prompt.
**Сложность:** Средняя. EpisodicMemory уже существует. Нужна связка: Auditor reflection → memory.store() → Planner recall.
**Research basis:** Reflexion (Shinn et al., 2023) — агенты, сохраняющие вербальные рефлексии, достигают success rate 97% на AlfWorld за 12 итераций vs. 75% без рефлексий.

### 7. Layered Context Architecture для build_role_prompt()

**Файл:** `src/pipeline_utils.py` → `build_role_prompt()`
**Идея:** Структурировать system prompt по 4 слоям (Context Engineering best practice):

1. **System Layer:** Kill List + persona identity (постоянный)
2. **Task Layer:** STAR фреймворк + конкретная задача (динамический)
3. **Tool Layer:** доступные инструменты (MCP, run_command) — только для ролей с tool access
4. **Memory Layer:** auto-recalled контекст из SuperMemory (динамический)
   **Сложность:** Высокая. Требует рефакторинга в structured prompt builder.

### 8. Dynamic Context Adjustment по сложности

**Файл:** `src/pipeline/_core.py` → `execute()`
**Идея:** SmartModelRouter уже классифицирует complexity (simple/moderate/complex). Использовать это для:

- `simple`: skip Auditor, минимальный system prompt, single-step pipeline
- `moderate`: стандартный pipeline
- `complex`: full chain + Self-Consistency Auditor + expanded memory recall
  **Сложность:** Средняя. Инфраструктура (router, chain grouping) уже есть.

### 9. Generated Knowledge Pre-Prompting

**Файл:** `src/pipeline/_core.py` → перед первым шагом pipeline
**Идея:** Для knowledge-intensive запросов (detected по intent), генерировать знание одним LLM-вызовом ("Сгенерируй 3 ключевых факта о {topic}"), затем инжектить как `[GENERATED KNOWLEDGE]` в основной prompt.
**Сложность:** Низкая. Один дополнительный API-call. Повышает факт accuracy на 20%+ (Liu et al., 2022).
**Когда:** Запросы с intent=knowledge, research, analysis.

### 10. Streaming Progress Bar в Telegram

**Файл:** `src/handlers/prompt_handler.py` → `_handle_prompt_inner()`
**Идея:** Во время pipeline execution обновлять status_msg с визуальным прогрессом:

```
⚙️ Planner ✓ → Foreman ✓ → Executor ⏳ → Auditor ○
[████████░░░░] 67%
```

**Сложность:** Низкая. Callback `update_status` уже передаётся — нужно форматирование. Заменяет текущее "🔄 Pipeline: Executor_Tools (4/6)".

### 11. Fast-Path Enhancement с Confidence Caching

**Файл:** `src/handlers/prompt_handler.py` → `is_fast_path` логика
**Идея:** Кэшировать successful fast-path ответы (hash промпта → ответ) на 30 мин для повторяющихся запросов (время, погода, статус). Проверять перед вызовом pipeline.
**Сложность:** Низкая. LRU-кэш в памяти, TTL=1800s.
**Эффект:** Мгновенный ответ на "который час?" без LLM-вызова.

### 12. Parallel Executor Dispatch Optimization

**Файл:** `src/pipeline/_core.py` → `execute()`, `src/pipeline_utils.py` → `group_chain()`
**Текущее состояние:** `group_chain()` уже группирует последовательные Executor\_ роли для `asyncio.gather()`.
**Идея:** Расширить параллелизм на independent non-Executor roles. Например, если Executor_Tools и Executor_Code не зависят друг от друга — запускать параллельно даже если между ними стоит другой шаг.
**Сложность:** Высокая. Нужен dependency graph анализ цепочки.

### 13. Hallucination Detector Enhancement — Cross-Step Consistency

**Файл:** `src/safety_guardrails.py` → `detect()`
**Текущее состояние:** Детектор проверяет overconfidence, fake references, internal consistency, suspicious numbers.
**Идея:** Добавить cross-step consistency: сравнивать claims в Executor output vs. Archivist output. Если Archivist изменил числа/факты без пометки — flag.
**Сложность:** Средняя. Нужно передавать chain steps results в детектор.

### 14. Adaptive Token Budget per Role

**Файл:** `src/pipeline/_core.py`, `src/pipeline/_state.py`
**Текущее состояние:** `AdaptiveTokenBudget.estimate_budget()` выделяет бюджет на весь pipeline.
**Идея:** Распределять budget PER ROLE: Planner=20%, Foreman=10%, Executors=40%, Archivist=20%, Auditor=10%. Если Planner использовал меньше — перераспределить остаток.
**Сложность:** Средняя. Нужен tracking использованных токенов per step.

### 15. Prompt Chaining с Early-Exit и Confidence Gating

**Файл:** `src/pipeline/_core.py`
**Идея:** После каждого шага проверять confidence из `[УВЕРЕННОСТЬ: X/10]` тега. Если confidence ≥ 9/10 после Executor — skip Auditor (он и так скажет `pass`). Если confidence < 5 — trigger re-execution с другой моделью.
**Сложность:** Средняя. Нужен парсинг confidence из промежуточных ответов.
**Research basis:** Prompt Chaining best practice — early termination reduces latency на 30-40% для простых задач.

---

## Приоритизация

| #   | Improvement                       | Impact                       | Effort | Priority |
| --- | --------------------------------- | ---------------------------- | ------ | -------- |
| 10  | Progress bar в Telegram           | UX ⬆⬆⬆                       | Low    | 🔴 P0    |
| 11  | Fast-path confidence caching      | Latency ⬇⬇⬇                  | Low    | 🔴 P0    |
| 8   | Dynamic context по сложности      | Latency ⬇⬇ Quality ⬆         | Med    | 🟡 P1    |
| 15  | Early-exit confidence gating      | Latency ⬇⬇                   | Med    | 🟡 P1    |
| 6   | Episodic Reflexion memory         | Quality ⬆⬆⬆                  | Med    | 🟡 P1    |
| 5   | Self-Consistency Auditor          | Quality ⬆⬆                   | Med    | 🟢 P2    |
| 9   | Generated Knowledge Pre-Prompting | Quality ⬆⬆                   | Low    | 🟢 P2    |
| 7   | Layered Context Architecture      | Quality ⬆ Maintainability ⬆⬆ | High   | 🟢 P2    |
| 13  | Cross-step hallucination check    | Safety ⬆⬆                    | Med    | 🟢 P2    |
| 14  | Adaptive token budget per role    | Efficiency ⬆                 | Med    | 🔵 P3    |
| 12  | Parallel non-Executor dispatch    | Latency ⬇                    | High   | 🔵 P3    |

---

## Файлы, изменённые в этом цикле

| Файл                                          | Тип изменения                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/handlers/prompt_handler.py`              | ✏️ Удалена дупликация ответа; новый формат вывода (spoiler metadata); `meta_footer` param |
| `src/pipeline_utils.py`                       | ✏️ Kill List injection для всех ролей; IDENTITY.md context для Archivist/Planner          |
| `docs/reports/ux-refactoring-v11.5-report.md` | 🆕 Этот отчёт                                                                             |
