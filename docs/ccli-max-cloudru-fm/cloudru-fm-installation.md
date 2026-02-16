# Установка и запуск Cloud.ru FM интеграции

## Предварительные требования

| Компонент | Версия | Назначение |
|-----------|--------|------------|
| Node.js | >= 18.0 | Запуск OpenClaw |
| Docker | >= 24.0 | Контейнер прокси |
| Docker Compose | >= 2.20 | Оркестрация прокси |
| curl | любая | Health check внутри контейнера |
| API-ключ cloud.ru | — | Аутентификация в FM API |

## Получение API-ключа Cloud.ru

1. Перейдите на https://cloud.ru/ru/ai-foundation-models
2. Зарегистрируйтесь / войдите в аккаунт
3. Создайте проект Foundation Models
4. Скопируйте API-ключ из раздела "Ключи API"

## Установка

### Шаг 1: Клонирование форка

```bash
git clone https://github.com/dzhechko/openclaw.git
cd openclaw
git checkout cloudru-fm
npm install
```

### Шаг 2: Запуск Wizard

```bash
npx openclaw onboard
```

В списке провайдеров выберите **Cloud.ru FM**, затем один из пресетов:

```
? Choose auth provider:
  ...
  ▸ Cloud.ru FM
      GLM-4.7 (Full)         — 358B MoE, thinking mode, 200K context
      GLM-4.7-Flash (Free)   — Free tier, fast, recommended default
      Qwen3-Coder-480B       — Code-specialized, 128K context
```

Введите API-ключ, когда wizard попросит.

### Шаг 3: Создание Docker Compose файла

Создайте файл `docker-compose.cloudru-proxy.yml` в корне проекта:

```yaml
# Cloud.ru FM Proxy
# Run: docker compose -f docker-compose.cloudru-proxy.yml up -d

services:
  claude-code-proxy:
    image: legard/claude-code-proxy:v1.0.0
    container_name: claude-code-proxy
    restart: unless-stopped
    ports:
      - "127.0.0.1:8082:8082"
    environment:
      HOST: "0.0.0.0"
      PORT: "8082"
      API_BASE_URL: "https://foundation-models.api.cloud.ru/v1"
      API_KEY: "${CLOUDRU_API_KEY}"
      BIG_MODEL: "zai-org/GLM-4.7"
      MIDDLE_MODEL: "zai-org/GLM-4.7-FlashX"
      SMALL_MODEL: "zai-org/GLM-4.7-Flash"
      DISABLE_THINKING: "true"
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8082/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    user: "1000:1000"
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
```

Адаптируйте `BIG_MODEL` / `MIDDLE_MODEL` / `SMALL_MODEL` под выбранный пресет (см. таблицу ниже).

### Шаг 4: Запуск прокси

```bash
# Убедитесь, что .env файл содержит CLOUDRU_API_KEY
cat .env
# CLOUDRU_API_KEY=sk-xxxxxxxxxxxxxxxx

# Запустите прокси
docker compose -f docker-compose.cloudru-proxy.yml up -d
```

### Шаг 5: Проверка

```bash
# Проверка здоровья прокси
curl -s http://localhost:8082/health
# Ожидаемый ответ: {"status":"ok"} или аналогичный

# Проверка конфигурации OpenClaw
cat openclaw.json | grep cloudru-fm

# Тестовый запрос через OpenClaw
npx openclaw run --prompt "Hello, what model are you?"
```

## Non-Interactive установка (CI/CD)

```bash
# Через CLI-флаг
npx openclaw onboard \
  --auth-choice cloudru-fm-glm47 \
  --cloudruApiKey "sk-your-key-here" \
  --non-interactive \
  --accept-risk

# Или через переменную окружения
export CLOUDRU_API_KEY="sk-your-key-here"
npx openclaw onboard \
  --auth-choice cloudru-fm-flash \
  --non-interactive \
  --accept-risk
```

## Пресеты моделей

### GLM-4.7 (Full) — `cloudru-fm-glm47`

```
BIG_MODEL    = zai-org/GLM-4.7           (358B MoE, 200K context)
MIDDLE_MODEL = zai-org/GLM-4.7-FlashX    (быстрая, 200K)
SMALL_MODEL  = zai-org/GLM-4.7-Flash     (бесплатная, 200K)
```

Лучшее качество. Рекомендуется для сложных задач.

### GLM-4.7-Flash (Free) — `cloudru-fm-flash`

```
BIG_MODEL    = zai-org/GLM-4.7-Flash     (бесплатно)
MIDDLE_MODEL = zai-org/GLM-4.7-Flash     (бесплатно)
SMALL_MODEL  = zai-org/GLM-4.7-Flash     (бесплатно)
```

Все три тира на одной бесплатной модели. Для тестирования и экономии.

### Qwen3-Coder-480B — `cloudru-fm-qwen`

```
BIG_MODEL    = Qwen/Qwen3-Coder-480B-A35B-Instruct   (кодогенерация, 128K)
MIDDLE_MODEL = zai-org/GLM-4.7-FlashX                  (быстрая)
SMALL_MODEL  = zai-org/GLM-4.7-Flash                   (бесплатная)
```

Специализированная для написания кода.

## Структура файлов после установки

```
openclaw/                                   # Fork: dzhechko/openclaw (branch: cloudru-fm)
├── openclaw.json                          # Конфигурация (обновлена wizard)
├── .env                                    # CLOUDRU_API_KEY (секрет)
├── docker-compose.cloudru-proxy.yml       # Docker Compose для прокси
├── .gitignore                              # Обновлён (добавлены .env, compose)
└── src/
    ├── config/
    │   └── cloudru-fm.constants.ts         # Константы
    ├── commands/
    │   ├── auth-choice.apply.cloudru-fm.ts # Handler
    │   ├── onboard-cloudru-fm.ts           # Утилиты
    │   └── cloudru-rollback.ts             # Откатка
    └── agents/
        ├── cloudru-proxy-template.ts       # Docker шаблон
        └── cloudru-proxy-health.ts         # Health check
```

## Troubleshooting

### Прокси не запускается

```bash
# Проверьте логи
docker compose -f docker-compose.cloudru-proxy.yml logs

# Проверьте, что порт 8082 свободен
lsof -i :8082

# Перезапустите
docker compose -f docker-compose.cloudru-proxy.yml down
docker compose -f docker-compose.cloudru-proxy.yml up -d
```

### "Cloud.ru FM proxy is not reachable"

1. Убедитесь, что Docker запущен: `docker ps`
2. Проверьте контейнер: `docker ps -a | grep claude-code-proxy`
3. Проверьте `.env` файл содержит `CLOUDRU_API_KEY`
4. Проверьте health: `curl http://localhost:8082/health`

### Ошибки аутентификации

1. Проверьте ключ: `echo $CLOUDRU_API_KEY`
2. Убедитесь, что ключ действителен на https://cloud.ru
3. Проверьте, что ключ в `.env` не содержит кавычек

### Ошибки tool calling

GLM-4.7 имеет известные нестабильности с tool calling. Попробуйте:
1. Переключиться на пресет `cloudru-fm-flash` (более стабильный)
2. Убедиться что `DISABLE_THINKING=true` в Docker env
3. Упростить промпт (< 4000 символов в system prompt)
