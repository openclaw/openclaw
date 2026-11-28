# LiteLLM provider gateway for OpenClaw

Fallback safety-net so OpenClaw never stalls when the Claude (subscription)
runtime runs out of tokens / hits a rate limit / needs Max-Pro.
С 2026-11-04 шлюз также обслуживает Claude Code (см. `~/.claude/settings.json`).

## Architecture

```
Telegram
  ↓
OpenClaw gateway (openclaw-gateway.service)
  ↓  primary: claude-cli / codex SUBSCRIPTION runtimes (unchanged, free)
  ↓  fallback: litellm/openclaw-auto
Claude Code (ANTHROPIC_BASE_URL=http://127.0.0.1:4000)
  ↓  model: MiniMax-M3.1-Flash[1m]
LiteLLM (127.0.0.1:4000)  —  35 алиасов, 30 цепочек fallback
  ↓  1) MiniMax   MiniMax-M3.1-Flash   (прямой M Plan API: api.minimax.io, подписка)
  ↓  2) MiniMax   nvidia-minimax       (тот же MiniMax по кредитам NVIDIA NIM — бесплатно)
  ↓  3) MiniMax   minimax-primary      (тот же MiniMax через OpenRouter, оплата по токенам)
  ↓  4) MiniMax   deepinfra-minimax    (MiniMax-M3 на оплаченных токенах DeepInfra)
  ↓  5) Anthropic claude-primary       (баланс владельца $10; сейчас 403 до верификации)
  ↓  6) Ollama    zerohour/qwen3.8-27b-uncensored:iq3
  ↓  7) Ollama    ministral-3:14b      (лёгкий аварийный конец)
```

Дополнительные провайдеры: NVIDIA NIM (5 бесплатных моделей), DeepInfra
(6 алиасов на оплаченных токенах: MiniMax-M3, GLM-5.2, GLM-5.3-Flash,
Qwen3.8-27B, Qwen3.8-Max, DeepSeek-V4.1-Flash), GLM через z.ai, Claude через
OpenRouter (10 алиасов семейства 4.x/5.x).

OpenClaw keeps Claude via the `claude-cli` subscription as primary (free).
LiteLLM is an HTTP gateway and cannot proxy that subscription, so it sits as a
**fallback tier**. When the subscription fails, OpenClaw falls through to
`litellm/openclaw-auto`, which now fans out MiniMax → Anthropic → Ollama.

`ANTHROPIC_API_KEY` опционален: он обслуживает алиас `claude-primary`
(прямой Anthropic). На 2026-11-04 Anthropic отдаёт 403 «organization can't
receive replies» до прохождения верификации организации, поэтому этот алиас
не входит в активную часть цепочки.

Провайдер MiniMax (решение владельца от 2026-11-04 — покупаем только MiniMax).
С 04.11 **основной путь идёт напрямую** к M Plan API
(`https://api.minimax.io/v1`, модель `MiniMax-M3.1-Flash`) — это подписка,
маржинальная цена запроса нулевая. Ключ лежит в кошельке как
`minimax_mplan_api_key` и попадает в `.env` как `MINIMAX_MPLAN_API_KEY`.
OpenRouter (`minimax-primary`) остался резервом и в цепочке стоит **после**
бесплатного NVIDIA NIM.

Порядок цепочки (экономия квоты, решение владельца): подписка M Plan →
**бесплатный NVIDIA NIM** → оплата по токенам (OpenRouter, DeepInfra) →
Anthropic → локальный Ollama.

Баланс M Plan к вечеру 04.11 снова исчерпан (api.minimax.io отдаёт
`402 insufficient_balance`), поэтому фактический трафик держит бесплатный
NVIDIA NIM — платные провайдеры не трогаются, запросы не падают. После
пополнения на https://platform.minimax.io/console/plan первый эшелон
заработает сам; проверить можно так:

```bash
python3 scripts/mm-direct-check.py   # ключ читается из .env, в argv его нет
```

### Лишние параметры Claude Code (важно)

