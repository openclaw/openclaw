#!/usr/bin/env bash
# setup.sh — запуск OpenClaw + Cloud.ru FM + Telegram одной командой
#
# Использование:
#   CLOUDRU_API_KEY=... TELEGRAM_BOT_TOKEN=... bash setup.sh
#
# Или просто:
#   bash setup.sh          (скрипт запросит ключи интерактивно)

set -euo pipefail

# ─── Цвета ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $*"; }
info() { echo -e "  ${CYAN}→${NC} $*"; }
step() { echo -e "\n${BOLD}[$1/$TOTAL_STEPS] $2${NC}"; }

TOTAL_STEPS=8

# ─── Директория скрипта ──────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ─── PID-ы для cleanup ──────────────────────────────────────────────────────

GATEWAY_PID=""
PROXY_STARTED_BY_US=false

cleanup() {
    echo ""
    warn "Получен сигнал завершения, останавливаю сервисы..."

    if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
        info "Останавливаю gateway (PID $GATEWAY_PID)..."
        kill "$GATEWAY_PID" 2>/dev/null || true
        wait "$GATEWAY_PID" 2>/dev/null || true
        ok "Gateway остановлен"
    fi

    if [[ "$PROXY_STARTED_BY_US" == true ]]; then
        info "Останавливаю Cloud.ru FM прокси..."
        docker compose -f "$SCRIPT_DIR/docker-compose.cloudru-proxy.yml" down 2>/dev/null || true
        ok "Прокси остановлен"
    fi

    echo ""
    info "Для повторного запуска: ${BOLD}bash setup.sh${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# ─── Шаг 1: Проверка prerequisites ──────────────────────────────────────────

step 1 "Проверка зависимостей"

MISSING=false

# Docker
if command -v docker &>/dev/null; then
    ok "Docker: $(docker --version | head -1)"
else
    fail "Docker не найден. Установите: https://docs.docker.com/get-docker/"
    MISSING=true
fi

# Docker Compose (v2 plugin)
if docker compose version &>/dev/null; then
    ok "Docker Compose: $(docker compose version --short 2>/dev/null || echo 'v2')"
else
    fail "Docker Compose (v2) не найден. Установите плагин docker-compose-plugin."
    MISSING=true
fi

# Node.js ≥ 22
if command -v node &>/dev/null; then
    NODE_VER="$(node -v | sed 's/^v//')"
    NODE_MAJOR="${NODE_VER%%.*}"
    if (( NODE_MAJOR >= 22 )); then
        ok "Node.js: v${NODE_VER}"
    else
        fail "Node.js v${NODE_VER} — требуется ≥ 22. Обновите Node.js."
        MISSING=true
    fi
else
    fail "Node.js не найден. Установите v22+: https://nodejs.org/"
    MISSING=true
fi

# pnpm
if command -v pnpm &>/dev/null; then
    ok "pnpm: $(pnpm --version)"
else
    fail "pnpm не найден. Установите: npm install -g pnpm"
    MISSING=true
fi

# Claude CLI
if command -v claude &>/dev/null; then
    ok "Claude CLI: найден"
else
    fail "Claude CLI (claude) не найден в PATH. Установите: npm install -g @anthropic-ai/claude-code"
    MISSING=true
fi

if [[ "$MISSING" == true ]]; then
    echo ""
    fail "Не все зависимости установлены. Исправьте ошибки выше и запустите скрипт снова."
    exit 1
fi

# ─── Шаг 2: API-ключи ───────────────────────────────────────────────────────

step 2 "Проверка API-ключей"

if [[ -z "${CLOUDRU_API_KEY:-}" ]]; then
    warn "CLOUDRU_API_KEY не задан"
    read -rp "  Введите Cloud.ru FM API Key: " CLOUDRU_API_KEY
    if [[ -z "$CLOUDRU_API_KEY" ]]; then
        fail "CLOUDRU_API_KEY обязателен"
        exit 1
    fi
fi
ok "CLOUDRU_API_KEY: ${CLOUDRU_API_KEY:0:8}...${CLOUDRU_API_KEY: -4}"

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    warn "TELEGRAM_BOT_TOKEN не задан"
    read -rp "  Введите Telegram Bot Token (от @BotFather): " TELEGRAM_BOT_TOKEN
    if [[ -z "$TELEGRAM_BOT_TOKEN" ]]; then
        fail "TELEGRAM_BOT_TOKEN обязателен"
        exit 1
    fi
fi
ok "TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN%%:*}:****"

export CLOUDRU_API_KEY
export TELEGRAM_BOT_TOKEN

# ─── Шаг 3: pnpm install ────────────────────────────────────────────────────

step 3 "Установка зависимостей (pnpm install)"

if [[ -d "$SCRIPT_DIR/node_modules" ]]; then
    ok "node_modules/ уже существует, пропускаю pnpm install"
else
    info "Запускаю pnpm install..."
    pnpm install --frozen-lockfile 2>&1 | tail -3
    ok "Зависимости установлены"
fi

# ─── Шаг 4: Генерация .env ──────────────────────────────────────────────────

step 4 "Генерация .env"

# Генерируем gateway token если не задан
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 24)"
fi
export OPENCLAW_GATEWAY_TOKEN

