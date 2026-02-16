# Обслуживание Cloud.ru FM интеграции

## Оперативное управление

### Статус прокси

```bash
# Проверка запущен ли контейнер
docker ps --filter name=claude-code-proxy

# Health check
curl -s http://localhost:8082/health

# Логи (последние 100 строк)
docker logs claude-code-proxy --tail 100

# Логи в реальном времени
docker logs claude-code-proxy -f
```

### Перезапуск прокси

```bash
# Мягкий перезапуск
docker compose -f docker-compose.cloudru-proxy.yml restart

# Полная пересборка
docker compose -f docker-compose.cloudru-proxy.yml down
docker compose -f docker-compose.cloudru-proxy.yml up -d
```

### Остановка

```bash
# Остановить прокси
docker compose -f docker-compose.cloudru-proxy.yml down

# Остановить и удалить volumes
docker compose -f docker-compose.cloudru-proxy.yml down -v
```

## Обновление

### Обновление Docker-образа прокси

1. Обновите версию в `docker-compose.cloudru-proxy.yml`:
   ```yaml
   image: legard/claude-code-proxy:v1.1.0   # новая версия
   ```

2. Обновите константу в `src/config/cloudru-fm.constants.ts`:
   ```typescript
   export const CLOUDRU_PROXY_IMAGE = "legard/claude-code-proxy:v1.1.0";
   ```

3. Пересоздайте контейнер:
   ```bash
   docker compose -f docker-compose.cloudru-proxy.yml pull
   docker compose -f docker-compose.cloudru-proxy.yml up -d
   ```

### Обновление API-ключа

```bash
# Отредактируйте .env файл
nano .env
# Измените CLOUDRU_API_KEY=новый-ключ

# Перезапустите прокси (он читает .env при старте)
docker compose -f docker-compose.cloudru-proxy.yml restart
```

### Смена пресета моделей

1. Запустите wizard заново:
   ```bash
   npx openclaw onboard
   ```

2. Или отредактируйте `docker-compose.cloudru-proxy.yml` вручную:
   ```yaml
   environment:
     BIG_MODEL: "Qwen/Qwen3-Coder-480B-A35B-Instruct"   # новая модель
     MIDDLE_MODEL: "zai-org/GLM-4.7-FlashX"
     SMALL_MODEL: "zai-org/GLM-4.7-Flash"
   ```

3. Перезапустите прокси:
   ```bash
   docker compose -f docker-compose.cloudru-proxy.yml restart
   ```

## Откатка (Rollback)

### Программный откат

```typescript
import { rollbackCloudruFmConfig } from "./commands/cloudru-rollback.js";

// Откатить конфигурацию
await rollbackCloudruFmConfig("/path/to/openclaw.json");
```

### Ручной откат

1. Удалите секцию `cloudru-fm` из `openclaw.json`:
   ```json
   {
     "models": {
       "providers": {
         // Удалите эту секцию:
         "cloudru-fm": { ... }
       }
     }
   }
   ```

2. Удалите env override из CLI backend:
   ```json
   {
     "agents": {
       "defaults": {
         "cliBackends": {
           "claude-cli": {
             // Удалите env и clearEnv
           }
         }
       }
     }
   }
   ```

3. Остановите прокси:
   ```bash
   docker compose -f docker-compose.cloudru-proxy.yml down
   ```

## Мониторинг

### Метрики для отслеживания

| Метрика | Как проверить | Норма |
|---------|--------------|-------|
| Proxy uptime | `docker ps` | Running |
| Health check | `curl localhost:8082/health` | 200 OK |
| Latency | Смотрите в логах OpenClaw | < 5s первый токен |
| Error rate | `docker logs` grep для ошибок | < 5% |
| Memory usage | `docker stats claude-code-proxy` | < 512 MB |
| CPU usage | `docker stats claude-code-proxy` | < 100% |

### Мониторинг Docker

```bash
# Текущие ресурсы
docker stats claude-code-proxy --no-stream

# История рестартов
docker inspect claude-code-proxy --format='{{.RestartCount}}'

# Время работы
docker inspect claude-code-proxy --format='{{.State.StartedAt}}'
```

### Логирование

Прокси пишет логи в stdout/stderr Docker контейнера:

```bash
# Все логи
docker logs claude-code-proxy

# С фильтрацией по дате
docker logs claude-code-proxy --since 2026-02-13

# Экспорт в файл
docker logs claude-code-proxy > proxy.log 2>&1
```

## Безопасность

### Ротация API-ключей

1. Получите новый ключ на https://cloud.ru
2. Обновите `.env`:
   ```
   CLOUDRU_API_KEY=новый-ключ
   ```
3. Перезапустите прокси:
   ```bash
   docker compose -f docker-compose.cloudru-proxy.yml restart
   ```
4. Отзовите старый ключ на cloud.ru

### Проверка безопасности

```bash
# Убедитесь что прокси слушает только localhost
docker port claude-code-proxy
# Ожидаемый вывод: 8082/tcp -> 127.0.0.1:8082

# Убедитесь что .env в .gitignore
grep ".env" .gitignore

# Убедитесь что compose в .gitignore
grep "docker-compose.cloudru-proxy.yml" .gitignore

# Проверьте, что ключ не в openclaw.json
grep -r "CLOUDRU_API_KEY" openclaw.json
# Не должно быть результатов

# Проверьте Docker security
docker inspect claude-code-proxy --format='{{.HostConfig.SecurityOpt}}'
# Ожидаемый: [no-new-privileges:true]
```

### Обновление безопасности Docker

```bash
# Проверьте текущий образ на уязвимости
docker scout cves legard/claude-code-proxy:v1.0.0

# Обновите до последнего патча
docker pull legard/claude-code-proxy:v1.0.1
docker compose -f docker-compose.cloudru-proxy.yml up -d
```

## Резервное копирование

### Что бэкапить

| Файл | Важность | Содержимое |
|------|----------|------------|
| `openclaw.json` | Критическая | Конфигурация провайдера |
| `.env` | Критическая | API-ключ |
| `docker-compose.cloudru-proxy.yml` | Средняя | Docker конфигурация |

### Скрипт бэкапа

```bash
#!/bin/bash
BACKUP_DIR="backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp openclaw.json "$BACKUP_DIR/"
cp .env "$BACKUP_DIR/"
cp docker-compose.cloudru-proxy.yml "$BACKUP_DIR/" 2>/dev/null
echo "Backup saved to $BACKUP_DIR"
```

## Известные проблемы

### 1. GLM-4.7 tool calling нестабильность

**Симптом:** Ошибки парсинга tool calls, зависания.
**Решение:** Убедитесь что `DISABLE_THINKING=true` в Docker env. Или переключитесь на Flash пресет.

### 2. Health cache 30s blackout

**Симптом:** После перезапуска прокси первые 30 секунд OpenClaw считает его недоступным.
**Решение:** Подождите 30 секунд или перезапустите OpenClaw.

### 3. Порт 8082 занят

**Симптом:** Docker не может стартовать.
**Решение:**
```bash
# Найти, что занимает порт
lsof -i :8082
# Остановить или сменить порт в compose файле
```

### 4. Стоимость отображается как 0

**Симптом:** В статистике OpenClaw стоимость запросов = 0.
**Причина:** Реальная стоимость отслеживается cloud.ru, а не OpenClaw.
**Решение:** Мониторьте расходы в личном кабинете cloud.ru.
