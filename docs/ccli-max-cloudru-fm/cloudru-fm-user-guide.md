# Руководство пользователя: Cloud.ru FM в OpenClaw

## Быстрый старт (5 минут)

### 1. Получите API-ключ

Перейдите на https://cloud.ru/ru/ai-foundation-models и получите API-ключ.

### 2. Запустите wizard

```bash
npx openclaw onboard
```

Выберите **Cloud.ru FM** → **GLM-4.7-Flash (Free)** (для начала).

### 3. Запустите прокси

```bash
docker compose -f docker-compose.cloudru-proxy.yml up -d
```

### 4. Работайте

```bash
npx openclaw run --prompt "Привет, напиши функцию сортировки на Python"
```

Готово! OpenClaw теперь использует cloud.ru модели.

## Выбор модели

### Какой пресет выбрать?

```
Вы хотите...

...попробовать бесплатно?
  → GLM-4.7-Flash (Free)

...максимальное качество для сложных задач?
  → GLM-4.7 (Full)

...специализированную модель для кода?
  → Qwen3-Coder-480B
```

### Сравнение пресетов

| Критерий | GLM-4.7 (Full) | Flash (Free) | Qwen3-Coder |
|----------|---------------|-------------|-------------|
| Качество | Высокое | Среднее | Высокое (код) |
| Скорость | Средняя | Быстрая | Средняя |
| Цена | Платно | Бесплатно | Платно |
| Контекст | 200K | 200K | 128K |
| Лучше для | Архитектура, анализ | Тестирование, простые задачи | Кодогенерация |

## Повседневное использование

### Работа с агентами

OpenClaw работает как обычно — все агенты, MCP серверы и tool calling функционируют:

```bash
# Запуск одиночного агента
npx openclaw agent run --type coder --prompt "Добавь валидацию email"

# Запуск swarm
npx openclaw swarm init --topology hierarchical --max-agents 6
```

### Переключение между провайдерами

Чтобы переключиться с cloud.ru на другой провайдер:

```bash
# Повторный запуск wizard
npx openclaw onboard

# Или откатите конфигурацию и начните заново
# (см. раздел Откатка)
```

### Проверка текущего провайдера

```bash
# Посмотрите openclaw.json
cat openclaw.json | grep -A5 "providers"

# Или проверьте backend
cat openclaw.json | grep ANTHROPIC_BASE_URL
# Если видите localhost:8082 — используется cloud.ru через прокси
```

## Смена пресета модели

### Через wizard (рекомендуется)

```bash
npx openclaw onboard
# Выберите новый пресет Cloud.ru FM
```

### Вручную

Отредактируйте `docker-compose.cloudru-proxy.yml`:

```yaml
environment:
  # Для Qwen3-Coder:
  BIG_MODEL: "Qwen/Qwen3-Coder-480B-A35B-Instruct"
  MIDDLE_MODEL: "zai-org/GLM-4.7-FlashX"
  SMALL_MODEL: "zai-org/GLM-4.7-Flash"
```

Перезапустите прокси:

```bash
docker compose -f docker-compose.cloudru-proxy.yml restart
```

## Работа с API-ключами

### Где хранится ключ?

Ключ хранится ТОЛЬКО в файле `.env` в корне проекта:

```
CLOUDRU_API_KEY=sk-xxxxxxxxxxxx
```

Он **никогда** не попадает в:
- `openclaw.json` (конфигурация)
- Git репозиторий (файл в `.gitignore`)
- Логи OpenClaw

### Обновление ключа

```bash
# Редактируйте .env
nano .env

# Перезапустите прокси
docker compose -f docker-compose.cloudru-proxy.yml restart
```

### Использование через env (без файла)

```bash
export CLOUDRU_API_KEY="sk-новый-ключ"
docker compose -f docker-compose.cloudru-proxy.yml up -d
```

## Откатка (отмена интеграции)

### Полная откатка

```bash
# 1. Остановите прокси
docker compose -f docker-compose.cloudru-proxy.yml down

# 2. Откатите конфигурацию (удалите секцию cloudru-fm из openclaw.json)
# Вручную или программно через rollbackCloudruFmConfig()

# 3. Запустите wizard заново с другим провайдером
npx openclaw onboard
```

### Частичная (сменить провайдер, сохранив прокси)

```bash
# Просто запустите wizard с новым провайдером
npx openclaw onboard
# Прокси останется запущенным, но не будет использоваться
```

## FAQ

### Q: Нужен ли Anthropic API ключ?
**A:** Нет. Wizard устанавливает sentinel value (`not-a-real-key-proxy-only`) как ANTHROPIC_API_KEY. Claude CLI принимает его, но все запросы идут через прокси к cloud.ru.

### Q: Работает ли tool calling?
**A:** Да, прокси транслирует Anthropic `tool_use` формат в OpenAI `function_calling`. GLM-4.7 поддерживает tool calling, но может быть нестабильным. Flash модель стабильнее.

### Q: Что если прокси упадёт?
**A:** OpenClaw покажет ошибку "proxy is not reachable". Docker restart policy (`unless-stopped`) автоматически перезапустит контейнер. Также можно перезапустить вручную:
```bash
docker compose -f docker-compose.cloudru-proxy.yml restart
```

### Q: Можно ли использовать несколько провайдеров одновременно?
**A:** Нет, OpenClaw использует один активный провайдер. Но можно быстро переключаться через wizard.

### Q: Прокси виден из сети?
**A:** Нет. Прокси привязан к `127.0.0.1:8082` — доступен только локально. Внешние подключения блокированы.

### Q: Сколько стоит?
**A:** GLM-4.7-Flash — бесплатно. GLM-4.7 и Qwen3-Coder — по тарифам cloud.ru. Стоимость отслеживается в личном кабинете cloud.ru, OpenClaw показывает 0.

### Q: Как проверить какая модель используется?
**A:**
```bash
# В логах прокси
docker logs claude-code-proxy --tail 20

# В ответе модели
npx openclaw run --prompt "What model are you? Answer in one line."
```

### Q: Можно ли добавить свою модель?
**A:** Да, если она доступна через cloud.ru FM API. Отредактируйте `BIG_MODEL`/`MIDDLE_MODEL`/`SMALL_MODEL` в docker-compose файле и перезапустите прокси.

### Q: Как настроить таймауты?
**A:** Health check timeout настраивается в docker-compose (по умолчанию 5s). Таймаут запросов к cloud.ru API определяется прокси и Claude Code (обычно 60-120s).

## Полезные команды

```bash
# Статус прокси
docker ps --filter name=claude-code-proxy

# Логи в реальном времени
docker logs -f claude-code-proxy

# Ресурсы контейнера
docker stats claude-code-proxy --no-stream

# Health check
curl -s http://localhost:8082/health

# Перезапуск прокси
docker compose -f docker-compose.cloudru-proxy.yml restart

# Полная остановка
docker compose -f docker-compose.cloudru-proxy.yml down

# Текущая конфигурация
cat openclaw.json | python3 -m json.tool
```
