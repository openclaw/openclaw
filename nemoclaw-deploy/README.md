# NemoClaw Deploy

Скрипт для развертывания OpenClaw в изолированной Docker-песочнице (NemoClaw / OpenShell) с интеграцией context-hub и DeepSeek Reasoner в качестве LLM-бэкенда.

## Требования

- **Git**
- **Node.js 20+**
- **npm**
- **Docker** (запущенный демон)
- **DeepSeek API-ключ** — получить на https://platform.deepseek.com/api_keys

## Быстрый старт

```bash
# 1. Только клонировать репозитории (без запуска sandbox)
./deploy-openclaw-nemoclaw.sh --clone-only

# 2. Полное развертывание
DEEPSEEK_API_KEY="sk-ваш-ключ" ./deploy-openclaw-nemoclaw.sh
```

Если `DEEPSEEK_API_KEY` не задан, скрипт запросит ключ интерактивно.

## Что делает скрипт

| Шаг | Описание |
|-----|----------|
| 0 | Проверяет наличие git, node, npm, docker, нужных папок |
| 1 | Клонирует/обновляет 3 репозитория в `~/.nemoclaw-deploy/` |
| 2 | Устанавливает зависимости и собирает проекты |
| 3 | Сохраняет DeepSeek API-ключ в `~/.nemoclaw/credentials.json` |
| 4 | Генерирует политику файловой системы (deny-by-default) |
| 5 | Генерирует политику сети (только разрешенные эндпоинты) |
| 6 | Создает Docker-контейнер с bind-mount только разрешенных папок |
| 7 | Настраивает CLI `openclaw` и `chub` внутри контейнера |
| 8 | Конфигурирует OpenClaw gateway (DeepSeek, workspace paths) |
| 9 | Проверяет сетевой доступ к DeepSeek API |
| 10 | Запускает OpenClaw gateway на порту 18789 |
| 11 | Выводит сводку |

## Репозитории

| Проект | URL |
|--------|-----|
| OpenClaw | https://github.com/openclaw/openclaw |
| NemoClaw | https://github.com/romannekrasovaillm/NemoClaw |
| context-hub | https://github.com/romannekrasovaillm/context-hub |

## Структура файлов

```
~/.nemoclaw-deploy/          # Клонированные репозитории
  openclaw/
  NemoClaw/
  context-hub/
  bin/                       # Симлинки на CLI (chub)

~/.nemoclaw/                 # Состояние и конфигурация
  credentials.json           # DeepSeek API-ключ (chmod 600)
  policies/
    restricted-fs.yaml       # Политика файловой системы
    network-egress.yaml      # Политика сети
```

## Безопасность: доступ к файлам

Внутри sandbox доступны **только** эти директории хоста:

| Путь в sandbox | Путь на хосте | Доступ |
|----------------|---------------|--------|
| `/workspace/razborы` | `/home/roman/Документы/КОД/gigachat/РАЗБОРЫ` | чтение/запись |
| `/workspace/biblioteka` | `/home/roman/Документы/БИБЛИОТЕКА` | чтение/запись |
| `/workspace/recipes_taxonomy` | `.../РАЗБОРЫ/recipes_taxonomy` | чтение/запись |
| `/workspace/context-hub` | `~/.nemoclaw-deploy/context-hub` | только чтение |

Все остальные папки хоста **заблокированы**.

## Безопасность: сеть

Разрешен исходящий трафик только к:

- `api.deepseek.com` (inference)
- `*.openclaw.ai` (OpenClaw services)
- `github.com`, `raw.githubusercontent.com` (context-hub)
- `registry.npmjs.org` (npm)
- DNS (порт 53/udp)

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|-------------|----------|
| `DEEPSEEK_API_KEY` | _(нет)_ | API-ключ DeepSeek (обязательно) |
| `NEMOCLAW_SANDBOX_NAME` | `openclaw-dev` | Имя Docker-контейнера |
| `NEMOCLAW_INSTALL_DIR` | `~/.nemoclaw-deploy` | Каталог установки репозиториев |

## Управление sandbox

```bash
# Подключиться к sandbox
docker exec -it openclaw-dev bash

# Логи gateway
docker exec openclaw-dev cat /tmp/openclaw-gateway.log

# Статус gateway
docker exec openclaw-dev openclaw gateway status --deep

# Остановить
docker stop openclaw-dev

# Удалить
docker rm -f openclaw-dev

# Пересоздать с нуля
DEEPSEEK_API_KEY="sk-..." ./deploy-openclaw-nemoclaw.sh
```

## context-hub CLI (внутри sandbox)

```bash
chub search <запрос>           # Поиск документации
chub get <id> --lang py        # Получить API-документ
chub annotate <id> <заметка>   # Добавить аннотацию
```

## Устранение проблем

| Проблема | Решение |
|----------|---------|
| Docker не запущен | `sudo systemctl start docker` |
| Node.js < 20 | Обновить через `nvm install 22` |
| DeepSeek API недоступен | Проверить ключ и сеть: `curl https://api.deepseek.com` |
| Sandbox не запускается | Проверить логи: `docker logs openclaw-dev` |
| Папки хоста не смонтированы | Убедиться что папки существуют до запуска скрипта |
