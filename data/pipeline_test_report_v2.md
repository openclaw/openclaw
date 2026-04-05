# Отчёт о тестировании пайплайна v2

**Дата:** 04.04.2026  
**Версия пайплайна:** v16.3  
**Тест-скрипт:** `scripts/test_pipeline_direct.py`  
**Среда:** Python 3.14.2, Windows, OpenRouter API (free tier)  
**Основная модель:** `nvidia/nemotron-3-super-120b-a12b:free`

---

## 1. Исправленные баги (7 шт.)

### Баг 1 — `src/websearch_mcp.py`: subprocess import via importlib

**Проблема:** Скрипт запускается как subprocess, поэтому `from src.utils.cache import TTLCache` при стандартном запуске выбрасывал `ModuleNotFoundError`.  
**Исправление:** Заменён прямой импорт на `importlib.util.spec_from_file_location` с загрузкой `cache.py` по абсолютному пути. Добавлен fallback-класс `TTLCache` с in-memory dict при невозможности импорта.  
**Файл:** `src/websearch_mcp.py` строки 60-69

### Баг 2 — `src/code_validator.py`: отсутствующий импорт `taskgroup_gather`

**Проблема:** `NameError: name 'taskgroup_gather' is not defined` на строках 398 и 426 — использовался без импорта.  
**Исправление:** Добавлена строка `from src.utils.async_utils import taskgroup_gather` в раздел импортов.  
**Файл:** `src/code_validator.py`

### Баг 3 — `src/intent_classifier.py`: обращение к `gateway.config` без проверки

**Проблема:** `AttributeError: ... object has no attribute 'config'` при инициализации с нестандартным объектом gateway.  
**Исправление:** Добавлена защитная проверка — `_cfg = gateway.config if hasattr(gateway, "config") else gateway`, все обращения к конфигу переведены через `_cfg.get(...)`.  
**Файл:** `src/intent_classifier.py`

### Баг 4 — `src/llm_gateway.py`: SmartModelRouter проходит по ключам «notes»

**Проблема:** Конфиг `model_router` содержит ключ `"notes"` (строка-описание), который попадал в перебор моделей → попытка сделать LLM-вызов на модель `"notes"`.  
**Исправление:** В цикле SmartModelRouter добавлена проверка `if not isinstance(model_name, str) or "/" not in model_name: continue`.  
**Файл:** `src/llm_gateway.py`  
**Подтверждение:** SmartRouter теперь показывает ровно 6 корректных моделей.

### Баг 5 — `src/pipeline/_core.py`: Self-Healing ложно срабатывает на ключевые слова в кодовых блоках

**Проблема:** Self-Healing модуль искал маркеры ошибок (`error`, `exception`, `traceback`) в полном тексте ответа, включая code fences. Правильный код с примерами exception-handling запускал ненужную регенерацию.  
**Исправление:** Добавлено предварительное удаление code fences с помощью `re.sub(r"```[\s\S]*?```", "", _resp_lower)` перед проверкой маркеров ошибок.  
**Файл:** `src/pipeline/_core.py`

### Баг 6 — `src/pipeline/_core.py`: `_quick_inference` использует захардкоженную модель `llama-3.3-70b`

**Проблема:** `_quick_inference` всегда вызывала `meta-llama/llama-3.3-70b-instruct:free`, которая возвращает HTTP 429 (перегружена), добавляя 3×120s timeout cascade при каждом срабатывании Self-Healing.  
**Исправление:** Заменено на `self.config.get("system", {}).get("model_router", {}).get("general") or "nvidia/nemotron-3-super-120b-a12b:free"` + добавлен `skip_approval=True`.  
**Файл:** `src/pipeline/_core.py`

### Баг 7 — `src/pipeline_utils.py`: Planner генерирует код вместо плана

**Проблема:** Planner-роль в промпте не имела явного запрета на написание кода → генерировал реализации функций вместо плана → Foreman путался, pipeline не двигался.  
**Исправление:** В систем-промпт Planner добавлен блок CRITICAL CONSTRAINT:

```
⛔ ЗАПРЕЩЕНО писать код на любом языке программирования.
⛔ Твой вывод — ТОЛЬКО план действий (пронумерованный список шагов).
✅ Если задача требует кода — опиши ЧТО нужно сделать, но НЕ пиши код.
```

**Файл:** `src/pipeline_utils.py`

### Допбаг (бонус) — `scripts/test_pipeline_direct.py`: неверный порядок аргументов `classify_intent`

**Проблема:** Вызов `classify_intent(prompt, config)` — аргументы перепутаны; сигнатура функции `classify_intent(config, prompt)`.  
**Исправление:** Исправлен порядок аргументов.  
**Файл:** `scripts/test_pipeline_direct.py` строка 145

---

## 2. Результаты тестирования

### Конфигурация тестов

| Тест          | Промпт                                                                     | Категория     | Ожидаемые ключевые слова      |
| ------------- | -------------------------------------------------------------------------- | ------------- | ----------------------------- |
| `simple_code` | Решето Эратосфена на Python с docstring и type hints                       | code          | def, sieve, prime, return     |
| `analysis`    | Плюсы и минусы микросервисов vs монолит для стартапа 5 чел.                | general       | микросервис, монолит, масштаб |
| `multi_task`  | 1) Пузырьковая сортировка 2) Анализ O(n²) 3) Сравнение quicksort/mergesort | code+analysis | bubble, sort, O(n, quicksort  |

### Итоговые результаты

| Тест          | Статус      | Ошибки | Время (мс)           | Длина ответа | Цепочка агентов                                               |
| ------------- | ----------- | ------ | -------------------- | ------------ | ------------------------------------------------------------- |
| `simple_code` | ✅ **PASS** | 0      | 163,014 ms (163 сек) | 6,440 симв.  | Planner → Executor_Tools → Constitutional_Guard               |
| `analysis`    | ✅ **PASS** | 0      | 210,806 ms (211 сек) | 21,989 симв. | Planner → Foreman → Executor_Tools → Constitutional_Guard     |
| `multi_task`  | ✅ **PASS** | 0      | 295,458 ms (295 сек) | 14,862 симв. | Planner → Executor_Architect → Auditor → Constitutional_Guard |

**Итог: 3/3 тестов прошли. Количество ошибок по всем тестам — 0.**

### Детали по тестам

#### Test 1 — `simple_code` (163 сек)

- Цепочка: Planner → Executor_Tools → Constitutional_Guard (AFlow heuristic, ProRL score=1.0)
- Intent: `General` (arcee-ai/trinity-mini вернул пустой ответ → fallback на nemotron → keyword match)
- RAG: активирован (паттерн "напиши"), knowledge_store=48 записей, semantic cross-linking найдено 2 заметки
- ReAct (Executor_Tools): 3 шага; шаг 1 — `list_directory` (неверный инструмент для задачи кода), шаг 2 — аналогично; Constitutional_Guard сформировал итоговый ответ
- Ответ: полный код функции `sieve_of_eratosthenes` с docstring, type hints, примерами и объяснением

#### Test 2 — `analysis` (211 сек)

- Цепочка: Planner → Foreman → Executor_Tools → Constitutional_Guard (AFlow fallback, ProRL score=0.98)
- Intent: `OpenClaw-Core` (arcee-ai пустой → fallback → keyword match на "OpenClaw-Core")
- Foreman: сгенерировал план без JSON → `[warning] No JSON found from Foreman` → re-generation (34 сек)
- ReAct (Executor_Tools): 3 шага; шаг 2 — `web_search` (корректный инструмент для аналитики)
- Ответ: подробная таблица сравнения (9 критериев) + 5 практических рекомендаций, 21,989 симв.

#### Test 3 — `multi_task` (295 сек)

- Цепочка: Planner → Executor_Architect → Auditor (AFlow heuristic, ProRL score=1.0)
- Intent: `General` (arcee-ai пустой → fallback → keyword match)
- Planner: **159,598 мс** (превысил таймаут 120 сек) → re-generation JSON (64,624 мс) = 224 сек для Planner
- Executor_Architect: 29,608 мс — сгенерировал полный код всех функций сортировки + benchmark
- Auditor: 8,999 мс — вернул `AUDIT PASSED`
- Ответ: bubble_sort с флагом, optimized_bubble_sort, quicksort (in-place, randomized pivot), mergesort, benchmark harness; анализ O(n²) и сравнительная таблица

---

## 3. Новые баги, обнаруженные при тестировании (НЕ исправлены)

> Все нижеперечисленные баги зафиксированы как задокументированные. Исправление не проводилось согласно инструкции.

---

### N1 — [КРИТИЧНЫЙ] `qwen/qwen3.6-plus-preview:free` — HTTP 404 на каждом вызове

**Эффект:** Модель снята с OpenRouter. Каждый вызов → 3×404 + circuit breaker → fallback на nemotron.  
**Лог:**

```
[warning] OpenRouter HTTP error attempt=1/3 body='{"error":{"message":"No endpoints found for qwen/qwen3.6-plus-preview:free.","code":404}}'
[warning] Circuit breaker OPEN for model cooldown_sec=60 model=qwen/qwen3.6-plus-preview:free
```

**Влияние:** +30-60 сек overhead на каждый ReAct-шаг; circuit breaker открывается каждую сессию.  
**Компоненты:** `src/llm_gateway.py` (SmartModelRouter role=code → qwen), `src/pipeline/_core.py` (ReAct reasoner)  
**Рекомендация (для следующего этапа):** Заменить `qwen/qwen3.6-plus-preview:free` на активную модель в конфиге `model_router.code`.

---

### N2 — [ВАЖНЫЙ] Planner/Foreman: JSON-гвардия срабатывает на валидные текстовые планы

**Эффект:** Любой текстовый план без JSON-обёртки вызывает принудительную re-generation (+27-64 сек).  
**Лог:**

```
[warning] No JSON found from Planner but action keywords present. Forcing re-generation.
[warning] No JSON found from Foreman but action keywords present. Forcing re-generation.
```

**Наблюдение:** Planner-промпт теперь запрещает код (Баг 7 исправлен), но не требует JSON-формата → модель генерирует нумерованный список → детектор JSON не находит JSON → re-generation. Re-generation всегда добавляет `[Correction]: { ... }` JSON-блок → Handoff → ReAct.  
**Компоненты:** `src/pipeline/_core.py` (JSON detection, строка ~380-420)  
**Рекомендация:** Доработать детектор — принимать нумерованный текстовый план как валидный без JSON re-generation.

---

### N3 — [ВАЖНЫЙ] ReAct выбирает инструмент `list_directory` для задач на написание кода

**Эффект:** Для Test 1 (напиши функцию Python) ReAct на шагах 1-2 выполнял `list_directory` вместо написания кода.  
**Лог:**

```
[info] react_step action= step=1 thought=
[info] react_step action=list_directory step=2 thought=...
```

**Причина:** qwen (ReAct model) возвращал пустой ответ → fallback на nemotron → nemotron контекстуально путался между ролью кодера и ролью Planner.  
**Прямая связь:** баг N1 (qwen мёртв) приводит к N3 (неверный инструмент).  
**Компоненты:** `src/pipeline/_core.py` (ReAct reasoning), `src/llm_gateway.py` (fallback на nemotron)

---

### N4 — [ПОЛОЖИТЕЛЬНОЕ НАБЛЮДЕНИЕ] ReAct корректно выбирает `web_search` для аналитических задач

**Эффект:** Для Test 2 (анализ микросервисов) ReAct на шаге 2 правильно выбрал `web_search`.  
**Лог:**

```
[info] react_step action=web_search step=2 thought='Need to gather information about microservice architecture...'
[MCP Execution] Calling tool 'web_search' with args {...}
```

**Вывод:** Task-dependent инструментальная логика работает корректно для аналитических задач даже при degraded ReAct (qwen → nemotron fallback). Тип задачи контролирует выбор инструмента.

---

### N5 — [СРЕДНИЙ] Constitutional checker: ложные срабатывания типа "Helpfulness VIOLATION"

**Эффект:** Конституциональный чекер выдаёт нарушение даже для ответов, прошедших тест (Test 1 — 6440 симв. правильного кода, Test 2 — 21989 симв. анализа).  
**Лог:**

```
[warning] Constitutional check triggered revision violations=["Helpfulness: VIOLATION: The response only provides a heading and lacks any substantive analysis of pros and cons, so it does not directly address the user's request..."]
```

**Причина:** Конституциональный чекер оценивает Executor_Tools результат (промежуточный step, содержащий только заголовок `"Плюсы и минусы..."`) вместо финального ответа от Constitutional_Guard.  
**Компоненты:** `src/pipeline/_core.py` (конституциональная проверка)

---

### N6 — [СРЕДНИЙ] MARCH cross-verification всегда завершается неудачей (rate=1.0)

**Эффект:** Финальная кросс-верификация по протоколу MARCH стабильно падает с discrepancy_rate=1.0 во всех 3 тестах.  
**Лог:**

```
[warning] MARCH cross-verification failed discrepancy_rate=1.0 unverified=4/7
[warning] MARCH cross-verification failed discrepancy_rate=1.0 unverified=7
```

**Вывод:** Протокол MARCH broken — либо неверно реализована логика сравнения, либо верификатор сравнивает несовместимые структуры (шаги vs финальный ответ).  
**Компоненты:** `src/pipeline/_core.py` или отдельный MARCH-модуль

---

### N7 — [ВАЖНЫЙ] `arcee-ai/trinity-mini:free` возвращает пустой ответ на каждый вызов

**Эффект:** Intent-классификатор всегда получает пустой ответ от trinity-mini → fallback на nemotron → intent определяется по keywords (неточно).  
**Лог:**

```
[warning] OpenRouter returned empty/None content attempt=1/1 model=arcee-ai/trinity-mini:free
[info] Primary model returned empty, retrying with fallback fallback=nvidia/nemotron-3-super-120b-a12b:free
```

**Влияние:** AFlow никогда не получает корректный intent → всегда fallback to static chain (вместо heuristic) при AFlow chain generation; circuit breaker открывается.  
**Компоненты:** `src/intent_classifier.py`, `src/aflow.py` (AFlow chain generation через trinity-mini)  
**Рекомендация:** Заменить `arcee-ai/trinity-mini:free` в конфиге `model_router.intent`.

---

### N8 — [ВАЖНЫЙ] Основная модель: timeout >120 сек на сложных промптах с большим RAG-контекстом

**Эффект:** Test 3, шаг Planner — latency_ms=159,598 (159 сек при таймауте 120 сек). Ответ получен, но после нескольких warnings.  
**Лог:**

```
[warning] Timeout (nvidia/nemotron-3-super-120b-a12b:free) for Planner (120s), attempt 1/3
[info] OpenRouter OK for Planner model=nvidia/nemotron-3-super-120b-a12b:free
[debug] Inference metrics recorded latency_ms=159598 model=nvidia/nemotron-3-super-120b-a12b:free role=Planner
```

**Контекст:** RAG-инъекция (2096 симв. fresh knowledge + 48 entries + semantic cross-links) + max_tokens=2048 для code task = очень большой prompt → длинный TTFT на nemotron free tier.  
**Влияние:** Soft timeout — ответ всё равно получен, но запись `attempt 1/3` вводит в заблуждение и тратит ресурсы на re-gen (64 сек).  
**Рекомендация:** Увеличить таймаут для code-задач до 200+ сек или снизить RAG-контекст для Planner-роли.

---

### N9 — [НИЗКИЙ] MCP `stdio_client`: RuntimeError при завершении процесса

**Эффект:** При завершении test script'а выбрасывается серия `RuntimeError: Attempted to exit cancel scope in a different task than it was entered in` из библиотеки `anyio`.  
**Лог:**

```
RuntimeError: Attempted to exit cancel scope in a different task than it was entered in
an error occurred during closing of asynchronous generator <async_generator object stdio_client at 0x...>
```

**Причина:** `mcp.client.stdio.stdio_client` async generator не завершается корректно при `GeneratorExit` в multithreaded asyncio контексте.  
**Влияние:** Только косметическое — тесты прошли, результаты записаны. Ошибки возникают только при shutdown.  
**Компоненты:** `src/mcp_client.py` (cleanup sequence), зависимость `mcp>=1.x` / `anyio>=4.x`

---

## 4. Сводная таблица новых багов

| ID  | Серьёзность  | Компонент            | Описание                                             | Влияние на тесты                   |
| --- | ------------ | -------------------- | ---------------------------------------------------- | ---------------------------------- |
| N1  | 🔴 Критичный | llm_gateway.py       | qwen/qwen3.6-plus-preview:free — HTTP 404            | +30-60 сек/ReAct-шаг               |
| N2  | 🟡 Важный    | pipeline/\_core.py   | JSON-гвардия Planner/Foreman — ложные срабатывания   | +27-64 сек/pipeline                |
| N3  | 🟡 Важный    | pipeline/\_core.py   | ReAct: list_directory вместо генерации кода          | Неверный инструмент (Test 1)       |
| N4  | 🟢 Позитив   | pipeline/\_core.py   | ReAct корректе web_search для аналитики              | N/A                                |
| N5  | 🟠 Средний   | pipeline/\_core.py   | Constitutional false positive на промежуточных шагах | warning без реального эффекта      |
| N6  | 🟠 Средний   | pipeline/\_core.py   | MARCH cross-verification всегда rate=1.0             | warning без блокировки             |
| N7  | 🟡 Важный    | intent_classifier.py | arcee-ai/trinity-mini:free — всегда пустой ответ     | AFlow всегда fallback chain        |
| N8  | 🟡 Важный    | pipeline/\_core.py   | nemotron: >120 сек на сложных code промптах с RAG    | +1 timeout warning + 64 сек re-gen |
| N9  | 🔵 Низкий    | mcp_client.py        | MCP stdio_client: RuntimeError при shutdown          | Только при завершении              |

---

## 5. Статистика выполнения

### Производительность моделей (из логов)

| Модель                                 | Тип        | Статус           | Средняя задержка                         |
| -------------------------------------- | ---------- | ---------------- | ---------------------------------------- |
| nvidia/nemotron-3-super-120b-a12b:free | Основная   | ✅ Работает      | 7-50 сек (simple); 159 сек (complex+RAG) |
| arcee-ai/trinity-mini:free             | Intent     | ❌ Пустые ответы | N/A                                      |
| qwen/qwen3.6-plus-preview:free         | Code/ReAct | ❌ HTTP 404      | N/A                                      |

### Использование инструментов

- **web_search** — 1 вызов (Test 2, корректный)
- **list_directory** — 3 вызова (Test 1, некорректных для задачи)
- **Consensus gate** — сработал для `web_search` (Test 2, Test 3)

### Overhead от мёртвых моделей

| Модель                                   | Вызовов/сессию | Время на 3× retry | Cooldown |
| ---------------------------------------- | -------------- | ----------------- | -------- |
| arcee-ai/trinity-mini:free               | 2-4            | ~5-15 сек         | 60 сек   |
| qwen/qwen3.6-plus-preview:free (в ReAct) | 3-6            | ~20-40 сек        | 60 сек   |

---

## 6. Заключение

По результатам тестирования после применения всех 7 исправлений:

**✅ Все 3 комплексных теста прошли с нулевым количеством ошибок.**

Основные достижения:

- Устранены все критические ошибки импорта и инициализации (Баги 1-3)
- SmartModelRouter больше не пытается использовать `"notes"` как имя модели (Баг 4)
- Self-Healing не ложно срабатывает на код с примерами исключений (Баг 5)
- `_quick_inference` использует правильную модель без 429-каскадов (Баг 6)
- Planner не генерирует код вместо плана (Баг 7)
- Время выполнения Test 1 улучшилось с ~393 сек до 163 сек (-58%)

Выявленные при тестировании новые баги N1-N9 задокументированы и требуют отдельного цикла исправления. Наиболее критичные для производительности — N1 (qwen HTTP 404) и N7 (trinity-mini пустые ответы), так как оба вызывают обязательный overhead при каждом pipeline run.
