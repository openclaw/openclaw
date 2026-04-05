# 📊 OpenClaw Bot — Pipeline Test Report

**Дата:** 2026-04-04 19:16:42
**Тестов:** 3

## Сводка: 3/3 пройдено

| #   | Тест        | Бригада | Время (мс) | Ответ (символов) | Ошибки | Результат |
| --- | ----------- | ------- | ---------- | ---------------- | ------ | --------- |
| 1   | simple_code | General | 91916      | 12074            | 0      | ✅        |
| 2   | analysis    | General | 334910     | 12063            | 0      | ✅        |
| 3   | multi_task  | General | 305075     | 10150            | 0      | ✅        |

## Детальные результаты

### Тест: `simple_code` (✅)

- **Промпт:** `Напиши функцию на Python, которая находит все простые числа до N с помощью решета Эратосфена. Добавь...`
- **Категория:** code
- **Бригада:** General
- **Цепочка:** н/д
- **Intent:** General
- **Время:** 91916 мс
- **Длина ответа:** 12074 символов
- **Найденные ключевые слова:** def, sieve, prime, return
- **⚠️ Предупреждения:**
  - `Guardrail failed for Auditor (attempt 1/2): Аудитор должен вынести вердикт: pass/fail/partial. Перепиши с чётким вердиктом.`
  - `Guardrail failed for Auditor (attempt 2/2): Аудитор должен вынести вердикт: pass/fail/partial. Перепиши с чётким вердиктом.`
  - `Constitutional check triggered revision`

**Ответ (preview):**

