.PHONY: docker-compose-up
docker-compose-up:
	docker compose -f docker-compose.yml up -d

.PHONY: docker-compose-down
docker-compose-down:
	docker compose -f docker-compose.yml down

.PHONY: docker-compose-logs
docker-compose-logs:
	docker compose -f docker-compose.yml logs -f

.PHONY: docker-compose-logs-openclaw-gateway
docker-compose-logs-openclaw-gateway:
	docker compose -f docker-compose.yml logs -f openclaw-gateway