Claude Code шлёт `output_config` и `thinking`. OpenAI-совместимые провайдеры
(NVIDIA NIM, DeepInfra) их не понимают: NVIDIA отвечает 400
«Unsupported parameter(s)», а на `thinking` запрос зависает. LiteLLM при этом
разворачивает `output_config → reasoning_effort → effort`, а
`thinking → type + budget_tokens`. Поэтому у всех таких деплоев стоит
```additional_drop_params: ["output_config", "reasoning_effort", "effort", "thinking", "type", "budget_tokens"]```
Без этого цепочка fallback проваливается на локальный Ollama (43–107 с вместо
1–2 с). Проверяется зондом `python3 scripts/litellm-param-probe.py`.

### Секреты

Ключи берутся только из secret-wallet → `.env` → окружение контейнера.
Сверка: `python3 /home/zero/secret-wallet/wallet.py reconcile --project openclaw-litellm`
— 7/7 MATCH (OpenRouter, Anthropic, GLM, MiniMax, MiniMax M Plan, NVIDIA, DeepInfra).

## Экономная маршрутизация и ротация секретов ГрузПотока

- Цепочки fallback перестроены 04.11: бесплатный NVIDIA NIM поднят выше
  платных OpenRouter/DeepInfra. Все 7 бесплатных алиасов (5 NVIDIA + 2 Ollama)
  проверены живым запросом — HTTP 200.
- Ротация секретов ГрузПотока V1 раз в 3 часа: движок
  `/home/zero/secret-wallet/scripts/gruzpotok-rotation-engine.py`, политика
  `/home/zero/secret-wallet/config/rotation-engine.yaml`, таймер
  `gruzpotok-secret-rotation.timer`. Подробности — в
  `/home/zero/secret-wallet/docs/GRUZPOTOK_SECRET_ROTATION.md`.

## Мост Anthropic -> OpenAI (обход бага LiteLLM) — НЕ НУЖЕН с 1.109.0

**Статус: LiteLLM обновлён до 1.109.0 (образ `ghcr.io/berriai/litellm:main-latest`,
digest `030121401c60`), багtool-call в `/v1/messages` в нём починен.** Проверено
зондом: `input_json_delta` приходит, аргументы разбираются
(`{'city': 'Казань', 'days': 3}`), делегация в Claude Code работает напрямую
через `:4000` (`ANTHROPIC_BASE_URL=http://127.0.0.1:4000`).

Мост оставлен в репозитории как рабочий запасной вариант (юнит
`anthropic-bridge.service` выключен). Включить обратно:

```bash
systemctl --user enable --now anthropic-bridge.service
# и в ~/.claude/settings.json вернуть ANTHROPIC_BASE_URL=http://127.0.0.1:4001
```

Историческая справка (почему мост вообще понадобился):

Claude Code говорит на Anthropic-протоколе (`POST /v1/messages`) и работает в
стриминге. В LiteLLM 1.82.6 конвертер OpenAI-стрима -> Anthropic теряет
аргументы tool-call: отдаёт `content_block_start` с пустым `input={}` и без
`input_json_delta`. Инструменты вызываются без параметров, поэтому делегация
(subagent, Task-вызовы) не работает. В нестриминговом режиме и в
OpenAI-протоколе `/v1/chat/completions` параметры доходят целыми - теряются
только в Anthropic-адаптере.

Поэтому перед шлюзом стоит тонкий мост:

```
Claude Code --Anthropic-протокол--> 127.0.0.1:4001 (anthropic-bridge.py)
                                          --OpenAI-протокол--> 127.0.0.1:4000 (LiteLLM)
```

Мост сам разбирает Anthropic-запрос (system, блоки контента, tool_use,
tool_result, tools, tool_choice) в OpenAI-запрос и обратно собирает корректные
блоки `tool_use` + `input_json_delta` из tool_calls апстрима.

```bash
systemctl --user status anthropic-bridge.service
curl http://127.0.0.1:4001/health/liveliness
tail -f ~/.openclaw/anthropic-bridge.log
```

В `~/.claude/settings.json` указывается `ANTHROPIC_BASE_URL=http://127.0.0.1:4001`.
Проверка сквозной передачи параметров: `python3 scripts/litellm-toolcall-probe.py
http://127.0.0.1:4001` и `python3 scripts/litellm-toolcall-stream-probe.py
http://127.0.0.1:4001`.