````
{'final_response': '```python\ndef sieve_of_eratosthenes(n: int) -> list[int]:\n    """\n    Return a list of all prime numbers up to and including n using the Sieve of Eratosthenes.\n\n    Parameters\n    ----------\n    n : int\n        The upper bound (inclusive) for searching for primes. Must be >= 2.\n\n    Returns\n    -------\n    list[int]\n        A list containing all prime numbers less than or equal to n.\n\n    Example\n    -------\n    >>> sieve_of_eratosthenes(10)\n    [2, 3, 5, 7]...
````

### Тест: `analysis` (✅)

- **Промпт:** `Проанализируй плюсы и минусы архитектуры микросервисов по сравнению с монолитом для стартапа с 5 раз...`
- **Категория:** general
- **Бригада:** General
- **Цепочка:** н/д
- **Intent:** General
- **Время:** 334910 мс
- **Длина ответа:** 12063 символов
- **Найденные ключевые слова:** микросервис, монолит, масштаб
- **⚠️ Предупреждения:**
  - `Timeout (nvidia/nemotron-3-super-120b-a12b:free) for Planner (204s), attempt 1/3`

**Ответ (preview):**

```
{'final_response': 'AUDIT PASSED', 'brigade': 'OpenClaw-Core', 'chain_executed': ['Planner', 'Foreman', 'Executor_Tools', 'Executor_Architect', 'Auditor'], 'steps': [{'role': 'Planner', 'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'response': '1. Planner: определить критерии сравнения микросервисов и монолита для стартапа с 5 разработчиками (скорость вывода продукта, сложность разработки, операционные издержки, масштабируемость, отказоустойчивость, необходимость DevOps-компетенций).  \n2. ...
```

### Тест: `multi_task` (✅)

- **Промпт:** `1. Напиши функцию сортировки пузырьком на Python

2. Проанализируй её сложность O(n²) и предложи опти...`

- **Категория:** code+analysis
- **Бригада:** General
- **Цепочка:** н/д
- **Intent:** General
- **Время:** 305075 мс
- **Длина ответа:** 10150 символов
- **Найденные ключевые слова:** bubble, sort, O(n, quicksort
- **⚠️ Предупреждения:**
  - `OpenRouter HTTP error`
  - `No JSON found from Planner but action keywords present. Forcing re-generation.`
  - `OpenRouter error`
  - `OpenRouter HTTP error`
  - `Constitutional check triggered revision`

**Ответ (preview):**

````
{'final_response': '**1. Функция сортировки пузырьком на Python**\n\n```python\ndef bubble_sort(arr):\n    """\n    Сортирует список arr на месте методом пузырька.\n    Возвращает отсортированный список (тот же объект, что и входной).\n    """\n    n = len(arr)\n    # Проходим по массиву n-1 раз (последний элемент уже будет на месте)\n    for i in range(n - 1):\n        # Флаг, чтобы обнаружить, что за проход не было обменов\n        swapped = False\n        # После каждого внешнего прохода самы...
````

## 🟡 Все предупреждения

- `[19:04:25]` ChromaDB not installed — RAG disabled. pip install chromadb — {'level': 'warning'}
- `[19:04:25]` ChromaDB not installed — RAG engine disabled. Install with: pip install chromadb — {'level': 'warning'}
- `[19:05:28]` Guardrail failed for Auditor (attempt 1/2): Аудитор должен вынести вердикт: pass/fail/partial. Перепиши с чётким вердиктом. — {'level': 'warning'}
- `[19:05:31]` Guardrail failed for Auditor (attempt 2/2): Аудитор должен вынести вердикт: pass/fail/partial. Перепиши с чётким вердиктом. — {'level': 'warning'}
- `[19:06:00]` Constitutional check triggered revision — {'violations': ['Helpfulness: VIOLATION: does not provide the requested Python function; only indicates intent to read a file.'], 'level': 'warning'}
- `[19:09:33]` Timeout (nvidia/nemotron-3-super-120b-a12b:free) for Planner (204s), attempt 1/3 — {'level': 'warning'}
- `[19:11:36]` OpenRouter HTTP error — {'status': 429, 'model': 'google/gemma-3-4b-it:free', 'attempt': '1/1', 'body': '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"google/gemma-3-4b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"Google AI Studio","is_by', 'level': 'warning'}
- `[19:12:11]` No JSON found from Planner but action keywords present. Forcing re-generation. — {'level': 'warning'}
- `[19:14:14]` OpenRouter error — {'error': '', 'attempt': 0, 'level': 'warning'}
- `[19:14:15]` OpenRouter HTTP error — {'status': 429, 'model': 'qwen/qwen3.6-plus:free', 'attempt': '2/3', 'body': '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"qwen/qwen3.6-plus:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"Alibaba","is_byok":false}},', 'level': 'warning'}
- `[19:16:40]` Constitutional check triggered revision — {'violations': ["Helpfulness: VIOLATION: does not address the user's request for a bubble sort function, its O(n²) analysis,optim"], 'level': 'warning'}

## 📋 Логи (173 строк, последние 200)

```
[19:04:04] INFO     Initializing LLM Gateway...  | {'level': 'info'}
[19:04:04] INFO     SmartModelRouter initialised  | {'models': ['nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3.6-plus:free', 'google/gemma-3-4b-it:free', 'stepfun/step-3.5-flash:free', 'nvidia/nemotron-nano-12b-v2-vl:free', 'z-ai/glm-4.5-air:free'], 'level': 'info'}
[19:04:04] INFO     LLMGateway: SmartModelRouter initialized  | {'models': ['nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3.6-plus:free', 'google/gemma-3-4b-it:free', 'stepfun/step-3.5-flash:free', 'nvidia/nemotron-nano-12b-v2-vl:free', 'z-ai/glm-4.5-air:free'], 'level': 'info'}
[19:04:04] INFO     AdaptiveTokenBudget initialised  | {'default_max_tokens': 8192, 'vram_gb': 16.0, 'level': 'info'}
[19:04:04] INFO     InferenceMetricsCollector initialised  | {'level': 'info'}
[19:04:04] INFO     LLMGateway configured (cloud-only)  | {'openrouter_enabled': True, 'level': 'info'}
[19:04:04] INFO     Initializing PipelineExecutor...  | {'level': 'info'}
[19:04:04] INFO     InferenceMetrics + AdaptiveTokenBudget activated (shared)  | {'level': 'info'}
[19:04:04] INFO     SmartModelRouter: reusing shared instance from LLMGateway  | {'level': 'info'}
[19:04:04] INFO     DynamicSandbox initialized  | {'docker_available': False, 'saved_skills': 0, 'level': 'info'}
[19:04:25] INFO     Pipeline MCP clients initialized (openclaw + dmarket contexts)  | {'level': 'info'}
[19:04:25] WARNING  ChromaDB not installed — RAG disabled. pip install chromadb  | {'level': 'warning'}
[19:04:25] INFO     SuperMemory initialized  | {'hot': 0, 'warm': 1, 'cold': 0, 'episodes': 0, 'level': 'info'}
[19:04:25] INFO     SuperMemory initialized and indexed  | {'level': 'info'}
[19:04:25] WARNING  ChromaDB not installed — RAG engine disabled. Install with: pip install chromadb  | {'level': 'warning'}
[19:04:25] INFO     RAGEngine initialized and indexed  | {'level': 'info'}
[19:04:28] INFO     graph_built  | {'files': 4481, 'edges': 759, 'elapsed_sec': 3.54, 'level': 'info'}
[19:04:28] INFO     Graph-RAG engine initialized  | {'files': 4481, 'edges': 759, 'level': 'info'}
[19:04:28] INFO     ============================================================  | {'level': 'info'}
[19:04:28] INFO     TEST: simple_code  | {'category': 'code', 'level': 'info'}
[19:04:28] INFO     PROMPT: Напиши функцию на Python, которая находит все простые числа до N с помощью решета Эратосфена. Добавь docstring и type hi...  | {'level': 'info'}
[19:04:28] INFO     Phase 1: Intent Classification  | {'level': 'info'}
[19:04:28] INFO     Model routed  | {'model': 'google/gemma-3-4b-it:free', 'task_type': 'intent', 'complexity': 'complex', 'score': 9.3, 'level': 'info'}
[19:04:28] DEBUG    SmartRouter selected  | {'model': 'google/gemma-3-4b-it:free', 'task_type': 'intent', 'level': 'debug'}
[19:04:29] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'google/gemma-3-4b-it:free', 'latency_ms': 1155, 'task_type': 'intent', 'response_len': 7, 'level': 'debug'}
[19:04:29] INFO     Intent classified by LLM Gateway  | {'brigade': 'General', 'raw_response': 'General', 'level': 'info'}
[19:04:29] INFO     Intent result  | {'intent': 'General', 'level': 'info'}
[19:04:29] INFO     Phase 2: Pipeline Execution  | {'brigade': 'General', 'level': 'info'}
[19:04:29] INFO     Brigade 'General' not configured, remapped to 'OpenClaw-Core'  | {'level': 'info'}
[19:04:29] INFO     AFlow: heuristic chain selected  | {'chain': ['Planner', 'Executor_Architect', 'Auditor'], 'brigade': 'OpenClaw-Core', 'level': 'info'}
[19:04:29] DEBUG    ProRL: rollout evaluated  | {'candidates': 2, 'best_chain': ['Planner', 'Executor_Architect', 'Auditor'], 'best_score': 1.0, 'source': 'heuristic', 'level': 'debug'}
[19:04:29] INFO     ProRL: chain selected  | {'chain': ['Planner', 'Executor_Architect', 'Auditor'], 'source': 'heuristic', 'score': 1.0, 'level': 'info'}
[19:04:29] INFO     Pipeline START: brigade=OpenClaw-Core, chain=Planner → Executor_Architect → Auditor, source=heuristic  | {'level': 'info'}
[19:04:29] DEBUG    Token budget estimated  | {'budget_reason': 'task=code, prompt_tokens≈44', 'max_tokens': 2048, 'level': 'debug'}
[19:04:29] INFO     Token budget estimated  | {'max_tokens': 2048, 'reason': 'task=code, prompt_tokens≈44', 'level': 'info'}
[19:04:29] DEBUG    RAG classifier: REQUIRED (pattern match)  | {'pattern': '\\b(напиши|написать|создай|реализуй|imple', 'level': 'debug'}
[19:04:29] INFO     knowledge_store_built  | {'total_entries': 48, 'py314': 20, 'rust2024': 10, 'ts58': 18, 'level': 'info'}
[19:04:29] INFO     Knowledge-First recall injected  | {'tags': ['TYPESCRIPT_MODERN_58', 'RUST_STABLE_2026', 'STANDARD_LIBRARY_PY314'], 'level': 'info'}
[19:04:29] INFO     Semantic Cross-Linking found Note  | {'note': 'Snippet_2ef8d7f3.md', 'score': 7.0, 'level': 'info'}
[19:04:29] INFO     Semantic Cross-Linking found Note  | {'note': 'Snippet_6979efdb.md', 'score': 7.0, 'level': 'info'}
[19:04:29] INFO     v16.3 fresh knowledge injected  | {'chars': 2096, 'level': 'info'}
[19:04:29] INFO     Recursive Self-Reflection triggered  | {'match': 'Напиши функцию на Python, которая находит все простые числа до N с помощью решета Эратосфена. Добавь docstring и type hints.', 'level': 'info'}
[19:04:29] INFO     Pipeline step 1/3: Planner (nvidia/nemotron-3-super-120b-a12b:free)  | {'level': 'info'}
[19:05:12] INFO     OpenRouter OK for Planner  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:05:12] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 42672, 'role': 'Planner', 'level': 'debug'}
[19:05:13] DEBUG    SLEA-RL: step experience saved  | {'step_id': 'run:1775318713:s0', 'role': 'Planner', 'reward': 0.3, 'level': 'debug'}
[19:05:13] INFO     Recursive Self-Reflection triggered  | {'match': 'Напиши функцию на Python, которая находит все простые числа до N с помощью решета Эратосфена. Добавь docstring и type hints.', 'level': 'info'}
[19:05:13] INFO     Pipeline step 2/3: Executor_Architect (nvidia/nemotron-3-super-120b-a12b:free)  | {'level': 'info'}
[19:05:21] INFO     OpenRouter OK for Executor_Architect  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:05:21] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 8140, 'role': 'Executor_Architect', 'level': 'debug'}
[19:05:21] DEBUG    SLEA-RL: step experience saved  | {'step_id': 'run:1775318721:s1', 'role': 'Executor_Architect', 'reward': 0.7, 'level': 'debug'}
[19:05:21] INFO     Recursive Self-Reflection triggered  | {'match': 'Напиши функцию на Python, которая находит все простые числа до N с помощью решета Эратосфена. Добавь docstring и type hints.', 'level': 'info'}
[19:05:21] INFO     Pipeline step 3/3: Auditor (nvidia/nemotron-3-super-120b-a12b:free)  | {'level': 'info'}
[19:05:28] INFO     OpenRouter OK for Auditor  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:05:28] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 7394, 'role': 'Auditor', 'level': 'debug'}
[19:05:28] WARNING  Guardrail failed for Auditor (attempt 1/2): Аудитор должен вынести вердикт: pass/fail/partial. Перепиши с чётким вердиктом.  | {'level': 'warning'}
[19:05:31] INFO     OpenRouter OK for Auditor  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:05:31] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 2756, 'role': 'Auditor', 'level': 'debug'}
[19:05:31] WARNING  Guardrail failed for Auditor (attempt 2/2): Аудитор должен вынести вердикт: pass/fail/partial. Перепиши с чётким вердиктом.  | {'level': 'warning'}
[19:05:36] INFO     OpenRouter OK for Auditor  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:05:36] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 4755, 'role': 'Auditor', 'level': 'debug'}
[19:05:36] DEBUG    SLEA-RL: step experience saved  | {'step_id': 'run:1775318736:s2', 'role': 'Auditor', 'reward': 0.7, 'level': 'debug'}
[19:05:36] INFO     Model routed  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'task_type': 'general', 'complexity': 'simple', 'score': 6.75, 'level': 'info'}
[19:05:36] DEBUG    SmartRouter selected  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'task_type': 'general', 'level': 'debug'}
[19:05:50] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 13557, 'task_type': 'general', 'response_len': 133, 'level': 'debug'}
[19:05:50] INFO     Model routed  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'task_type': 'general', 'complexity': 'simple', 'score': 7.916, 'level': 'info'}
[19:05:50] DEBUG    SmartRouter selected  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'task_type': 'general', 'level': 'debug'}
[19:06:00] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 10454, 'task_type': 'general', 'response_len': 1073, 'level': 'debug'}
[19:06:00] WARNING  Constitutional check triggered revision  | {'violations': ['Helpfulness: VIOLATION: does not provide the requested Python function; only indicates intent to read a file.'], 'level': 'warning'}
[19:06:00] INFO     MARCH cross-verification passed  | {'rate': 0.0, 'level': 'info'}
[19:06:00] INFO     Recorded learning log to Obsidian  | {'task': 'Напиши функцию на Python, которая находит все простые числа до N с помощью решета Эратосфена. Добавь docstring и type hints.', 'tag': '[Logic]', 'level': 'info'}
[19:06:00] INFO     Dynamic Auto-Tagging saved snippet  | {'snippet_id': 'edb26d02', 'path': 'D:\\openclaw_bot\\openclaw_bot\\.obsidian\\Knowledge\\Snippets\\Snippet_edb26d02.md', 'level': 'info'}
[19:06:00] INFO     Pipeline COMPLETE: brigade=OpenClaw-Core, steps=4  | {'level': 'info'}
[19:06:00] INFO     Pipeline execution completed  | {'response_len': 12074, 'level': 'info'}
[19:06:00] INFO     Result: ✅ PASS  | {'response_len': 12074, 'timing_ms': 91916, 'errors': 0, 'keywords_found': 4, 'keywords_missing': 0, 'level': 'info'}
[19:06:00] INFO     ============================================================  | {'level': 'info'}
[19:06:00] INFO     TEST: analysis  | {'category': 'general', 'level': 'info'}
[19:06:00] INFO     PROMPT: Проанализируй плюсы и минусы архитектуры микросервисов по сравнению с монолитом для стартапа с 5 разработчиками....  | {'level': 'info'}
[19:06:00] INFO     Phase 1: Intent Classification  | {'level': 'info'}
[19:06:00] INFO     Model routed  | {'model': 'google/gemma-3-4b-it:free', 'task_type': 'intent', 'complexity': 'complex', 'score': 10.767, 'level': 'info'}
[19:06:00] DEBUG    SmartRouter selected  | {'model': 'google/gemma-3-4b-it:free', 'task_type': 'intent', 'level': 'debug'}
[19:06:02] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'google/gemma-3-4b-it:free', 'latency_ms': 1518, 'task_type': 'intent', 'response_len': 7, 'level': 'debug'}
[19:06:02] INFO     Intent classified by LLM Gateway  | {'brigade': 'General', 'raw_response': 'General', 'level': 'info'}
[19:06:02] INFO     Intent result  | {'intent': 'General', 'level': 'info'}
[19:06:02] INFO     Phase 2: Pipeline Execution  | {'brigade': 'General', 'level': 'info'}
[19:06:02] INFO     Brigade 'General' not configured, remapped to 'OpenClaw-Core'  | {'level': 'info'}
[19:06:04] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 2738, 'task_type': 'general', 'response_len': 538, 'level': 'debug'}
[19:06:08] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 6499, 'task_type': 'general', 'response_len': 536, 'level': 'debug'}
[19:06:08] INFO     AFlow: fallback to static chain  | {'chain': ['Planner', 'Foreman', 'Executor_Tools', 'Executor_Architect', 'Auditor', 'State_Manager', 'Archivist'], 'brigade': 'OpenClaw-Core', 'level': 'info'}
[19:06:08] DEBUG    ProRL: rollout evaluated  | {'candidates': 2, 'best_chain': ['Planner', 'Foreman', 'Executor_Tools', 'Executor_Architect', 'Auditor'], 'best_score': 0.98, 'source': 'fallback', 'level': 'debug'}
[19:06:08] INFO     ProRL: chain selected  | {'chain': ['Planner', 'Foreman', 'Executor_Tools', 'Executor_Architect', 'Auditor'], 'source': 'fallback', 'score': 0.98, 'level': 'info'}
[19:06:08] INFO     Pipeline START: brigade=OpenClaw-Core, chain=Planner → Foreman → Executor_Tools → Executor_Architect → Auditor, source=fallback  | {'level': 'info'}
[19:06:08] DEBUG    Token budget estimated  | {'budget_reason': 'task=general, prompt_tokens≈44', 'max_tokens': 1024, 'level': 'debug'}
[19:06:08] INFO     Token budget estimated  | {'max_tokens': 1024, 'reason': 'task=general, prompt_tokens≈44', 'level': 'info'}
[19:06:08] INFO     v16.3 fresh knowledge injected  | {'chars': 2096, 'level': 'info'}
[19:06:08] INFO     Pipeline step 1/5: Planner (nvidia/nemotron-3-super-120b-a12b:free)  | {'level': 'info'}
[19:09:33] WARNING  Timeout (nvidia/nemotron-3-super-120b-a12b:free) for Planner (204s), attempt 1/3  | {'level': 'warning'}
[19:10:02] INFO     OpenRouter OK for Planner  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:10:02] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 233705, 'role': 'Planner', 'level': 'debug'}
[19:10:02] DEBUG    SLEA-RL: step experience saved  | {'step_id': 'run:1775319002:s0', 'role': 'Planner', 'reward': 0.7, 'level': 'debug'}
[19:10:02] INFO     Pipeline step 2/5: Foreman (nvidia/nemotron-3-super-120b-a12b:free)  | {'level': 'info'}
[19:10:41] INFO     OpenRouter OK for Foreman  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:10:41] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 39277, 'role': 'Foreman', 'level': 'debug'}
[19:10:42] DEBUG    SLEA-RL: step experience saved  | {'step_id': 'run:1775319042:s1', 'role': 'Foreman', 'reward': 0.7, 'level': 'debug'}
[19:10:42] INFO     Parallel executor batch: ('Executor_Tools', 'Executor_Architect')  | {'level': 'info'}
[19:10:58] INFO     OpenRouter OK for Executor_Architect  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:10:58] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 16075, 'role': 'Executor_Architect', 'level': 'debug'}
[19:11:29] INFO     OpenRouter OK for Executor_Tools  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:11:29] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 46846, 'role': 'Executor_Tools', 'level': 'debug'}
[19:11:29] INFO     Pipeline step 5/5: Auditor (nvidia/nemotron-3-super-120b-a12b:free)  | {'level': 'info'}
[19:11:35] INFO     OpenRouter OK for Auditor  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:11:35] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 6144, 'role': 'Auditor', 'level': 'debug'}
[19:11:35] DEBUG    SLEA-RL: step experience saved  | {'step_id': 'run:1775319095:s4', 'role': 'Auditor', 'reward': 0.7, 'level': 'debug'}
[19:11:35] INFO     MARCH cross-verification passed  | {'rate': 0.0, 'level': 'info'}
[19:11:35] INFO     Recorded learning log to Obsidian  | {'task': 'Проанализируй плюсы и минусы архитектуры микросервисов по сравнению с монолитом для стартапа с 5 разработчиками.', 'tag': '[Logic]', 'level': 'info'}
[19:11:35] INFO     Pipeline COMPLETE: brigade=OpenClaw-Core, steps=5  | {'level': 'info'}
[19:11:35] INFO     Pipeline execution completed  | {'response_len': 12063, 'level': 'info'}
[19:11:35] INFO     Result: ✅ PASS  | {'response_len': 12063, 'timing_ms': 334910, 'errors': 0, 'keywords_found': 3, 'keywords_missing': 0, 'level': 'info'}
[19:11:35] INFO     ============================================================  | {'level': 'info'}
[19:11:35] INFO     TEST: multi_task  | {'category': 'code+analysis', 'level': 'info'}
[19:11:35] INFO     PROMPT: 1. Напиши функцию сортировки пузырьком на Python
2. Проанализируй её сложность O(n²) и предложи оптимизации
3. Сравни с ...  | {'level': 'info'}
[19:11:35] INFO     Phase 1: Intent Classification  | {'level': 'info'}
[19:11:35] INFO     Model routed  | {'model': 'google/gemma-3-4b-it:free', 'task_type': 'intent', 'complexity': 'complex', 'score': 10.466, 'level': 'info'}
[19:11:35] DEBUG    SmartRouter selected  | {'model': 'google/gemma-3-4b-it:free', 'task_type': 'intent', 'level': 'debug'}
[19:11:36] WARNING  OpenRouter HTTP error  | {'status': 429, 'model': 'google/gemma-3-4b-it:free', 'attempt': '1/1', 'body': '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"google/gemma-3-4b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"Google AI Studio","is_by', 'level': 'warning'}
[19:11:36] INFO     Primary model returned empty, retrying with fallback  | {'primary': 'google/gemma-3-4b-it:free', 'fallback': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:11:37] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'google/gemma-3-4b-it:free', 'latency_ms': 2274, 'task_type': 'intent', 'response_len': 61, 'level': 'debug'}
[19:11:37] INFO     Intent classified by keywords  | {'brigade': 'General', 'keyword_class': 'General', 'level': 'info'}
[19:11:37] INFO     Intent result  | {'intent': 'General', 'level': 'info'}
[19:11:37] INFO     Phase 2: Pipeline Execution  | {'brigade': 'General', 'level': 'info'}
[19:11:37] INFO     Brigade 'General' not configured, remapped to 'OpenClaw-Core'  | {'level': 'info'}
[19:11:37] INFO     AFlow: heuristic chain selected  | {'chain': ['Planner', 'Executor_Architect', 'Auditor'], 'brigade': 'OpenClaw-Core', 'level': 'info'}
[19:11:37] DEBUG    ProRL: rollout evaluated  | {'candidates': 2, 'best_chain': ['Planner', 'Executor_Architect', 'Auditor'], 'best_score': 1.0, 'source': 'heuristic', 'level': 'debug'}
[19:11:37] INFO     ProRL: chain selected  | {'chain': ['Planner', 'Executor_Architect', 'Auditor'], 'source': 'heuristic', 'score': 1.0, 'level': 'info'}
[19:11:37] INFO     Pipeline START: brigade=OpenClaw-Core, chain=Planner → Executor_Architect → Auditor, source=heuristic  | {'level': 'info'}
[19:11:37] DEBUG    Token budget estimated  | {'budget_reason': 'task=code, prompt_tokens≈54', 'max_tokens': 2048, 'level': 'debug'}
[19:11:37] INFO     Token budget estimated  | {'max_tokens': 2048, 'reason': 'task=code, prompt_tokens≈54', 'level': 'info'}
[19:11:37] DEBUG    RAG classifier: REQUIRED (pattern match)  | {'pattern': '\\b(напиши|написать|создай|реализуй|imple', 'level': 'debug'}
[19:11:37] INFO     knowledge_store_built  | {'total_entries': 48, 'py314': 20, 'rust2024': 10, 'ts58': 18, 'level': 'info'}
[19:11:37] INFO     Knowledge-First recall injected  | {'tags': ['TYPESCRIPT_MODERN_58', 'RUST_STABLE_2026', 'STANDARD_LIBRARY_PY314'], 'level': 'info'}
[19:11:37] INFO     Semantic Cross-Linking found Note  | {'note': 'Snippet_ab642831.md', 'score': 6.5, 'level': 'info'}
[19:11:37] INFO     Semantic Cross-Linking found Note  | {'note': 'Snippet_dc448013.md', 'score': 6.5, 'level': 'info'}
[19:11:37] INFO     v16.3 fresh knowledge injected  | {'chars': 2096, 'level': 'info'}
[19:11:37] INFO     Recursive Self-Reflection triggered  | {'match': '1. Напиши функцию сортировки пузырьком на Python 2. Проанализируй её сложность O(n²) и предложи оптимизации 3. Сравни с quicksort и mergesort по скорости', 'level': 'info'}
[19:11:37] INFO     Pipeline step 1/3: Planner (nvidia/nemotron-3-super-120b-a12b:free)  | {'level': 'info'}
[19:12:11] INFO     OpenRouter OK for Planner  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'level': 'info'}
[19:12:11] DEBUG    Inference metrics recorded  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 33317, 'role': 'Planner', 'level': 'debug'}
[19:12:11] WARNING  No JSON found from Planner but action keywords present. Forcing re-generation.  | {'level': 'warning'}
[19:12:13] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 2260, 'task_type': 'general', 'response_len': 77, 'level': 'debug'}
[19:12:13] INFO     JSON instructions detected from Planner, executing Handoff to nvidia/nemotron-3-super-120b-a12b:free  | {'level': 'info'}
[19:12:13] INFO     DEBUG: active_mcp is <src.mcp_client.OpenClawMCPClient object at 0x000001E67C478CD0>  | {'level': 'info'}
[19:12:13] INFO     DEBUG: active_mcp tool_route_map keys: ['run_ripgrep', 'run_jq', 'run_yq', 'parse_json_file', 'list_files', 'analyze_python_file', 'scan_dependencies', 'code_metrics', 'run_command', 'web_fetch', 'web_search', 'web_news_search', 'web_search_answers', 'search_memory', 'run_extension', 'export_vault_for_notebooklm', 'export_codebase_for_notebooklm', 'export_bot_for_notebooklm', 'read_file', 'read_text_file', 'read_media_file', 'read_multiple_files', 'write_file', 'edit_file', 'create_directory', 'list_directory', 'list_directory_with_sizes', 'directory_tree', 'move_file', 'search_files', 'get_file_info', 'list_allowed_directories']  | {'level': 'info'}
[19:14:14] WARNING  OpenRouter error  | {'error': '', 'attempt': 0, 'level': 'warning'}
[19:14:15] WARNING  OpenRouter HTTP error  | {'status': 429, 'model': 'qwen/qwen3.6-plus:free', 'attempt': '2/3', 'body': '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"qwen/qwen3.6-plus:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"Alibaba","is_byok":false}},', 'level': 'warning'}
[19:14:28] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'qwen/qwen3.6-plus:free', 'latency_ms': 134775, 'task_type': 'general', 'response_len': 235, 'level': 'debug'}
[19:14:28] INFO     react_step  | {'step': 1, 'action': 'list_directory', 'thought': 'The user wants to list the contents of the directory "d:\\openclaw_bot\\openclaw_bot". I will use the `list_directory` too', 'level': 'info'}
[19:15:47] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'qwen/qwen3.6-plus:free', 'latency_ms': 79538, 'task_type': 'general', 'response_len': 465, 'level': 'debug'}
[19:15:47] INFO     ReAct reasoning succeeded for Executor_Tools  | {'steps': 2, 'level': 'info'}
[19:15:47] INFO     Model routed  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'task_type': 'general', 'complexity': 'simple', 'score': 8.006, 'level': 'info'}
[19:15:47] DEBUG    SmartRouter selected  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'task_type': 'general', 'level': 'debug'}
[19:15:58] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 10860, 'task_type': 'general', 'response_len': 118, 'level': 'debug'}
[19:15:58] INFO     Model routed  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'task_type': 'general', 'complexity': 'simple', 'score': 7.832, 'level': 'info'}
[19:15:58] DEBUG    SmartRouter selected  | {'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'task_type': 'general', 'level': 'debug'}
[19:16:40] DEBUG    LLMGateway call  | {'provider': 'openrouter', 'model': 'nvidia/nemotron-3-super-120b-a12b:free', 'latency_ms': 41992, 'task_type': 'general', 'response_len': 3950, 'level': 'debug'}
[19:16:40] WARNING  Constitutional check triggered revision  | {'violations': ["Helpfulness: VIOLATION: does not address the user's request for a bubble sort function, its O(n²) analysis,optim"], 'level': 'warning'}
[19:16:40] INFO     MARCH cross-verification passed  | {'rate': 0.0, 'level': 'info'}
[19:16:40] INFO     Recorded learning log to Obsidian  | {'task': '1. Напиши функцию сортировки пузырьком на Python 2. Проанализируй её сложность O(n²) и предложи оптимизации 3. Сравни с quicksort и mergesort по скорости', 'tag': '[Logic]', 'level': 'info'}
[19:16:40] INFO     Dynamic Auto-Tagging saved snippet  | {'snippet_id': '7513c8fb', 'path': 'D:\\openclaw_bot\\openclaw_bot\\.obsidian\\Knowledge\\Snippets\\Snippet_7513c8fb.md', 'level': 'info'}
[19:16:40] INFO     Pipeline COMPLETE: brigade=OpenClaw-Core, steps=3  | {'level': 'info'}
[19:16:40] INFO     Pipeline execution completed  | {'response_len': 10150, 'level': 'info'}
[19:16:40] INFO     Result: ✅ PASS  | {'response_len': 10150, 'timing_ms': 305075, 'errors': 0, 'keywords_found': 4, 'keywords_missing': 0, 'level': 'info'}
```
