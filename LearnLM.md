# 🧠 LearnLM — Роадмап обучения моделей OpenClaw

> **Цель:** дообучить модели бота на своих данных через QLoRA, чтобы они лучше отвечали  
> на задачи DMarket, CS2-торговли и управления ботом.  
> **Железо:** RTX 5060 Ti 16GB · WSL2 Ubuntu · vLLM  
> **Модели:** Qwen2.5-Coder-14B-AWQ (главная) · Qwen2.5-Coder-7B-AWQ (тренировочная)

---

## 📅 ФАЗА 0 — Установка зависимостей (один раз, ~20 минут)

Сделать **один раз** прямо сейчас:

```bash
# Открой WSL и выполни:
wsl bash /mnt/d/openclaw_bot/openclaw_bot/scripts/install_training_deps.sh
```

Проверка что всё установилось:
```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python -c 'import unsloth, trl, peft; print(\"OK — готово к обучению\")'"
```

---

## 📅 ФАЗА 1 — Сбор данных (Недели 1–3)

### Каждый день — 0 минут (автоматически)

Просто **пользуйся ботом как обычно.** Каждый диалог с ботом записывается в лог и станет примером для обучения. Не нужно ничего специально делать — логи пишутся автоматически в `logs/bot_current.log`.

**Чем больше используешь бота → тем лучше обучится модель.**

---

### Каждые 2–3 дня — 5 минут

**Шаг 1.** Собери данные из логов:
```powershell
# В Windows PowerShell (корень проекта):
python scripts/collect_training_data.py
```

Посмотри на вывод:
```
Raw pairs found: 47
After quality filter: 31
Total samples : 31
Avg prompt len: 142 chars
Avg output len: 840 chars
```

**Шаг 2.** Добавь 2–5 примеров вручную (самое важное!).  
Открой файл `data/training/raw_dialogues.jsonl` и допиши хорошие диалоги:

```json
{"instruction": "Найди выгодную сделку на AK-47 Redline", "input": "бюджет $50, дата: сегодня", "output": "AK-47 Redline Field-Tested сейчас стоит $42–48 на DMarket. Рекомендую брать FT float <0.20 — ликвидность выше. Тренд за неделю: +3%. Хороший момент для покупки."}
{"instruction": "Что такое float в CS2 скинах?", "input": "", "output": "Float — это число от 0.0 до 1.0, которое определяет степень износа скина. Чем меньше float, тем лучше внешний вид: 0.0–0.07 = Factory New, 0.07–0.15 = Minimal Wear, 0.15–0.38 = Field-Tested, 0.38–0.45 = Well-Worn, 0.45–1.0 = Battle-Scarred."}
```

**Шаг 3.** Проверь счётчик — нужно накопить **минимум 200 строк** перед первым обучением:
```powershell
(Get-Content data\training\raw_dialogues.jsonl | Measure-Object -Line).Lines
```

---

### Чеклист сбора данных

- [ ] Неделя 1: 50+ примеров в датасете
- [ ] Неделя 2: 150+ примеров
- [ ] Неделя 3: 200+ примеров → **переход к Фазе 2**

---

## 📅 ФАЗА 2 — Первое обучение 7B (Конец недели 2–3, 1 вечер)

### Вечер запуска — 10 минут активных действий + 3–4 часа ожидания

**Шаг 1.** Убедись что бот остановлен (vLLM будет нужен):
```powershell
# Останови бот если запущен — обучение занимает всю VRAM
```

**Шаг 2.** Запусти обучение **вечером** (займёт 3–5 часов, ПК можно не трогать):
```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python \
  /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py \
  --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl \
  --model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ \
  --adapter-name openclaw-7b-v1 \
  --lora-rank 16 --epochs 3"
```

**Шаг 3.** В другом окне WSL — наблюдай за GPU (необязательно, можно оставить и уйти):
```bash
wsl watch -n 5 nvidia-smi
```

Что должен видеть во время обучения:
```
GPU Memory: ~14.5/16GB  (нормально)
GPU Util:   95-100%     (нормально)
Temp:       75-85°C     (нормально)
```

---

### Утром после обучения — 10 минут

**Шаг 4.** Оцени качество адаптера:
```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python \
  /mnt/d/openclaw_bot/openclaw_bot/scripts/eval_lora.py \
  --adapter /mnt/d/lora_adapters/openclaw-7b-v1 \
  --test /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl"
```

Интерпретация результата:
| ROUGE-1 | Что значит | Действие |
|---------|-----------|---------|
| ≥ 0.40 | Отличное качество | Деплоить |
| 0.25–0.39 | Приемлемо | Добавить данных, повторить |
| < 0.25 | Плохо | Нужно больше данных, нужен лучший датасет |

---

## 📅 ФАЗА 3 — Деплой адаптера в бот (Конец недели 3)

### Один раз — 5 минут

Если ROUGE-1 ≥ 0.30, подключи адаптер в бот.  
В Python-консоли или в коде `src/pipeline_executor.py`:

```python
# Проверь что адаптер подгрузится:
await manager.ensure_model_with_lora(
    "Qwen/Qwen2.5-Coder-7B-Instruct-AWQ",
    "openclaw-7b-v1"   # папка в /mnt/d/lora_adapters/
)
```

Или через команду в Telegram боте (если настроена `/admin`):
```
/admin load_lora openclaw-7b-v1
```

