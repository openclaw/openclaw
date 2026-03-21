BASE_IMAGE       = openclaw:local
TONY_IMAGE       = openclaw-tony:local
SANDBOX_BASE     = openclaw-sandbox:bookworm-slim
SANDBOX_COMMON   = openclaw-sandbox:common
SANDBOX_TONY     = openclaw-sandbox:tony
CONTAINER        = openclaw-gateway
GATEWAY_PORT    ?= 18789
GATEWAY_URL     ?= http://localhost:$(GATEWAY_PORT)

.PHONY: build build-base build-tony build-sandbox build-sandbox-tony up down dev-gateway restart restart-tony logs status clean

# Full rebuild — upstream changed (rare)
build: build-base build-sandbox build-tony build-sandbox-tony

# Only rebuild base — after git pull on upstream openclaw
build-base:
	docker build --build-arg OPENCLAW_EXTENSIONS="matrix acpx" -t $(BASE_IMAGE) .

# Only rebuild upstream sandbox base + common — after git pull (Step 2)
build-sandbox:
	docker build -f Dockerfile.sandbox -t $(SANDBOX_BASE) .
	docker build -f Dockerfile.sandbox-common -t $(SANDBOX_COMMON) .

# Only rebuild your layer — after editing Dockerfile.tony (common)
build-tony:
	docker build -f Dockerfile.tony -t $(TONY_IMAGE) .

# Only rebuild Tony's sandbox — after editing Dockerfile.sandbox-tony (Step 4)
# DOCKER_BUILDKIT=0 avoids "mount options is too long" on Docker Desktop (base has many layers)
build-sandbox-tony:
	DOCKER_BUILDKIT=0 docker build -f Dockerfile.sandbox-tony -t $(SANDBOX_TONY) .

# Start gateway (first time or after down)
up:
	docker compose -f docker-compose.yml -f docker-compose.override.yml up -d
	@sleep 2 && curl -sf $(GATEWAY_URL)/healthz \
		&& echo "  gateway UP" || echo "  check: make logs"

# Fast local dev loop — host watcher for TypeScript and gateway edits
dev-gateway:
	pnpm gateway:watch

# Soft restart — hot-swap container only, memory preserved (daily use)
restart-tony: build-tony
	docker compose -f docker-compose.yml -f docker-compose.override.yml \
		up -d --force-recreate openclaw-gateway
	@sleep 2 && curl -sf $(GATEWAY_URL)/healthz \
		&& echo "  hot-swap done" || echo "  check: make logs"

# Full restart — after upstream pull (rare)
restart: build build-sandbox-tony
	docker compose -f docker-compose.yml -f docker-compose.override.yml \
		up -d --force-recreate openclaw-gateway
	@sleep 2 && curl -sf $(GATEWAY_URL)/healthz \
		&& echo "  full rebuild done" || echo "  check: make logs"

down:
	docker compose -f docker-compose.yml -f docker-compose.override.yml down

logs:
	docker logs -f $(CONTAINER)

status:
	@echo "=== images ===" \
		&& docker images --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}" \
		| grep -E "openclaw|REPO" \
		&& echo "\n=== gateway ===" \
		&& curl -sf $(GATEWAY_URL)/healthz && echo " UP" || echo " DOWN"

# Nuclear — rebuild everything from scratch (debugging only)
clean:
	docker compose -f docker-compose.yml -f docker-compose.override.yml down
	docker rmi $(TONY_IMAGE) $(BASE_IMAGE) $(SANDBOX_TONY) $(SANDBOX_COMMON) $(SANDBOX_BASE) 2>/dev/null || true
	$(MAKE) build