Проверять надо зондом, а не на глаз: `python3 scripts/litellm-toolcall-stream-probe.py
http://127.0.0.1:4000` должен показать `input_json_delta частей: 1` и разобранные
аргументы.

## Files

- `docker-compose.litellm.yml` — standalone compose (does not touch the main one)
- `litellm.config.yaml` — model list + fallback chains
- `.env.example` — required/optional env keys (copy to `.env`, fill, never commit)
- `litellm-test.sh` — healthcheck + smoke + fallback drill
- `scripts/anthropic-bridge.py` — мост Anthropic -> OpenAI перед шлюзом
- `scripts/litellm-toolcall-probe.py` — проверка прохождения параметров tool-call
- `scripts/litellm-toolcall-stream-probe.py` — то же в стриминге (как ходит Claude Code)
- `scripts/litellm-param-probe.py` — проверка устойчивости к лишним параметрам
- `scripts/litellm-hierarchy.py` — иерархия: ведущий агент делегирует исполнителям

## Run

```bash
cp .env.example .env        # then fill OPENROUTER_API_KEY + LITELLM_MASTER_KEY
docker compose -f docker-compose.litellm.yml up -d
./litellm-test.sh
```

## Healthcheck + manual tests

```bash
curl http://127.0.0.1:4000/health/liveliness                 # "I'm alive!"
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw-auto","messages":[{"role":"user","content":"Ответь одним словом: OK"}]}'
```

## OpenClaw wiring (live config)

`~/.openclaw/openclaw.json` gets a `litellm` provider
(`api: openai-completions`, `baseUrl: http://127.0.0.1:4000/v1`, model
`openclaw-auto`) and `litellm/openclaw-auto` appended as a fallback on the
Claude-only agents: `claude-dev`, `claude-smart`, `trust`, `legal`, `analyst`.
`architect` already had its own chain and is left untouched.

Changes take effect on the next gateway restart:

```bash
systemctl --user restart openclaw-gateway.service
```

## Health monitor (alert + auto-restart)

A systemd `--user` timer checks `/health/liveliness` every 2 minutes. If the
gateway is down it attempts an idempotent `docker compose up -d`, rechecks, and
alerts the owner over the existing Telegram bot via `openclaw message send` (no
new token, no polling conflict). Alerts fire only on transitions (up↔down), so
no spam.

Files:

- `litellm-health-monitor.sh` — the check + restart + alert logic
- `deploy/systemd/litellm-health-monitor.{service,timer}` — installed copies live
  in `~/.config/systemd/user/`

Install / control:

```bash
cp deploy/systemd/litellm-health-monitor.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now litellm-health-monitor.timer
systemctl --user list-timers litellm-health-monitor.timer   # next fire
tail -f ~/.openclaw/litellm-monitor.log                     # monitor log
```

State: `~/.openclaw/.litellm-monitor-state` (`up`/`down`). Owner Telegram target
is resolved at runtime (first user peer) — no chat id stored on disk; override
with `MONITOR_TARGET` if needed.

Состояние на 2026-11-04: таймер **установлен и включён**
(`systemctl --user enable --now litellm-health-monitor.timer`), цикл 2 минуты.
Проверено drill'ом: контейнер остановлен вручную → через 55 с монитор увидел
DOWN, поднял контейнер через `docker compose up -d`, вернул `up` в state-файл и
прислал уведомление в Telegram («ALERT-SENT» в логе монитора). Лог:
`~/.openclaw/litellm-monitor.log`.

> The monitor auto-restarts the container. To take LiteLLM down for real
> (rollback), **stop the timer first** or it will bring the container back:
> `systemctl --user disable --now litellm-health-monitor.timer`

## Teardown / rollback

```bash
docker compose -f docker-compose.litellm.yml down
# restore live config from the timestamped backup if needed:
#   cp ~/.openclaw/openclaw.json.bak-litellm-<TS> ~/.openclaw/openclaw.json
# LiteLLM merged to main (commit 1ca59c3e) — no feature branch to delete
```