**После деплоя — сравни вручную:**
- Задай боту 5–10 типичных вопросов о DMarket
- Сравни ответы дообученной 7B с тем, что было раньше
- Если лучше — оставляй, если хуже — откатывай на базовую 14B

---

## 📅 ФАЗА 4 — Обучение главной модели 14B (Неделя 4–5)

### Ночной запуск — 5 минут настройки + 8–10 часов работы GPU

Запускай **на ночь** — комп будет занят до утра:

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python \
  /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py \
  --model Qwen/Qwen2.5-Coder-14B-Instruct-AWQ \
  --adapter-name openclaw-14b-v1 \
  --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl \
  --lora-rank 16 --epochs 3 \
  --batch-size 1 --grad-accum 16"
```

> ⚠️ `--batch-size 1` обязателен для 14B на 16GB.  
> Увеличь `--grad-accum` до 16, чтобы эффективный батч был тем же.

Утром oцени так же как 7B через `eval_lora.py`.

---

## 📅 ФАЗА 5 — DeepSeek-R1 Research (Месяц 2, по желанию)

DeepSeek-R1-14B-AWQ используется только для команды `/research`.  
Обучать имеет смысл только если накопились примеры исследовательских запросов.

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python \
  /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py \
  --model casperhansen/deepseek-r1-distill-qwen-14b-awq \
  --adapter-name openclaw-research-v1 \
  --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/research_dialogues.jsonl \
  --lora-rank 8 --epochs 2 \
  --batch-size 1 --grad-accum 16"
```

---

## 📋 Недельный чеклист (копируй каждую неделю)

### Неделя ___

**Понедельник:**
- [ ] Пользовался ботом — логи записаны

**Среда:**
- [ ] Запустил `collect_training_data.py`
- [ ] Добавил 3–5 примеров вручную в `data/training/raw_dialogues.jsonl`
- [ ] Текущий размер датасета: ___ строк

**Пятница:**
- [ ] Запустил `collect_training_data.py` снова
- [ ] Проверил размер датасета

**Если датасет ≥ 200 строк — в эту пятницу вечером:**
- [ ] Запустил `train_lora.py --model 7B` (вечером)
- [ ] Утром проверил ROUGE-1 через `eval_lora.py`
- [ ] Задеплоил адаптер если ROUGE-1 ≥ 0.30

---

## 📊 Трекер прогресса

| Дата | Samples | Событие |
|------|---------|---------|
| 2026-03-18 | 0 | Старт. Модели скачаны, скрипты готовы |
| | | |
| | | |
| | | |
| | | |

*(Заполняй каждый раз когда запускаешь collect_training_data.py)*

---

## 🛠 Быстрые команды (шпаргалка)

```powershell
# Собрать логи в датасет
python scripts/collect_training_data.py

# Сколько примеров собрано
(Get-Content data\training\raw_dialogues.jsonl | Measure-Object -Line).Lines

# Установить зависимости для обучения (один раз)
wsl bash /mnt/d/openclaw_bot/openclaw_bot/scripts/install_training_deps.sh

# Обучить 7B (3-5 часов)
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py --model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ --adapter-name openclaw-7b-v1 --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl"

# Обучить 14B (8-10 часов, на ночь)
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py --model Qwen/Qwen2.5-Coder-14B-Instruct-AWQ --adapter-name openclaw-14b-v1 --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl --batch-size 1 --grad-accum 16"

# Оценить адаптер
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python /mnt/d/openclaw_bot/openclaw_bot/scripts/eval_lora.py --adapter /mnt/d/lora_adapters/openclaw-7b-v1 --test /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl"

# Посмотреть скачанные модели
wsl bash -c "ls /mnt/d/vllm_models/hub/"

# Посмотреть сохранённые адаптеры
wsl bash -c "ls /mnt/d/lora_adapters/ 2>/dev/null || echo 'Пока нет адаптеров'"
```

---

## ❓ Частые вопросы

**Q: Бот замедлился — это нормально?**  
A: Да. Обучение занимает всю VRAM. Останови бот на время тренировки.

**Q: Обучение упало с OOM (out of memory)?**  
A: Уменьши `--batch-size` до 1 и/или `--max-seq-len` до 1024.

**Q: ROUGE-1 = 0.10 — что делать?**  
A: Нужно больше данных (хотя бы 500 примеров) и проверить качество ручных примеров.

**Q: Как откатить адаптер если стало хуже?**  
A: ```python await manager.swap_model("Qwen/Qwen2.5-Coder-14B-Instruct-AWQ")``` — загрузит базовую модель без LoRA.

**Q: Можно ли обучать на диалогах на русском?**  
A: Да, Qwen2.5 отлично поддерживает русский язык.

---

## 📌 Текущий статус

- [x] Qwen2.5-Coder-14B-AWQ скачана
- [x] DeepSeek-R1-14B-AWQ скачана
- [x] Qwen2.5-Coder-7B-AWQ скачана ← 🆕
- [x] Gemma-3-12B-AWQ-INT4 скачана ← 🆕
- [x] Скрипты обучения готовы (`train_lora.py`, `eval_lora.py`)
- [x] Сборщик логов готов (`collect_training_data.py`)
- [ ] Зависимости установлены (`install_training_deps.sh`) ← **Сделать сейчас**
- [ ] Датасет 200+ примеров
- [ ] Первый адаптер обучен (openclaw-7b-v1)
- [ ] Адаптер задеплоен в бот