ENV_FILE="$SCRIPT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
    warn ".env уже существует, перезаписываю..."
fi

cat > "$ENV_FILE" <<EOF
# Сгенерировано setup.sh — $(date '+%Y-%m-%d %H:%M:%S')
CLOUDRU_API_KEY=${CLOUDRU_API_KEY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
EOF

ok ".env создан"

# ─── Шаг 5: Non-interactive onboarding ──────────────────────────────────────

step 5 "Онбординг (Cloud.ru FM GLM-4.7)"

info "Запускаю pnpm openclaw onboard..."

pnpm openclaw onboard \
    --non-interactive \
    --accept-risk \
    --auth-choice cloudru-fm-glm47 \
    --gateway-token "$OPENCLAW_GATEWAY_TOKEN" \
    --gateway-bind loopback \
    --skip-channels \
    --skip-skills \
    --skip-health \
    --skip-ui 2>&1 | tail -5

ok "Онбординг завершён"

if [[ -f "$SCRIPT_DIR/docker-compose.cloudru-proxy.yml" ]]; then
    ok "docker-compose.cloudru-proxy.yml создан"
else
    fail "docker-compose.cloudru-proxy.yml не найден после онбординга"
    exit 1
fi

# ─── Шаг 6: Запуск Cloud.ru FM прокси ───────────────────────────────────────

step 6 "Запуск Cloud.ru FM прокси (Docker)"

COMPOSE_FILE="$SCRIPT_DIR/docker-compose.cloudru-proxy.yml"

# Проверяем, не запущен ли уже прокси
if docker compose -f "$COMPOSE_FILE" ps --format '{{.State}}' 2>/dev/null | grep -q "running"; then
    ok "Прокси уже запущен"
else
    info "Запускаю docker compose up..."
    docker compose -f "$COMPOSE_FILE" up -d 2>&1
    PROXY_STARTED_BY_US=true
    ok "Контейнер запущен"
fi

# Health check с ожиданием до 30 секунд
info "Жду health check http://localhost:8082/health..."
HEALTH_OK=false
for i in $(seq 1 15); do
    if curl -sf http://localhost:8082/health &>/dev/null; then
        HEALTH_OK=true
        break
    fi
    sleep 2
done

if [[ "$HEALTH_OK" == true ]]; then
    ok "Прокси готов (health check пройден)"
else
    fail "Прокси не ответил за 30 секунд. Проверьте логи: docker compose -f docker-compose.cloudru-proxy.yml logs"
    exit 1
fi

# ─── Шаг 7: Добавление Telegram канала ──────────────────────────────────────

step 7 "Добавление Telegram канала"

info "Запускаю pnpm openclaw channels add..."

pnpm openclaw channels add \
    --channel telegram \
    --token "$TELEGRAM_BOT_TOKEN" 2>&1 | tail -3

ok "Telegram канал добавлен"

# ─── Шаг 8: Запуск Gateway ──────────────────────────────────────────────────

step 8 "Запуск Gateway"

# Проверяем, не занят ли порт 18789
if curl -sf http://localhost:18789 &>/dev/null 2>&1; then
    warn "Порт 18789 уже занят — gateway возможно уже запущен"
    ok "Пропускаю запуск gateway"
else
    info "Запускаю gateway на порту 18789..."
    echo ""

    # ─── Итоговая информация ─────────────────────────────────────────────

    echo -e "${BOLD}════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}${BOLD}  OpenClaw + Cloud.ru FM + Telegram — готов к работе!${NC}"
    echo -e "${BOLD}════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${CYAN}Gateway URL:${NC}       http://localhost:18789"
    echo -e "  ${CYAN}Gateway Token:${NC}     ${OPENCLAW_GATEWAY_TOKEN}"
    echo -e "  ${CYAN}Cloud.ru Proxy:${NC}    http://localhost:8082"
    echo -e "  ${CYAN}Модель:${NC}            GLM-4.7 (через Cloud.ru FM)"
    echo -e "  ${CYAN}Telegram Bot:${NC}      ID ${TELEGRAM_BOT_TOKEN%%:*}"
    echo ""
    echo -e "  ${YELLOW}Как остановить:${NC}"
    echo -e "    Ctrl+C — остановит gateway и прокси"
    echo -e "    Или вручную:"
    echo -e "      docker compose -f docker-compose.cloudru-proxy.yml down"
    echo ""
    echo -e "${BOLD}════════════════════════════════════════════════════════════${NC}"
    echo ""

    # Запуск в foreground — скрипт будет ждать здесь
    pnpm start gateway --port 18789 --bind loopback --allow-unconfigured &
    GATEWAY_PID=$!

    # Ждём пока gateway не завершится (или Ctrl+C)
    wait "$GATEWAY_PID" || true
fi
