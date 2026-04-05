# 🧠 LearnLM — Полное руководство по обучению моделей OpenClaw

> **Цель:** дообучить модели бота на своих данных через QLoRA + Cloud Distillation,  
> чтобы они лучше отвечали на задачи DMarket, CS2-торговли и управления ботом.  
> **Железо:** RTX 5060 Ti 16GB · WSL2 Ubuntu · vLLM 0.17+  
> **Облако:** OpenRouter API (nemotron-3-super-120b, qwen3.6-plus-preview, step-3.5-flash)  
> **Модели:** Qwen2.5-Coder-14B-AWQ (главная) · Qwen2.5-Coder-7B-AWQ (тренировочная)  
> **Обновлено:** 2026-04-01 — Cloud Distillation, MCP-инструменты, Brigade reasoning traces

---

## Оглавление

1. [Стратегии обучения](#1--стратегии-обучения)
2. [Фаза 0 — Установка зависимостей](#2--фаза-0--установка-зависимостей)
3. [Фаза 1 — Сбор и подготовка данных](#3--фаза-1--сбор-и-подготовка-данных)
4. [Фаза 1.5 — Cloud Distillation Pipeline](#4--фаза-15--cloud-distillation-pipeline) ✨ НОВОЕ
5. [Фаза 2 — Обучение 7B модели](#5--фаза-2--обучение-7b-модели)
6. [Фаза 3 — Деплой адаптера в бот](#6--фаза-3--деплой-адаптера-в-бот)
7. [Фаза 4 — Обучение 14B модели](#7--фаза-4--обучение-14b-модели)
8. [Фаза 5 — DeepSeek-R1 Research](#8--фаза-5--deepseek-r1-research)
9. [Оценка качества (Evaluation)](#9--оценка-качества)
10. [Деплой адаптера в vLLM](#10--деплой-адаптера-в-vllm)
11. [Типичные проблемы и решения](#11--типичные-проблемы-и-решения)
12. [Продвинутые техники](#12--продвинутые-техники)
13. [MCP-инструменты для обучения](#13--mcp-инструменты-для-обучения) ✨ НОВОЕ
14. [Brigade Reasoning Traces](#14--brigade-reasoning-traces) ✨ НОВОЕ
15. [Итеративное улучшение датасета](#15--итеративное-улучшение-датасета)
16. [Шпаргалка команд](#16--шпаргалка-команд)
17. [FAQ](#17--faq)
18. [Текущий статус и трекер](#18--текущий-статус-и-трекер)

---

## 1. 📐 Стратегии обучения

### 1.1 QLoRA (рекомендуемый)

Лучший баланс качества и VRAM. Замораживает основные веса, обучает только low-rank адаптеры.

| Параметр               | Рекомендация                                                    |
| ---------------------- | --------------------------------------------------------------- |
| Rank (r)               | 32–64 (больше = качественнее, но больше VRAM)                   |
| Alpha                  | 2 × rank (64–128)                                               |
| Target modules         | `q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj` |
| Квантизация            | 4-bit NormalFloat (bnb-4bit)                                    |
| Gradient checkpointing | Включить (экономит ~40% VRAM)                                   |

**Плюсы**: Помещается в 16GB VRAM на 14B модели, быстрый (1-4 часа на 200+ сэмплов)  
**Минусы**: Немного ниже качество чем full fine-tune

```
⚠️ AWQ модели НЕЛЬЗЯ дообучать через QLoRA!
   Используйте bnb-4bit варианты (unsloth/Qwen2.5-Coder-14B-Instruct-bnb-4bit)
   Затем деплойте адаптер поверх AWQ модели в vLLM
```

### 1.2 Cloud Distillation (✨ НОВОЕ)

> **Обоснование:** Парсер кодовой базы обнаружил, что `scripts/train_lora.py` — это **не** локальный
> QLoRA-тренер, а полноценный облачный пайплайн дистилляции данных с 6 режимами.
> Это критическое дополнение: теперь можно генерировать и улучшать тренировочные данные
> **без GPU**, используя бесплатные облачные модели через OpenRouter.

Облачная генерация и фильтрация датасета через `train_lora.py` (OpenRouter API).
Не требует GPU — работает на любой машине с интернетом.

| Режим             | Назначение                                     | Вход → Выход                         |
| ----------------- | ---------------------------------------------- | ------------------------------------ |
| **generate**      | Синтетические пары instruction/response        | тема → `synthetic_generated.jsonl`   |
| **improve**       | Улучшение слабых ответов через LLM             | `*.jsonl` → `*_improved.jsonl`       |
| **evaluate**      | Скоринг качества (1-10) и фильтрация           | `*.jsonl` → `*_evaluated.jsonl`      |
| **dpo**           | Генерация пар chosen/rejected для RLHF         | `*.jsonl` → `*_dpo.jsonl`            |
| **backtranslate** | Диверсификация инструкций                      | `*.jsonl` → `*_backtranslated.jsonl` |
| **spin**          | Self-play: модель vs reference, судья выбирает | `*.jsonl` → `*_spin.jsonl`           |

**Зачем?** С 201 сэмплом мы получили ROUGE 0.788–0.797. Чтобы выйти на 0.85+,
нужно 500–1000 сэмплов высокого качества. Cloud Distillation масштабирует датасет
без ручного труда.

**Модели для дистилляции** (из `config/openclaw_config.json`):

- `nvidia/nemotron-3-super-120b-a12b:free` — основная генерация (120B параметров)
- `qwen/qwen3.6-plus-preview:free` — код и инструменты (#3 в программировании)
- `stepfun/step-3.5-flash:free` — исследования и анализ
- `z-ai/glm-4.5-air:free` — агентные задачи

Подробная инструкция — [Фаза 1.5](#4--фаза-15--cloud-distillation-pipeline).

### 1.3 LoRA (без квантизации)

Для моделей 7B и меньше. Полная точность весов + low-rank адаптеры.

### 1.4 Full Fine-Tune

Не рекомендуется для 16GB VRAM. Требует 2-4× GPU с DeepSpeed ZeRO-3.

### Ключевые гиперпараметры

| Параметр               | Маленький датасет (<300) | Большой датасет (>1000) |
| ---------------------- | ------------------------ | ----------------------- |
| Epochs                 | 15–20                    | 3–5                     |
| Learning Rate          | 2e-4                     | 1e-4                    |
| Batch size (effective) | 4–8                      | 16–32                   |
| Warmup ratio           | 0.05–0.1                 | 0.03                    |
| Weight decay           | 0.01                     | 0.01                    |

---

## 2. 📅 Фаза 0 — Установка зависимостей

> Выполни **один раз** (~20 минут) — потом забудь.

### Шаг 0.1 — Проверь WSL2 и CUDA

```bash
# В PowerShell — убедись что WSL видит GPU:
wsl nvidia-smi
```

Ожидаемый вывод:

```
+-----------------------------------------------------------------------------+
| NVIDIA-SMI 560.xx    Driver Version: 560.xx    CUDA Version: 12.4          |
+-----------------------------------------------------------------------------+
| GPU 0: NVIDIA GeForce RTX 5060 Ti    16376MiB                              |
+-----------------------------------------------------------------------------+
```

Если `nvidia-smi` не найдена — установи [CUDA Toolkit для WSL2](https://developer.nvidia.com/cuda-downloads) и перезапусти WSL: `wsl --shutdown`.

### Шаг 0.2 — Python и виртуальное окружение

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python --version && pip --version"
```

Если окружения нет:

```bash
wsl bash -c "python3.11 -m venv /mnt/d/vllm_env && source /mnt/d/vllm_env/bin/activate && pip install --upgrade pip"
```

### Шаг 0.3 — Зависимости для обучения

```bash
wsl bash /mnt/d/openclaw_bot/openclaw_bot/scripts/install_training_deps.sh
```

Что делает скрипт:

```bash
pip install unsloth[cu124]        # Ускоренный QLoRA (в 2x быстрее)
pip install trl>=0.11             # SFTTrainer для LoRA
pip install peft>=0.13            # LoRA адаптеры Hugging Face
pip install datasets>=2.19        # Обработка датасетов
pip install rouge_score           # Метрика ROUGE-1
pip install bitsandbytes>=0.43    # 4-bit квантизация
pip install accelerate            # FSDP/DeepSpeed ускорение
```

> ⚠️ **Unsloth** — ключевая библиотека. Без неё 14B модель не влезет в 16GB.

### Шаг 0.4 — Проверка установки

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python -c 'import unsloth, trl, peft; print(\"OK — готово к обучению\")'"
```

Тест GPU:

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python -c \
  'import torch; print(\"CUDA:\", torch.cuda.is_available()); \
   print(\"GPU:\", torch.cuda.get_device_name(0)); \
   print(\"VRAM:\", round(torch.cuda.get_device_properties(0).total_memory/1e9,1), \"GB\")'"
```

Ожидаемый вывод:

```
CUDA: True
GPU: NVIDIA GeForce RTX 5060 Ti
VRAM: 16.3 GB
```

### Шаг 0.5 — Директории

```bash
wsl bash -c "mkdir -p /mnt/d/lora_adapters && mkdir -p /mnt/d/openclaw_bot/openclaw_bot/data/training"
```

```powershell
New-Item -ItemType Directory -Force -Path "data\training"
New-Item -ItemType Directory -Force -Path "data\eval"
```

### Чеклист Фазы 0

- [ ] `nvidia-smi` работает — GPU видна
- [ ] `python --version` показывает 3.11+
- [ ] `import unsloth, trl, peft` — нет ошибок
- [ ] `torch.cuda.is_available()` = True
- [ ] Директории `data/training/` и `/mnt/d/lora_adapters/` созданы

---

## 3. 📅 Фаза 1 — Сбор и подготовка данных

> Качество датасета определяет **80% результата** обучения.

### 3.1 Автоматический сбор

Просто **пользуйся ботом как обычно.** Логи пишутся автоматически в `logs/bot_current.log`.

### 3.2 Сбор из логов (каждые 2–3 дня, 5 минут)

```powershell
python scripts/collect_training_data.py
```

Quality filter автоматически отфильтровывает:

- Диалоги короче 50 символов
- Ответы типа "ошибка", "недоступно", "не знаю"
- Дублирующиеся запросы
- Служебные сообщения бота

### 3.3 Формат данных

**Формат conversations (ChatML):**

```jsonl
{
  "conversations": [
    {
      "from": "system",
      "value": "Ты — ассистент OpenClaw Bot..."
    },
    {
      "from": "human",
      "value": "Вопрос пользователя"
    },
    {
      "from": "gpt",
      "value": "Ответ бота"
    }
  ]
}
```

**Формат instruction (простой):**

```jsonl
{
  "instruction": "Найди выгодную сделку на AK-47 Redline",
  "input": "бюджет $50",
  "output": "AK-47 Redline FT стоит $42–48..."
}
```

### 3.4 Скрипт конвертации сессий

```python
# scripts/prepare_training_data.py
import json
from pathlib import Path

def sessions_to_training(sessions_dir: str, output: str):
    """Конвертирует логи сессий в тренировочный формат."""
    samples = []
    for f in Path(sessions_dir).glob("*.jsonl"):
        conversation = []
        for line in f.read_text().splitlines():
            msg = json.loads(line)
            role = "human" if msg["role"] == "user" else "gpt"
            conversation.append({"from": role, "value": msg["content"]})
        if len(conversation) >= 2:
            samples.append({"conversations": conversation})

    with open(output, "w") as out:
        for s in samples:
            out.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(f"Подготовлено {len(samples)} сэмплов → {output}")
```

### 3.5 Источники данных

1. **Логи бота** — реальные диалоги из `~/.openclaw/sessions/`
2. **Конфигурация** — как бот выполняет пайплайны (config/)
3. **Тесты** — правильное поведение на конкретных сценариях
4. **Документация** — docs/ (конвертировать в Q&A пары)
5. **Курированные примеры** — `data/training/`

### 3.6 Критерии качества

- **Минимум 200 примеров** для заметного улучшения
- **500-1000 примеров** для хорошего результата
- **Разнообразие**: разные типы задач (код, анализ, ответы)
- **Баланс**: не перегружать одним типом задач
- **Чистка**: удалить дубли, ошибочные ответы, слишком короткие (<20 токенов)
- **Язык**: соблюдать пропорции RU/EN

| Плохой пример                      | Хороший пример                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `"output": "Да, стоит купить"`     | `"output": "Рекомендую купить AK-47 Redline FT при цене ≤$44 — медиана $46, спред 5%, объём 300/сутки"` |
| `"output": "Не знаю"`              | Не включай такие примеры вообще                                                                         |
| `"output": "Error: API timeout"`   | Не включай технические ошибки                                                                           |
| Слишком короткий ответ (< 50 слов) | Ответы 100–500 слов — оптимально                                                                        |

### 3.7 Ручные примеры — добавляй 2–5 штук за сессию

Открой `data/training/raw_dialogues.jsonl` и допиши хорошие диалоги по категориям:

#### Категория 1: Анализ рынка и ценообразование

```json
{"instruction": "Найди выгодную сделку на AK-47 Redline", "input": "бюджет $50, дата: сегодня", "output": "AK-47 Redline Field-Tested сейчас стоит $42–48 на DMarket. Рекомендую брать FT float <0.20 — ликвидность выше. Тренд за неделю: +3%. Хороший момент для покупки."}
{"instruction": "Проверь цену на AWP Asiimov", "input": "состояние: Field-Tested", "output": "AWP Asiimov FT сейчас торгуется в диапазоне $58–72 на DMarket. Медиана: $63. За последние 7 дней цена выросла на +5.2%. Объём торгов: ~180 продаж/сутки. Спред покупки/продажи: ~8%. Рекомендую покупать до $62, продавать от $69."}
{"instruction": "Сравни цены на M4A4 Howl на разных площадках", "input": "", "output": "M4A4 Howl FT: DMarket — $1,840, Steam Market — $2,100 (+14%), Skinport — $1,780 (-3.2%). Лучшая цена для покупки: Skinport. Лучшая для продажи: Steam Market, но комиссия 15% снижает чистую выручку до ~$1,785. Итог: арбитраж DMarket→Steam даёт ~+8% до вычета комиссий."}
{"instruction": "Какой скин AK-47 наиболее ликвидный в диапазоне $20–40?", "input": "", "output": "Топ-3 по ликвидности AK-47 в диапазоне $20–40: 1) AK-47 Redline FT — ~320 продаж/сутки, спред 5%; 2) AK-47 Slate MW — ~210 продаж/сутки, спред 7%; 3) AK-47 Bloodsport FT — ~190 продаж/сутки, спред 8%. Лучший выбор для быстрой продажи: Redline FT."}
{"instruction": "Есть ли тренд роста на ножи Butterfly?", "input": "последние 30 дней", "output": "Butterfly Knife в целом за 30 дней: +12.4%. Лидеры роста: Butterfly Fade (+18%), Butterfly Marble Fade (+15.7%), Butterfly Tiger Tooth (+11.2%). Откат прошёл в неделю 2 (-3.5%), затем восстановление. Текущий тренд восходящий. Хороший момент для удержания позиций."}
{"instruction": "Почему цена на Operation Breakout Weapon Case так резко упала?", "input": "упала с $2.50 до $1.80 за 3 дня", "output": "Вероятная причина: анонс или запуск новой операции, которая переключила внимание покупателей на новые кейсы. Также влияет сезонность — перед крупными CS2-турнирами спрос смещается в сторону «статусных» предметов. Падение 28% за 3 дня — это нормально для старых кейсов при выходе нового контента. Если у тебя они есть, реши: продать сейчас или ждать роста (обычно восстанавливается за 2–4 недели)."}
{"instruction": "Оцени рыночную стоимость моего инвентаря", "input": "AK-47 Redline FT x2, AWP Asiimov BS x1, Glock Fade FN x1", "output": "Оценка по текущим ценам DMarket: AK-47 Redline FT x2 = $44 * 2 = $88; AWP Asiimov BS x1 = $28; Glock Fade FN x1 = $210. Итого инвентарь: ~$326. Ликвидная часть (можно продать быстро): Redline — высоколиквидный, Asiimov BS — средняя ликвидность. Glock Fade продать быстро сложнее, но цена стабильная."}
```

#### Категория 2: Знание скинов и механик CS2

```json
{"instruction": "Что такое float в CS2 скинах?", "input": "", "output": "Float — это число от 0.0 до 1.0, которое определяет степень износа скина. Чем меньше float, тем лучше внешний вид: 0.0–0.07 = Factory New, 0.07–0.15 = Minimal Wear, 0.15–0.38 = Field-Tested, 0.38–0.45 = Well-Worn, 0.45–1.0 = Battle-Scarred."}
{"instruction": "Объясни что такое StatTrak в CS2", "input": "", "output": "StatTrak (ST) — это специальный счётчик на оружии, отображающий количество убийств, сделанных именно этим предметом. Скины с ST стоят в среднем в 1.5–3x дороже обычных. Счётчик сбрасывается при обмене через Steam. ST-версии есть не у всех скинов — только там, где Valve предусмотрела эту опцию при выпуске коллекции."}
{"instruction": "Что значит паттерн на ноже Marble Fade?", "input": "", "output": "Marble Fade — нож с градиентной расцветкой, где каждый экземпляр уникален. Паттерн определяется числом (seed) от 1 до 1000 и влияет на расположение цветов. Самые ценные паттерны: 'Full Fire' (красно-оранжевый без синего) — x2–3 к цене; 'Fire & Ice' (синий+красный без жёлтого) — x2–2.5; 'Gold' (жёлто-оранжевый) — x1.5. Обычный паттерн стоит базовую цену."}
{"instruction": "Как проверить паттерн ножа Fade?", "input": "нож: Butterfly Knife Fade", "output": "1. Открой страницу лота на DMarket или CSFloat. 2. Посмотри поле 'Pattern ID' (или 'Seed'). 3. Для Butterfly Fade ценится высокий % покрытия фиолетовым. 4. Используй csgo-float.com или csfloat.com для детального анализа: там есть визуализация паттерна. 5. 90%+ Fade (почти полное покрытие фиолетом) стоит на 40–80% дороже базового."}
{"instruction": "Что такое Blue Gem на Bayonet Case Hardened?", "input": "", "output": "Blue Gem — редчайший паттерн на Bayonet Case Hardened, где клинок почти полностью покрыт синим металликом (>90% синего). Обычный CH стоит $200–400. Blue Gem (паттерн #321, #387, #664, #670 и др.) может стоить $5,000–50,000+. Синий цвет на ноже — результат закалки металла, его нельзя добавить искусственно. Ценится коллекционерами и является одним из самых дорогих паттернов в CS2."}
{"instruction": "Чем отличается Souvenir предмет от обычного?", "input": "", "output": "Souvenir-предметы выпадают только во время стримов крупных CS2-турниров (Major). Они содержат золотые наклейки команд и игроков, участвовавших в раунде, когда выпал дроп. Souvenir нельзя применить к обычному оружию — это отдельная категория предметов. Цена зависит от турнира, команд и состояния кожи. Souvenir AWP Dragon Lore FN — один из самых дорогих предметов CS2 ($5,000–15,000+)."}
{"instruction": "Что такое nameTag и как он влияет на цену?", "input": "", "output": "Name Tag — предмет за $1.99, который добавляет кастомную надпись на оружие (до 20 символов). На рынке оружие с Name Tag продаётся как обычно — покупатель может его переименовать или убрать (за $0.75 инструментом). Name Tag не влияет на цену в большинстве случаев. Исключение: очень редкие или исторически значимые надписи (например, оружие известного игрока) — могут добавить премию 5–15%."}
{"instruction": "Как работает обмен скинами через Steam Trade?", "input": "", "output": "Steam Trade: оба участника кладут предметы → предложение ждёт 15 минут (можно отменить) → оба принимают → предметы обмениваются мгновенно. После обмена предмет нельзя вернуть через Steam Support. Trade Hold (задержка 15 дней) активируется, если у тебя или партнёра нет мобильного аутентификатора Steam (SMA) или он подключён менее 7 дней. Лайфхак: всегда проверяй профиль партнёра перед обменом высокоценных предметов."}
```

#### Категория 3: Торговые стратегии и арбитраж

```json
{"instruction": "Объясни стратегию buy low sell high для CS2 скинов", "input": "", "output": "Buy Low Sell High (BLSH) — базовая стратегия: покупаешь скин ниже рыночной цены (в момент паники продавцов или при удачном лоте) и продаёшь дороже. Ключевые принципы: 1) Изучи «справедливую цену» скина (медиана за 30 дней). 2) Покупай на 10–15% ниже медианы. 3) Выставляй на 5–8% выше медианы. 4) Не держи позицию дольше 2 недель без роста — деньги «заморожены». Работает лучше на ликвидных скинах ($10–100) с объёмом >100 продаж/сутки."}
{"instruction": "Как использовать арбитраж между DMarket и Steam?", "input": "", "output": "Арбитраж DMarket→Steam: 1) Найди скин, который стоит дешевле на DMarket чем на Steam Market. 2) Купи на DMarket за реальные деньги. 3) Переведи в Steam инвентарь (бесплатно через DMarket). 4) Продай на Steam Market. Важно учесть: Steam берёт 15% комиссии с продажи. Реальная прибыль = (Steam цена × 0.85) - DMarket цена. Минимальный порог арбитража: 18%+ разница в цене. Деньги со Steam можно тратить только внутри Steam (не вывести напрямую)."}
{"instruction": "Что такое флиппинг скинов и как на нём заработать?", "input": "", "output": "Флиппинг — покупка предметов ниже рынка и быстрая перепродажа с прибылью. Алгоритм: 1) Мониторь DMarket в поиске лотов на 10–20% ниже средней цены (бывают из-за срочных продаж). 2) Купи быстро — такие лоты уходят за минуты. 3) Выставь на 5–10% выше. 4) Жди покупателя 1–3 дня. Лучший диапазон для флиппинга: $15–100 (быстро продаётся, хорошая прибыль в абсолюте). Инструменты для поиска: DMarket API, CSFloat Market Tracker."}
{"instruction": "Стоит ли покупать скины перед Major CS2 турниром?", "input": "турнир через 3 недели", "output": "Да, это рабочая стратегия. Исторически скины растут на 5–25% в течение 2 недель до Major. Причины: рост аудитории CS2 → новые покупатели → повышенный спрос. Что покупать: тематические стикеры команд (risk/reward выше всего), Souvenir кейсы прошлых Majоров, популярные оружия в меташ-составах команд. Что не стоит: дешёвые скины <$5 — спред съедает прибыль. Продавать лучше за 2–3 дня до финала, не после — после турнира цены часто откатываются."}
{"instruction": "Как минимизировать риск при торговле дорогими ножами ($500+)?", "input": "", "output": "Правила для дорогих ножей: 1) Всегда проверяй историю предмета через Steam Inventory History или сторонние сервисы — убедись что нет дублирующихся serial, нет следов скама. 2) Торгуй только через платформы с escrow (DMarket, CSFloat) — не через Steam Trade с незнакомцами. 3) Используй FloatDB для проверки паттерна — убедись что продавец не врёт про 'Blue Gem'. 4) Для предметов >$1000: всегда встречайтесь через посредника (middleman) из доверенного трейд-сервера Discord. 5) Не торопись — мошенники создают искусственное давление времени."}
{"instruction": "Объясни pump and dump схему в CS2 торговле", "input": "", "output": "Pump and Dump — манипуляция рынком: группа скупает много одного предмета → создаёт видимость дефицита → цена растёт → неосведомлённые покупатели входят по высокой цене → организаторы продают → цена рушится. Признаки P&D: внезапный рост объёма торгов на малоизвестном предмете, посты в Discord/Telegram «этот скин скоро закроют» или «секретный инсайд». Защита: не покупай скины из-за ажиотажа, проверяй историю цен за 30 дней, доверяй только данным, не слухам."}
```

#### Категория 4: Команды управления ботом

```json
{"instruction": "Как запустить мониторинг цены на конкретный скин?", "input": "скин: AWP Dragon Lore FT", "output": "Используй команду /track AWP Dragon Lore FT. Бот начнёт отслеживать цену на DMarket и уведомит тебя при изменении на ±5% (по умолчанию). Чтобы изменить порог уведомления: /track AWP Dragon Lore FT --threshold 10 (уведомление при изменении на 10%). Активные трекеры смотри через /list_tracks. Остановить отслеживание: /untrack AWP Dragon Lore FT."}
{"instruction": "Что делает команда /research?", "input": "", "output": "Команда /research запускает DeepSeek-R1 модель для глубокого анализа. В отличие от обычных запросов к Qwen2.5, /research задействует модель с цепочкой рассуждений (chain-of-thought), которая думает перед ответом. Используй для: анализа перспективных вложений, оценки рисков сделки, прогнозирования ценовых трендов. Выполняется дольше (~30–60 сек), но ответ значительно детальнее."}
{"instruction": "Как посмотреть историю своих сделок через бота?", "input": "", "output": "Команда /history показывает последние 20 сделок. Параметры: /history --days 30 (за 30 дней), /history --item 'AK-47' (фильтр по названию), /history --profit (только прибыльные сделки). Вывод включает: дату, предмет, цену покупки, цену продажи, прибыль/убыток в $ и %. Экспорт в CSV: /history --export."}
{"instruction": "Как настроить автоматическую покупку по достижении целевой цены?", "input": "хочу купить AWP Asiimov FT если цена упадёт до $55", "output": "Команда: /buy_order AWP Asiimov FT --price 55 --condition lte. Бот будет проверять цену каждые 15 минут. Когда цена достигнет $55 или ниже (lte = less than or equal), придёт уведомление и (если настроен автобай) выполнится покупка. Для автоматической покупки нужны средства на балансе DMarket. Управление ордерами: /orders (список всех активных ордеров), /cancel_order <id> (отменить)."}
{"instruction": "Что означает команда /admin swap_model?", "input": "", "output": "/admin swap_model <model_name> — переключает активную языковую модель бота без перезапуска. Доступные модели: Qwen/Qwen2.5-Coder-14B-Instruct-AWQ (основная), Qwen/Qwen2.5-Coder-7B-Instruct-AWQ (быстрая, меньше VRAM), casperhansen/deepseek-r1-distill-qwen-14b-awq (аналитика). После смены модели все новые запросы идут через неё. Старые диалоги не пересчитываются. Откат на основную: /admin swap_model default."}
{"instruction": "Как проверить статус бота и состояние GPU?", "input": "", "output": "/status — показывает: активная модель, загруженность GPU (%), доступная VRAM, время работы бота (uptime), количество запросов за последний час, задержку последнего запроса к vLLM. Если VRAM > 90% занята — бот может тормозить. Для освобождения памяти: /admin reload_model (выгружает и перезагружает модель, ~30 сек). При ошибках 'CUDA OOM' смени на 7B модель."}
```

#### Категория 5: Инвестиции и портфель

```json
{"instruction": "Как диверсифицировать портфель CS2 скинов на $500?", "input": "", "output": "Рекомендуемое распределение на $500: 40% ($200) — ликвидные скины $20–60 (AK Redline, AWP Asiimov, M4A4 Howl FT) для быстрой ротации; 30% ($150) — ножи в диапазоне $100–200 (Gut Knife Doppler, Falchion Fade) как основа портфеля; 20% ($100) — стикеры и сувениры от крупных турниров (высокий потенциал роста, низкая ликвидность); 10% ($50) — экспериментальные покупки (редкие паттерны, перспективные новинки). Ребалансируй каждые 2–4 недели."}
{"instruction": "Какие предметы CS2 лучше держать долгосрочно (6–12 месяцев)?", "input": "", "output": "Лучшие для долгосрочного удержания: 1) Ножи с редкими паттернами (Blue Gem, Fade 90%+) — дорожают 10–30% в год; 2) Souvenir предметы с Major чемпионами — исторически ценятся; 3) Предметы из закрытых операций (Operation Bravo, Hydra) — тираж ограничен; 4) Sticker Capsules ранних сезонов — редкость растёт быстро без обновлений. Что не стоит держать долго: дешёвые скины <$5 (инфляция и новый контент обесценивают), любые предметы с активными дропами."}
{"instruction": "Стоит ли инвестировать в CS2 кейсы?", "input": "бюджет $200", "output": "Кейсы — консервативная инвестиция. Стратегия: покупай кейсы, которые больше не выдаются (Bravo Case, eSports 2013) — тираж падает, цена растёт исторически на 15–40% в год. Текущие активные кейсы (Fracture, Snakebite) — избегай, они растут медленно пока не уйдут из ротации. На $200: купи 20–30 штук Bravo Case (~$6–8 за кейс) + 50 штук eSports 2013 (~$1.5–2 за кейс). Горизонт: 12–18 месяцев. Риск: Valve может добавить эти кейсы обратно — это обрушит цену."}
{"instruction": "Как рассчитать реальную доходность сделки после всех комиссий?", "input": "купил AK-47 Redline FT за $42, продал за $48 на DMarket", "output": "Расчёт: Цена продажи: $48. Комиссия DMarket с продажи: 5% = $2.40. Чистая выручка: $48 - $2.40 = $45.60. Затраты на покупку: $42. Чистая прибыль: $45.60 - $42 = $3.60. Доходность: $3.60 / $42 = +8.6%. Если деньги были заморожены 2 недели — это 8.6% за 2 недели = ~223% годовых (если повторять). Вывод: отличная сделка. Минимальный порог для флиппинга на DMarket: >5% прибыли после всех комиссий."}
```

#### Категория 6: Технические вопросы и настройка бота

```json
{"instruction": "Почему бот отвечает медленно?", "input": "задержка ответа 30–60 секунд", "output": "Основные причины и решения: 1) 14B модель загружена, VRAM >90% — переключись на 7B: /admin swap_model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ. 2) Длинный контекст диалога (>8000 токенов) — очисти историю: /clear. 3) vLLM перегружен параллельными запросами — проверь /status, подожди. 4) Низкий GPU Compute — проверь что другие задачи не нагружают GPU (закрой игры). 5) Размер генерации слишком большой — добавь в запрос 'кратко' или 'одним абзацем'."}
{"instruction": "Как добавить новую модель в vLLM без перезапуска бота?", "input": "хочу добавить Gemma-3-12B", "output": "1. Скачай модель: wsl bash -c 'source /mnt/d/vllm_env/bin/activate && huggingface-cli download google/gemma-3-12b-instruct --local-dir /mnt/d/vllm_models/hub/gemma-3-12b'. 2. Добавь модель в config/openclaw_config.json в секцию 'models'. 3. Перезагрузи конфиг: /admin reload_config. 4. Активируй: /admin swap_model gemma-3-12b. Примечание: 12B модель требует ~11GB VRAM — убедись что после выгрузки текущей модели есть свободное место."}
{"instruction": "Как настроить уведомления бота в Telegram?", "input": "", "output": "Настройки уведомлений: /notifications on|off — вкл/выкл все уведомления. /notifications price -- вкл только ценовые алерты. /notifications trades — только сделки. /notify_time 09:00-22:00 — уведомления только в указанный период. /notify_threshold 5 — минимальное изменение цены для уведомления (5%). Уведомления приходят только тебе (в личный чат с ботом). Убедись что бот не заблокирован в Telegram — иначе сообщения не дойдут."}
{"instruction": "Что делать если бот перестал отвечать?", "input": "", "output": "Порядок действий: 1) Проверь статус vLLM: wsl bash -c 'curl http://localhost:8000/health' — должно вернуть {\"status\": \"ok\"}. 2) Если vLLM упал — перезапусти: wsl bash /mnt/d/openclaw_bot/openclaw_bot/scripts/start_vllm.sh. 3) Проверь логи: wsl bash -c 'tail -50 /mnt/d/openclaw_bot/openclaw_bot/logs/bot_current.log'. 4) Если CUDA OOM — перезапусти vLLM с 7B моделью. 5) Перезапусти бота целиком: в PowerShell Ctrl+C, затем запусти заново через run_bot.ps1."}
```

### 3.8 Чеклист сбора данных

- [ ] Неделя 1: 50+ примеров
- [ ] Неделя 2: 150+ примеров
- [ ] Неделя 3: 200+ примеров → переход к Фазе 1.5 (Cloud Distillation) или Фазе 2 (локальное обучение)

---

## 4. 📅 Фаза 1.5 — Cloud Distillation Pipeline ✨ НОВОЕ

> **Обоснование:** Парсер обнаружил в `scripts/train_lora.py` полноценный **6-режимный облачный  
> пайплайн дистилляции** данных через OpenRouter API. Это решает главную проблему v1-адаптеров:  
> масштабирование датасета с 201 → 1000+ сэмплов без ручного труда, используя бесплатные  
> модели nemotron-3-super-120b (120B параметров) для генерации и оценки данных.  
> **Не требует GPU** — работает на любой машине с Python + интернет.

### 4.1 Предварительные требования

```bash
# Нужен только OPENROUTER_API_KEY в config/openclaw_config.json
# или переменная окружения:
$env:OPENROUTER_API_KEY = "sk-or-v1-..."
```

### 4.2 Режим 1: Generate — Синтетическая генерация

Облачная 120B модель генерирует пары instruction/response из темы.

```powershell
# Генерация 50 пар на тему CS2-торговли
python scripts/train_lora.py generate --topic "CS2 skin trading strategies and DMarket arbitrage" --count 50 --concurrent 4

# Генерация по всем 8 встроенным темам (по кругу)
python scripts/train_lora.py generate --count 100 --concurrent 4
```

**Встроенные темы:** CS2 trading, Cryptocurrency/DeFi, Python debugging, AI/ML architectures,
DevOps/Docker, Data analysis, Cybersecurity, Financial risk management.

**Выход:** `data/training/synthetic_generated.jsonl`

### 4.3 Режим 2: Improve — Улучшение слабых ответов

LLM переписывает короткие/слабые ответы в развёрнутые и точные.

```powershell
# Улучшить все ответы в датасете
python scripts/train_lora.py improve --dataset data/training/raw_dialogues.jsonl --concurrent 4

# Улучшить только пары со скором ниже 6/10
python scripts/train_lora.py improve --dataset data/training/raw_dialogues.jsonl --min-score 6.0
```

**Выход:** `data/training/raw_dialogues_improved.jsonl`  
Скрипт сравнивает длину: если улучшенный ответ < 50% оригинала — сохраняет оригинал.

### 4.4 Режим 3: Evaluate — Скоринг и фильтрация

LLM оценивает каждую пару по 4 критериям (accuracy, helpfulness, detail, clarity) на 1-10.
Пары ниже порога отсеиваются.

```powershell
# Оценить и оставить только пары с overall ≥ 6.0
python scripts/train_lora.py evaluate --dataset data/training/raw_dialogues.jsonl --threshold 6.0
```

**Выход:** `data/training/raw_dialogues_evaluated.jsonl` + `*_report.json` с статистикой.

### 4.5 Режим 4: DPO — Генерация данных для RLHF

> **Обоснование:** DPO (Direct Preference Optimization) — один из самых эффективных методов  
> улучшения стиля и безопасности модели. `train_lora.py` автоматически генерирует  
> «правдоподобно плохие» ответы (subtly flawed) для каждой инструкции. Это позволяет  
> обучать модель различать хорошие и плохие ответы без ручной разметки.

```powershell
# Генерация DPO-пар из оценённого датасета
python scripts/train_lora.py dpo --dataset data/training/raw_dialogues_evaluated.jsonl --concurrent 4
```

**Формат выхода:** `{prompt, chosen, rejected}` — совместим с TRL `DPOTrainer`.

### 4.6 Режим 5: Backtranslate — Диверсификация инструкций

> **Обоснование:** Модель, обученная на 200 одинаково сформулированных вопросов, плохо  
> обобщает на новые формулировки. Backtranslation генерирует 2-5 **разных** формулировок  
> для каждого ответа, не требуя новых ответов — модель учится узнавать одно и то же  
> знание в разных обёртках.

```powershell
# 3 варианта инструкции для каждого ответа (итого 201*3 = 603 новых пары)
python scripts/train_lora.py backtranslate --dataset data/training/raw_dialogues_evaluated.jsonl --variants 3 --concurrent 4
```

**Выход:** `*_backtranslated.jsonl` (оригиналы + новые варианты).

### 4.7 Режим 6: SPIN — Самоигра с судейством

> **Обоснование:** SPIN (Self-Play Improvement) — модель генерирует собственный ответ на  
> каждый вопрос, затем **модель-судья** сравнивает его с вашим reference-ответом. Если  
> модель уже отвечает лучше — этот пример вам ничему не учит. SPIN отфильтровывает  
> устаревшие/бесполезные сэмплы и заменяет слабые ответы на лучшие.

```powershell
# Self-play: модель vs reference, судья выбирает лучший
python scripts/train_lora.py spin --dataset data/training/raw_dialogues_evaluated.jsonl --concurrent 4
```

Позиция ответов рандомизируется (A/B) для устранения position bias.

### 4.8 Рекомендуемый конвейер дистилляции

```
                        ┌─────────┐
     raw_dialogues.jsonl │ 201 шт. │
                        └────┬────┘
                             │
               ┌─────────────┴───────────────┐
               ▼                             ▼
          ┌──────────┐                 ┌───────────┐
          │ evaluate │ threshold=6.0   │ generate  │ +100-200
          └────┬─────┘                 └─────┬─────┘
               │ ~170 прошло                 │
               ▼                             ▼
          ┌──────────┐                 ┌───────────┐
          │ improve  │                 │ evaluate  │
          └────┬─────┘                 └─────┬─────┘
               │                             │
               └──────────┬──────────────────┘
                          ▼
                   ┌──────────────┐
                   │ backtranslate│ ×3 variants
                   └──────┬───────┘
                          ▼
                    ┌───────────┐
                    │   spin    │ self-play filter
                    └─────┬─────┘
                          ▼
                   ┌──────────────┐
                   │     dpo      │ preference pairs
                   └──────┬───────┘
                          ▼
            🎯 1000+ high-quality samples
               + DPO pairs для RLHF
```

### Чеклист Фазы 1.5

- [ ] `OPENROUTER_API_KEY` настроен в `config/openclaw_config.json`
- [ ] `evaluate` прошёл — отсеяны слабые пары
- [ ] `generate` добавил 100+ синтетических пар
- [ ] `improve` поднял качество ответов
- [ ] `backtranslate` × 3 — диверсификация инструкций
- [ ] `spin` — отфильтрованы устаревшие примеры
- [ ] Итого 500+ качественных пар → переход к Фазе 2

---

## 5. 📅 Фаза 2 — Обучение 7B модели

> Первый «тест системы». Используй QLoRA через Unsloth.

### 4.1 Подготовка (5 минут)

**Останови vLLM** — обучение займёт всю VRAM:

```powershell
Stop-Process -Name "python" -Force
```

Проверь GPU свободна:

```bash
wsl nvidia-smi
# Memory-Usage: ~500MiB / 16376MiB
```

Проверь датасет:

```bash
wsl bash -c "wc -l /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl"
# Должно быть: 200+ строк
```

### 4.2 Скрипт обучения с Unsloth

```python
from unsloth import FastLanguageModel
from trl import SFTTrainer
from transformers import TrainingArguments
from datasets import load_dataset

# 1. Загрузка модели
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen2.5-Coder-7B-Instruct-bnb-4bit",
    max_seq_length=4096,
    load_in_4bit=True,
    dtype=None,
)

# 2. Добавление LoRA адаптеров
model = FastLanguageModel.get_peft_model(
    model,
    r=32,
    lora_alpha=64,
    lora_dropout=0.05,
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
    use_gradient_checkpointing="unsloth",
    random_state=42,
)

# 3. Загрузка датасета
dataset = load_dataset("json", data_files="data/training/train.jsonl", split="train")

# 4. Тренировка
trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    dataset_text_field="text",
    max_seq_length=4096,
    packing=True,
    args=TrainingArguments(
        output_dir="output/openclaw-7b-v2",
        num_train_epochs=15,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        learning_rate=2e-4,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        weight_decay=0.01,
        bf16=True,
        logging_steps=5,
        save_strategy="epoch",
        save_total_limit=3,
        optim="adamw_8bit",
        seed=42,
    ),
)

trainer.train()
model.save_pretrained("output/openclaw-7b-v2")
tokenizer.save_pretrained("output/openclaw-7b-v2")
```

### 4.3 Запуск через CLI

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python \
  /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py \
  --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl \
  --model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ \
  --adapter-name openclaw-7b-v1 \
  --lora-rank 16 --epochs 3"
```

Loss должен уменьшаться: `2.134 → 1.876 → 1.623 ...`

### 4.4 Мониторинг GPU

```bash
wsl watch -n 5 nvidia-smi
# GPU Memory: ~14.5/16GB, GPU Util: 95-100%, Temp: 75-85°C — нормально
```

> ⚠️ Если temp > 90°C дольше 10 минут — проверь вентиляцию корпуса.

### 4.5 При OOM

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python \
  /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py \
  --model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ \
  --adapter-name openclaw-7b-v1 \
  --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl \
  --batch-size 1 --grad-accum 8 --max-seq-len 1024"
```

### Чеклист Фазы 2

- [ ] vLLM остановлен
- [ ] Датасет 200+ строк, JSON валиден
- [ ] Обучение запущено (loss убывает)
- [ ] GPU Temp < 90°C
- [ ] Адаптер сохранён в `/mnt/d/lora_adapters/openclaw-7b-v1`
- [ ] ROUGE-1 оценён

---

## 6. 📅 Фаза 3 — Деплой адаптера в бот

### 6.1 Проверка адаптера (5 минут)

```bash
wsl bash -c "ls -lh /mnt/d/lora_adapters/openclaw-7b-v1/"
```

Нужные файлы: `adapter_config.json`, `adapter_model.safetensors`, `tokenizer_config.json`

### 6.2 Подключение

Через Telegram:

```
/admin load_lora openclaw-7b-v1
/status
```

Должно показать: `Active LoRA: openclaw-7b-v1`

### 6.3 Ручное тестирование (10–15 минут)

Задай **минимум 10 вопросов** из разных категорий:

- [ ] «Сколько стоит AWP Asiimov FT?» — конкретные числа
- [ ] «Какой скин самый ликвидный в $20–50?» — список с объёмами
- [ ] «Что такое StatTrak?» — точное определение
- [ ] «Объясни паттерны на Marble Fade» — структурированный ответ
- [ ] «Как отслеживать цену?» — правильная команда /track

**Оценка:** 7+ из 10 лучше → оставляем адаптер.

### 6.4 Откат если хуже

```
/admin swap_model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ
```

| Симптом                 | Причина                    | Решение                       |
| ----------------------- | -------------------------- | ----------------------------- |
| Галлюцинирует числа     | Переобучение               | Уменьши эпохи, добавь данных  |
| Только темы из датасета | Узкий датасет              | Добавь разнообразных примеров |
| Хуже на общих вопросах  | Катастрофическое забывание | `--lora-rank 8`               |
| Медленнее               | Издержки LoRA ~10%         | Нормально                     |

---

## 7. 📅 Фаза 4 — Обучение 14B модели

> 14B — основная модель. Запускать когда датасет 400+ и 7B уже протестирован.

### 7.1 Запуск (на ночь, 8–10 часов)

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python \
  /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py \
  --model Qwen/Qwen2.5-Coder-14B-Instruct-AWQ \
  --adapter-name openclaw-14b-v1 \
  --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl \
  --lora-rank 16 --epochs 3 \
  --batch-size 1 --grad-accum 16"
```

| Параметр       | 7B        | 14B            | Причина                               |
| -------------- | --------- | -------------- | ------------------------------------- |
| `--batch-size` | 4 (авто)  | **1**          | 14B = ~13GB VRAM, нет места для батча |
| `--grad-accum` | 4 (авто)  | **16**         | Компенсирует batch_size=1             |
| Время          | 3–5 часов | **8–10 часов** | Вдвое больше шагов                    |

### Чеклист Фазы 4 ✅ ВЫПОЛНЕНО (2026-03-20)

- [x] Датасет 201 пример
- [x] Модель: `unsloth/Qwen2.5-Coder-14B-Instruct-bnb-4bit` (bnb-4bit вместо AWQ)
- [x] Обучение: 105 шагов, 15 эпох, ~42 мин, loss 0.459
- [x] ROUGE-1 = **0.788** ✅
- [x] Параметры: rank=32, alpha=64, batch_size=1, grad_accum=16, lr=2e-4, VRAM=13.9GB
- [x] Адаптер: `/mnt/d/lora_adapters/openclaw-14b-v1/` (526 MB)
- [ ] Адаптер задеплоен в продакшн

---

## 8. 📅 Фаза 5 — DeepSeek-R1 Research

> Только для команды `/research`. Обучать при 100+ исследовательских примеров.

### 8.1 Специализированный датасет

Создай `data/training/research_dialogues.jsonl` с развёрнутыми рассуждениями:

```json
{
  "instruction": "Проанализируй перспективы инвестиций в Souvenir предметы от PGL Major Copenhagen 2024",
  "input": "горизонт: 12 месяцев",
  "output": "Анализ: Souvenir предметы от Major Copenhagen 2024 — оцениваю осторожно оптимистично. Ключевые факторы: 1) NaVi выиграли турнир → стикеры с s1mple и Electronic популярны → потенциал роста 30–60% за 12 мес. 2) Текущее предложение: активно продаются, цена ещё не устоялась. 3) Исторический прецедент: Souvenir предметы с Krakow 2017, где выиграла Astralis — выросли в 4–8x за 3 года. 4) Риски: провал CS2 как игры, выход следующего Major с популярными командами. Вывод: вложить 15–20% портфеля в Souvenir AWP/AK с NaVi стикерами, горизонт 18+ месяцев."
}
```

### 8.2 Запуск

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python \
  /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py \
  --model casperhansen/deepseek-r1-distill-qwen-14b-awq \
  --adapter-name openclaw-research-v1 \
  --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/research_dialogues.jsonl \
  --lora-rank 8 --epochs 2 \
  --batch-size 1 --grad-accum 16"
```

**Почему `--lora-rank 8`?** DeepSeek-R1 уже умеет рассуждать — меньшее вмешательство = сохраняем reasoning.

### Чеклист Фазы 5 ✅ ВЫПОЛНЕНО (2026-03-20)

- [x] Модель: `unsloth/DeepSeek-R1-Distill-Qwen-14B-bnb-4bit`
- [x] Обучение: 105 шагов, 15 эпох, ~42 мин, loss 0.464
- [x] ROUGE-1 = **0.797** — лучший результат ✅
- [x] Адаптер: `/mnt/d/lora_adapters/openclaw-deepseek-r1-v1/` (526 MB)
- [ ] Создание research-датасета 100+ примеров
- [ ] Адаптер задеплоен для `/research`

---

## 9. 📊 Оценка качества

### 9.1 Метрики

| Метрика        | Описание            | Целевое значение     |
| -------------- | ------------------- | -------------------- |
| **Loss**       | Потери при обучении | < 0.5 (на валидации) |
| **ROUGE-1**    | Совпадение ответов  | > 0.75               |
| **ROUGE-L**    | Длинные совпадения  | > 0.70               |
| **Perplexity** | Уверенность модели  | < 10                 |

### 9.2 Интерпретация ROUGE-1

| ROUGE-1   | Качество  | Действие                               |
| --------- | --------- | -------------------------------------- |
| ≥ 0.40    | Отличное  | Деплоить                               |
| 0.30–0.39 | Хорошее   | Деплоить, параллельно добавлять данные |
| 0.25–0.29 | Приемлемо | Добавить 100+ примеров, повторить      |
| < 0.25    | Плохо     | Больше данных и/или лучший датасет     |

### 9.3 Скрипт оценки

```bash
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python \
  /mnt/d/openclaw_bot/openclaw_bot/scripts/eval_lora.py \
  --adapter /mnt/d/lora_adapters/openclaw-14b-v1 \
  --test /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl"
```

```python
from rouge_score import rouge_scorer

scorer = rouge_scorer.RougeScorer(["rouge1", "rougeL"], use_stemmer=True)

def evaluate(model, tokenizer, test_data):
    results = []
    for sample in test_data:
        question = sample["conversations"][0]["value"]
        expected = sample["conversations"][1]["value"]
        generated = generate(model, tokenizer, question)
        scores = scorer.score(expected, generated)
        results.append({
            "rouge1": scores["rouge1"].fmeasure,
            "rougeL": scores["rougeL"].fmeasure,
        })
    avg_r1 = sum(r["rouge1"] for r in results) / len(results)
    avg_rl = sum(r["rougeL"] for r in results) / len(results)
    print(f"ROUGE-1: {avg_r1:.3f}, ROUGE-L: {avg_rl:.3f}")
```

### 9.4 A/B тестирование

1. Запустить vLLM с базовой моделью → собрать ответы на тест-сет
2. Запустить vLLM с LoRA адаптером → собрать ответы
3. Сравнить ROUGE, человеческая оценка, время ответа

### 9.5 Облачная оценка без GPU ✨ НОВОЕ

> **Обоснование:** Парсер обнаружил в `scripts/eval_lora.py` **dual-backend** архитектуру —  
> помимо локального бэкенда (unsloth+CUDA), поддерживается `--cloud` режим через OpenRouter API.  
> Это позволяет оценивать модели **без GPU/WSL** — полезно для CI, удалённой проверки,  
> или когда GPU занят обучением.

```powershell
# Облачная оценка через OpenRouter (не требует GPU/WSL)
python scripts/eval_lora.py --cloud --test data/training/raw_dialogues.jsonl --samples 30

# Облачная оценка с конкретной моделью-задачей
python scripts/eval_lora.py --cloud --test data/training/raw_dialogues.jsonl --model-task research
```

**Отличия от локальной:**

- Не нужен GPU, WSL, unsloth
- Используются модели из `config/openclaw_config.json` → `model_router`
- Rate-limited (1 req/sec) — медленнее, но стабильнее
- Работает на Windows/macOS/Linux напрямую

### 9.6 Ориентиры по этапам

| Этап            | Датасет | ROUGE-1 (7B) | ROUGE-1 (14B) | Поведение                           |
| --------------- | ------- | ------------ | ------------- | ----------------------------------- |
| Старт (базовая) | 0       | —            | —             | Общие ответы, не знает DMarket      |
| После Фаз 1–2   | 200     | 0.30–0.40    | —             | Базовые термины, реалистичные цены  |
| После Фаз 3–4   | 400     | 0.40–0.50    | 0.38–0.48     | Торговые рекомендации с конкретикой |
| Итерация 2      | 800     | 0.45–0.55    | 0.43–0.53     | Анализ трендов, сравнение площадок  |
| Итерация 3+     | 1500+   | 0.50+        | 0.48+         | Полноценный DMarket-эксперт         |

---

## 10. 🚀 Деплой адаптера в vLLM

### 10.1 Статическая загрузка (при старте)

```bash
python -m vllm.entrypoints.openai.api_server \
    --model Qwen/Qwen2.5-Coder-14B-Instruct-AWQ \
    --enable-lora \
    --lora-modules openclaw-v2=/mnt/d/lora_adapters/openclaw-14b-v2 \
    --max-loras 3
```

### 10.2 Динамическая загрузка (Hot-Swap, без рестарта)

```bash
# Требует VLLM_ALLOW_RUNTIME_LORA_UPDATING=True
curl -X POST http://localhost:8000/v1/load_lora_adapter \
  -H "Content-Type: application/json" \
  -d '{
    "lora_name": "openclaw-v2",
    "lora_path": "/mnt/d/lora_adapters/openclaw-14b-v2"
  }'
```

### 10.3 Использование в API

```python
response = await client.chat.completions.create(
    model="openclaw-v2",  # имя LoRA адаптера
    messages=[...],
)
```

### 10.4 Через бота

```
/admin load_lora openclaw-14b-v1
/status  # -> Active LoRA: openclaw-14b-v1
```

---

## 11. 🔧 Типичные проблемы и решения

### 11.1 Переобучение (Overfitting)

**Симптомы**: training loss падает, validation loss растёт  
**Решения**: уменьшить epochs (15 → 5–8), увеличить dropout (0.05 → 0.1), увеличить датасет, early stopping

### 11.2 Недообучение (Underfitting)

**Симптомы**: loss не падает ниже 1.0  
**Решения**: увеличить rank (32 → 64), увеличить learning rate (2e-4 → 5e-4), увеличить epochs, проверить качество данных

### 11.3 OOM (Out of Memory)

**Симптомы**: CUDA out of memory  
**Решения**: batch_size → 1, max_seq_length → 2048, включить gradient_checkpointing, gradient_accumulation_steps для эффективного batch size

### 11.4 CUDA error: device-side assert triggered

Проблема в датасете — найди некорректную строку:

```bash
wsl bash -c "python3 -c \"import json; [json.loads(l) for i,l in enumerate(open('data/training/raw_dialogues.jsonl')) if print(i) or True]\""
```

### 11.5 Loss не убывает, застрял на 2.0

1. Проверь формат JSON
2. Снизь learning rate: `--lr 1e-5`
3. Увеличь разнообразие примеров
4. Проверь совместимость версий peft

---

## 12. 🧬 Продвинутые техники

### 12.1 DPO (Direct Preference Optimization)

Обучение на парах "хороший/плохой ответ". Генерируй DPO-пары автоматически через Cloud Distillation (см. [Фаза 1.5, режим dpo](#45-режим-4-dpo--генерация-данных-для-rlhf)).

```jsonl
{
  "prompt": "Вопрос",
  "chosen": "Хороший ответ",
  "rejected": "Плохой ответ"
}
```

### 12.2 Multi-task Training

Обучение на нескольких задачах одновременно (код + анализ + ответы).
Добавь системный промпт с ролью в каждый пример.

### 12.3 Curriculum Learning

Начинай с простых примеров → постепенно добавляй сложные.
Эпохи 1-5: простые Q&A → Эпохи 5-10: код → Эпохи 10-15: сложный анализ.

### 12.4 Merge (объединение адаптеров)

```python
from peft import PeftModel
model = PeftModel.from_pretrained(base_model, "adapter_code")
model = model.merge_and_unload()
model = PeftModel.from_pretrained(model, "adapter_research")
model.save_pretrained("merged_adapter")
```

---

## 13. 🔌 MCP-инструменты для обучения ✨ НОВОЕ

> **Обоснование:** Парсер обнаружил 7 зарегистрированных MCP-серверов в `src/mcp_client.py`,
> включая **Parsers** (ripgrep, jq, yq), **CodeAnalysis** (AST, зависимости, метрики)
> и **Memory** (chromadb + TF-IDF). Эти инструменты дают **структурированные данные**
> из кодовой базы, логов и конфигов — идеальный материал для тренировочных примеров.
> Раньше этих возможностей в руководстве не было.

### 13.1 Parsers MCP — Извлечение данных для тренировки

**ripgrep (rg)** — быстрый поиск паттернов в логах:

```powershell
# Найти все успешные торговые операции в логах (для категории «Торговые стратегии»)
python -c "
from src.parsers_mcp import rg_search
results = rg_search('trade.*profit|arbitrage.*success', 'logs/', max_results=50)
print(results)
"
```

**jq** — извлечение структурированных данных из JSON-логов:

```powershell
# Извлечь все пары user_message → bot_response из structlog
python -c "
from src.parsers_mcp import jq_query
pairs = jq_query('.[] | select(.event==\"response\") | {user: .prompt, bot: .response}', 'logs/bot_current.log')
print(pairs)
"
```

### 13.2 CodeAnalysis MCP — Метрики кода для тренировки

```powershell
# Анализ AST для генерации тренировочных примеров о коде бота
python -c "
from src.code_analysis_mcp import analyze_file
result = analyze_file('src/brigade_api.py')
# result: {functions: [...], classes: [...], complexity: N, lines: N}
print(result)
"
```

**Применение:** Автоматически создавать тренировочные примеры вида:

- «Объясни функцию X из бота» → описание на основе AST
- «Какова сложность модуля Y?» → метрики из CodeAnalysis
- «Какие зависимости у Z?» → граф зависимостей

### 13.3 Memory MCP — Извлечение из базы знаний

```powershell
# Поиск по векторной БД для генерации Q&A пар
python -c "
from src.memory_mcp import search_memory
results = search_memory('как работает арбитраж на DMarket', top_k=10)
for r in results:
    print(f'Score: {r[\"score\"]:.3f} | {r[\"text\"][:100]}')
"
```

**Применение:** Превращать записи из ChromaDB в тренировочные пары,
используя хранимые знания как reference-ответы.

### 13.4 Конвейер MCP → Training Data

```
MCP Parsers (rg + jq)          → Извлекают сырые данные из логов/конфигов
        ↓
MCP CodeAnalysis (AST)          → Структурируют в instruction/response
        ↓
MCP Memory (chromadb)           → Обогащают контекстом из базы знаний
        ↓
Cloud Distillation (evaluate)   → Фильтруют по качеству
        ↓
train.jsonl                     → Готовы к обучению
```

### Чеклист MCP-инструментов

- [ ] `rg` извлекает паттерны из логов
- [ ] `jq` парсит JSON-логи в пары
- [ ] `CodeAnalysis` создаёт примеры о коде бота
- [ ] `Memory` обогащает данные из ChromaDB
- [ ] `evaluate` фильтрует всё по качеству

---

## 14. 🏛️ Brigade Reasoning Traces ✨ НОВОЕ

> **Обоснование:** Парсер обнаружил в `config/openclaw_config.json` продвинутую
> систему бригад (AFlow v13.2, LATS v11.7, SAGE v14.0) с 3 бригадами и 7+ ролями.
> Каждое выполнение пайплайна генерирует **цепочки рассуждений** (chain-of-thought):
> Planner → Coder → Auditor → Executor. Эти трейсы — **золотой стандарт** для
> обучения Chain-of-Thought reasoning, который наши адаптеры пока не используют.

### 14.1 Что такое Brigade Traces

Когда бот получает сложный запрос, Brigade Pipeline генерирует:

```
[Planner]  → <think>STAR-анализ задачи, декомпозиция на подзадачи</think>
[Coder]    → Код решения с type hints и error handling
[Auditor]  → Defect Report: severity, location, fix_suggestion
[Executor] → Финальная агрегация + ответ пользователю
```

Каждый шаг записывается в `logs/` и содержит reasoning trace.

### 14.2 Извлечение трейсов для обучения

```python
# scripts/extract_brigade_traces.py
import json
from pathlib import Path

def extract_traces(log_dir: str, output: str):
    """Извлекает Brigade reasoning traces в тренировочный формат."""
    traces = []
    for log_file in Path(log_dir).glob("*.jsonl"):
        chain = []
        for line in log_file.read_text().splitlines():
            entry = json.loads(line)
            if entry.get("event") == "brigade_step":
                chain.append({
                    "role": entry["role"],
                    "thought": entry.get("think", ""),
                    "action": entry.get("output", ""),
                })
        if len(chain) >= 2:
            # Формируем instruction из первого шага, response из последнего
            instruction = chain[0].get("thought", chain[0]["action"])
            # Включаем всю цепочку рассуждений в ответ
            response_parts = []
            for step in chain:
                if step["thought"]:
                    response_parts.append(f"<think>{step['thought']}</think>")
                response_parts.append(step["action"])
            traces.append({
                "instruction": instruction,
                "response": "\n\n".join(response_parts),
            })

    with open(output, "w") as f:
        for t in traces:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")
    print(f"Извлечено {len(traces)} brigade traces → {output}")
```

### 14.3 Категории Brigade-данных

| Источник                | Бригада       | Тип данных                                    | Ценность для обучения                    |
| ----------------------- | ------------- | --------------------------------------------- | ---------------------------------------- |
| **AFlow chains**        | OpenClaw-Core | Динамическая генерация цепочек ролей          | Модель учится планировать                |
| **LATS branches**       | Research-Ops  | Параллельные ветви поиска                     | Модель учится рассматривать альтернативы |
| **SAGE self-evolution** | Все           | Анализ своих ошибок + предложения исправлений | Модель учится рефлексии                  |
| **Auditor reports**     | Dmarket-Dev   | Security audit + risk analysis                | Модель учится аудиту                     |
| **Ensemble votes**      | Все           | Выбор лучшего из параллельных ответов         | DPO-данные бесплатно                     |

### 14.4 Зачем это нужно

Текущие адаптеры (v1) обучены на **плоских Q&A парах** — модель выдаёт ответ
одним блоком, без структурированного рассуждения.

Brigade traces добавляют:

- **Chain-of-Thought** — модель учится «думать вслух» в `<think>` блоках
- **Self-Verification** — модель проверяет свои ответы (Auditor pattern)
- **Multi-Step Planning** — декомпозиция сложных задач (Planner pattern)
- **Risk Assessment** — оценка рисков перед действием (Dmarket-Dev)

**Ожидаемый эффект:** ROUGE +0.05–0.10 на сложных запросах (анализ, стратегии, код).

### 14.5 Рекомендуемый пайплайн

```
1. Собери 50+ Brigade traces из logs/
2. Конвертируй через extract_brigade_traces.py
3. Добавь к основному датасету
4. Обучи адаптер с Curriculum Learning:
   - Эпохи 1-5: плоские Q&A
   - Эпохи 5-10: Brigade CoT traces
   - Эпохи 10-15: DPO preference pairs
```

### Чеклист Brigade Traces

- [ ] `extract_brigade_traces.py` создан
- [ ] 50+ traces извлечены из логов
- [ ] Трейсы проверены вручную (нет мусора)
- [ ] Добавлены в датасет с маркером `"source": "brigade"`
- [ ] Обучение с Curriculum Learning запущено

---

## 15. 🔄 Итеративное улучшение датасета

### Цикл улучшения (каждые 2–4 недели)

```
Бот делает ошибку → запиши исправленный пример → добавь в датасет
→ переобучи адаптер → задеплой → проверь что ошибка исправлена
```

### Как находить ошибки

```bash
# Короткие ответы (модель "не знала"):
wsl bash -c "grep -A2 'output.*:' logs/bot_current.log | grep -v '#' | awk 'length < 100'"
```

### Категории, которых всегда не хватает

| Категория                   | Почему важна                | Пример                                    |
| --------------------------- | --------------------------- | ----------------------------------------- |
| Ценовые сравнения           | Частый запрос               | «Что выгоднее: один нож или три ключа?»   |
| Временные тренды            | Бот не знает дату           | «Как менялась цена X за месяц?»           |
| Корректные отказы           | Бот должен уметь отказывать | «Предскажи точную цену завтра»            |
| Мультиступенчатые стратегии | Сложные запросы             | «Как превратить $100 в $200 за месяц?»    |
| Безопасность и скамы        | Критически важно            | «Как проверить что продавец не мошенник?» |
| Новичкам                    | Большая аудитория           | «С чего начать торговлю скинами?»         |

### Недельный чеклист

**Понедельник:** пользуйся ботом  
**Среда:** `collect_training_data.py` + 3–5 ручных примеров  
**Пятница:** `collect_training_data.py` + проверь размер датасета  
**Если 200+:** запусти обучение → оцени → задеплой

---

## 16. 📋 Шпаргалка команд

```powershell
# ══════════ ДАТАСЕТ ══════════

python scripts/collect_training_data.py                     # Собрать логи
(Get-Content data\training\raw_dialogues.jsonl | Measure-Object -Line).Lines  # Счётчик

# ══════════ CLOUD DISTILLATION (✨ НОВОЕ) ══════════

python scripts/train_lora.py generate --topic "CS2 trading" --count 50 --concurrent 4
python scripts/train_lora.py evaluate --dataset data/training/raw_dialogues.jsonl --threshold 6.0
python scripts/train_lora.py improve --dataset data/training/raw_dialogues.jsonl --concurrent 4
python scripts/train_lora.py backtranslate --dataset data/training/raw_dialogues_evaluated.jsonl --variants 3
python scripts/train_lora.py spin --dataset data/training/raw_dialogues_evaluated.jsonl --concurrent 4
python scripts/train_lora.py dpo --dataset data/training/raw_dialogues_evaluated.jsonl --concurrent 4

# ══════════ ОКРУЖЕНИЕ ══════════

wsl bash /mnt/d/openclaw_bot/openclaw_bot/scripts/install_training_deps.sh
wsl nvidia-smi
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python -c 'import torch; print(torch.cuda.get_device_name(0))'"

# ══════════ ОБУЧЕНИЕ ══════════

# 7B (3-5 часов)
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py --model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ --adapter-name openclaw-7b-v1 --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl --lora-rank 16 --epochs 3"

# 14B (8-10 часов, на ночь)
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py --model Qwen/Qwen2.5-Coder-14B-Instruct-AWQ --adapter-name openclaw-14b-v1 --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl --batch-size 1 --grad-accum 16"

# При OOM
wsl bash -c "source /mnt/d/vllm_env/bin/activate && python /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py --model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ --adapter-name openclaw-7b-v1 --dataset /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl --batch-size 1 --max-seq-len 1024"

# ══════════ ОЦЕНКА И ДЕПЛОЙ ══════════

wsl bash -c "source /mnt/d/vllm_env/bin/activate && python /mnt/d/openclaw_bot/openclaw_bot/scripts/eval_lora.py --adapter /mnt/d/lora_adapters/openclaw-7b-v1 --test /mnt/d/openclaw_bot/openclaw_bot/data/training/raw_dialogues.jsonl"

# Облачная оценка без GPU (✨ НОВОЕ)
python scripts/eval_lora.py --cloud --test data/training/raw_dialogues.jsonl --samples 30

# ══════════ АДАПТЕРЫ ══════════

wsl bash -c "ls /mnt/d/lora_adapters/ 2>/dev/null || echo 'Пока нет адаптеров'"
wsl bash -c "du -sh /mnt/d/lora_adapters/openclaw-7b-v1/"

# ══════════ МОНИТОРИНГ ══════════

wsl watch -n 5 nvidia-smi
wsl bash -c "tail -f /mnt/d/openclaw_bot/openclaw_bot/logs/train.log"
```

---

## 17. ❓ FAQ

**Q: Бот замедлился — это нормально?**  
A: Да. Обучение занимает всю VRAM. Останови бот на время тренировки.

**Q: OOM при обучении?**  
A: `--batch-size 1 --max-seq-len 1024`. Для 14B `--batch-size 1` обязателен.

**Q: ROUGE-1 = 0.10?**  
A: Нужно больше данных (500+) и разнообразие по категориям.

**Q: Как откатить адаптер?**  
A: `/admin swap_model Qwen/Qwen2.5-Coder-14B-Instruct-AWQ` — базовая модель без LoRA.

**Q: Можно обучать на русском?**  
A: Да, Qwen2.5 отлично поддерживает русский. Русскоязычный датасет — must.

**Q: Сколько примеров на категорию?**  
A: Минимум 20–30, оптимально 50–100.

**Q: Можно генерировать примеры через ChatGPT?**  
A: Лучше используй встроенный Cloud Distillation (`python scripts/train_lora.py generate`) —
он использует 120B модели бесплатно через OpenRouter и сохраняет в нужном формате автоматически.
Ручная генерация через ChatGPT тоже работает, но проверяй фактическую точность.

**Q: Зачем Cloud Distillation, если можно просто добавить данные вручную?**  
A: Масштаб. 201 ручной пример дал ROUGE 0.788. Для 0.85+ нужно 500–1000 пар высокого качества.
Cloud Distillation генерирует, улучшает и фильтрует данные автоматически — 100 пар за 10 минут
вместо 10 часов ручной работы.

**Q: Что такое SPIN self-play?**  
A: Режим `spin` в `train_lora.py`: облачная модель генерирует свой ответ на каждый вопрос,
затем модель-судья выбирает лучший (ваш reference или сгенерированный). Если модель уже
отвечает лучше — этот пример бесполезен для обучения и заменяется.

**Q: Можно ли использовать MCP-инструменты для сбора данных?**  
A: Да. `ripgrep` + `jq` извлекают данные из логов, `CodeAnalysis` анализирует код бота,
`Memory` ищет в ChromaDB. См. [секцию 13](#13--mcp-инструменты-для-обучения).

**Q: Что такое Brigade Reasoning Traces?**  
A: Цепочки рассуждений из пайплайна бригад (Planner→Coder→Auditor). Содержат
`<think>` блоки с reasoning. Обучение на них даёт Chain-of-Thought capability.
См. [секцию 14](#14--brigade-reasoning-traces).

**Q: Как часто переобучать?**  
A: Каждые 2–4 недели при 100+ новых примерах. Досрочно — после крупных изменений рынка.

**Q: Можно обучать параллельно?**  
A: Нет, на 16GB GPU только одно обучение одновременно.

**Q: Как узнать какие слои обучаются?**  
A: `python -c "from peft import PeftConfig; c = PeftConfig.from_pretrained('/mnt/d/lora_adapters/openclaw-7b-v1'); print(c.target_modules)"`

---

## 18. 📌 Текущий статус и трекер

### Статус

- [x] Qwen2.5-Coder-14B-AWQ скачана
- [x] DeepSeek-R1-14B-AWQ скачана
- [x] Qwen2.5-Coder-7B-AWQ скачана
- [x] Gemma-3-12B-AWQ-INT4 скачана
- [x] Скрипты обучения готовы (`train_lora.py`, `eval_lora.py`)
- [x] Сборщик логов готов (`collect_training_data.py`)
- [x] Cloud Distillation Pipeline (6 режимов) ✨
- [x] Dual-backend evaluation (local + cloud) ✨
- [x] MCP-инструменты для сбора данных (7 серверов) ✨
- [x] Model Router: облачные модели через OpenRouter ✨
- [ ] Зависимости WSL установлены (`install_training_deps.sh`)
- [ ] `OPENROUTER_API_KEY` настроен
- [ ] Cloud Distillation прогнан (evaluate → generate → improve → backtranslate → spin → dpo)
- [ ] Brigade traces извлечены (50+)
- [ ] Датасет 500+ примеров (после Cloud Distillation)
- [ ] Адаптер v2 обучен с расширенным датасетом
- [ ] DPO fine-tuning завершён
- [ ] Адаптер v2 задеплоен в бот

### Существующие адаптеры

| Адаптер                 | Базовая модель                        | Rank | ROUGE-1 | Loss  | Размер |
| ----------------------- | ------------------------------------- | ---- | ------- | ----- | ------ |
| openclaw-7b-v1          | Qwen2.5-Coder-7B-bnb-4bit             | 64   | 0.780   | 0.306 | 617MB  |
| openclaw-14b-v1         | Qwen2.5-Coder-14B-bnb-4bit            | 32   | 0.788   | 0.459 | 526MB  |
| openclaw-deepseek-r1-v1 | DeepSeek-R1-Distill-Qwen-14B-bnb-4bit | 32   | 0.797   | 0.464 | 526MB  |

Все обучены на 201 сэмплах, 15 эпох, cosine LR 2e-4, bf16, packing enabled.

**Рекомендация для v2**: Прогнать Cloud Distillation pipeline (generate 200+ synthetic → evaluate → improve → backtranslate ×3 → spin → dpo), добавить Brigade reasoning traces (50+), поднять rank 32→64. Цель: ROUGE 0.85+ на 500+ сэмплах.

### Облачные модели для дистилляции (model_router, 2026-04-01) ✨

| Задача                 | Модель                                 | Назначение              |
| ---------------------- | -------------------------------------- | ----------------------- |
| general, risk_analysis | nvidia/nemotron-3-super-120b-a12b:free | Генерация, оценка, DPO  |
| code, tool_execution   | qwen/qwen3.6-plus-preview:free         | Код и инструменты       |
| research               | stepfun/step-3.5-flash:free            | Исследования и анализ   |
| agent                  | z-ai/glm-4.5-air:free                  | Агентные задачи         |
| data_parsing, intent   | arcee-ai/trinity-mini:free             | Парсинг и классификация |
| vision                 | nvidia/nemotron-nano-12b-v2-vl:free    | Визуальные задачи       |

### Трекер прогресса

| Дата       | Samples | Событие                                                           |
| ---------- | ------- | ----------------------------------------------------------------- |
| 2026-03-18 | 0       | Старт. Модели скачаны, скрипты готовы                             |
| 2026-03-20 | 201     | Три адаптера обучены (7B/14B/R1)                                  |
| 2026-04-01 | 201     | Cloud Distillation pipeline добавлен ✨                           |
| 2026-04-01 | 201     | MCP-инструменты для сбора данных ✨                               |
| 2026-04-01 | 201     | Brigade reasoning traces добавлены ✨                             |
| 2026-04-01 | 201     | Cloud eval backend (--cloud) добавлен ✨                          |
| 2026-04-01 | 201     | Model Router обновлён (nemotron-120b, qwen3.6, step-3.5-flash) ✨ |
|            |         |                                                                   |

_(Заполняй при запуске collect_training_data.py)_
