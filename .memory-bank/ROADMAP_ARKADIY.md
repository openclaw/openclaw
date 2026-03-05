# 🧠 ROADMAP ARKADIY — Главный Оркестратор OpenClaw
> Дата: 2026-03-05 | GPU: AMD RX 6600 (8GB VRAM) | Версия: v2.1

---

## 🔴 Приоритет: КРИТИЧЕСКИЙ

### 1. Anchored Iterative Context Compressor
**Файл:** `memory_gc.py`  
**Проблема:** Наивная суммаризация — один вызов LLM на всю историю. При длинных сессиях теряются критические факты.  
**Решение:** Инкрементальное слияние: persistent summary + delta (новые сообщения) → merged summary.  
**Метрика:** Снижение token count на 40-60% при сохранении >95% критических фактов.  
**Статус:** 🟡 Запланировано

### 2. LLM-based Intent Router  
**Файл:** `main.py` (строки 236-240)  
**Проблема:** Keyword matching (`"buy", "sell", "dmarket"...`) — ломается на синонимах, жаргоне, контексте.  
**Решение:** Intent classifier через qwen2.5:1.5b (0.9GB VRAM) — JSON-ответ с brigade + confidence.  
**Fallback:** Keyword matching при недоступности Ollama.  
**Статус:** 🟡 Запланировано

### 3. Pipeline Executor (Chain-of-Agents)
**Файл:** `pipeline_executor.py` (НОВЫЙ)  
**Проблема:** `handle_prompt()` вызывает только Planner. SOUL.md описывает цепочку Planner→Executor→Auditor, но она не реализована.  
**Решение:** `PipelineExecutor` — последовательный вызов ролей из конфига с передачей compressed context между шагами.  
**Статус:** 🟡 Запланировано

---

## 🟡 Приоритет: ВАЖНЫЙ

### 4. Structured Logging (JSON)
**Проблема:** Текстовые логи не поддаются машинному анализу.  
**Решение:** `structlog` с JSON-форматированием, ротация через `logging.handlers.RotatingFileHandler`.

### 5. Health Monitoring Endpoint
**Проблема:** Нет способа проверить состояние системы программно.  
**Решение:** `/health` endpoint: VRAM usage, queue depth, uptime, model status.

### 6. Hot-Reload Config
**Проблема:** Изменение `openclaw_config.json` требует перезапуска.  
**Решение:** `watchdog` FileSystemEventHandler для автоматической перезагрузки конфига.

---

## 🟢 Приоритет: БЭКЛОГ

### 7. Auto-scaling Context Window
Динамическая подстройка `num_ctx` в зависимости от сложности задачи.

### 8. Multi-modal Input (Images)
Поддержка Telegram-фото через vision-модели (LLaVA).

### 9. Prometheus Metrics Export
Экспорт метрик для Grafana-дашборда.
