# Docker Compose helpers using local gitignored env values.
ENV_FILE ?= .env.local
COMPOSE := docker compose --env-file $(ENV_FILE)

.PHONY: up down ps logs health

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs --tail=80 openclaw-gateway

health:
	curl -fsS http://127.0.0.1:18789/health && echo
