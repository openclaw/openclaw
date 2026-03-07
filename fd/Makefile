# ---- CONFIG ----
DB_PATH ?= ./data/openclaw.db
MIGRATIONS_DIR ?= ./db/migrations
PYTHON ?= python3
HOST ?= 0.0.0.0
PORT ?= 8080

# ---- Cluster config (DA) ----
# SSH aliases: claw-m4 -> fdclaw-m4@10.0.0.10, claw-i7 -> fdclaw-i7@10.0.0.11
# Controller: M1 @ 10.0.0.145 (runs Makefile + pushes code)
CLUSTER_HOSTS ?= claw-m4 claw-i7
REMOTE_APP_DIR ?= ~/openclaw
REMOTE_DB_PATH ?= $(REMOTE_APP_DIR)/data/openclaw.db
REMOTE_MIGRATIONS_DIR ?= $(REMOTE_APP_DIR)/db/migrations

# rsync exclusions (keep it fast + safe)
RSYNC_EXCLUDES = \
	--exclude .git \
	--exclude __pycache__ \
	--exclude .pytest_cache \
	--exclude .mypy_cache \
	--exclude .ruff_cache \
	--exclude .DS_Store \
	--exclude data \
	--exclude .venv \
	--exclude node_modules \
	--exclude '*.egg-info' \
	--exclude .eggs

# ---- Tmux session name for background services ----
TMUX_SESSION ?= openclaw

# ---- PHONY ----
.PHONY: help install dev test lint typecheck
.PHONY: db-init db-dry db-reset db-status seed full-bootstrap
.PHONY: cluster-check cluster-sync cluster-bootstrap cluster-status cluster-start-dev
.PHONY: cluster-update cluster-start cluster-stop cluster-logs cluster-restart
.PHONY: gateway-start gateway-stop healthcheck warm-models failover
.PHONY: docker-build docker-up docker-down
.PHONY: ci-migrations

# ---- DEFAULT ----
help:
	@echo "Available commands:"
	@echo ""
	@echo "  Bootstrap:"
	@echo "    make full-bootstrap    -> DB migrate + seed + dev server"
	@echo "    make cluster-bootstrap -> Bootstrap all cluster nodes (first-time)"
	@echo "    make cluster-check     -> Verify SSH connectivity to nodes"
	@echo ""
	@echo "  Cluster Operations:"
	@echo "    make cluster-update    -> git pull + migrate on all nodes"
	@echo "    make cluster-status    -> Git hash, migrations, service health per node"
	@echo "    make cluster-start     -> Start services in tmux on all nodes"
	@echo "    make cluster-stop      -> Stop tmux sessions on all nodes"
	@echo "    make cluster-restart   -> Stop + start on all nodes"
	@echo "    make cluster-logs      -> Tail live logs from all nodes"
	@echo ""
	@echo "  OpenClaw Gateway:"
	@echo "    make gateway-start     -> Start OpenClaw Gateway on M4"
	@echo "    make gateway-stop      -> Stop OpenClaw Gateway"
	@echo "    make healthcheck       -> Run full cluster health check"
	@echo "    make warm-models       -> Pre-warm Ollama models on M1"
	@echo "    make failover          -> Check M1 + failover to M4 if needed"
	@echo ""
	@echo "  Build / Dev:"
	@echo "    make install           -> Install with dev dependencies"
	@echo "    make dev               -> Start dev server (port $(PORT))"
	@echo "    make test              -> Run tests"
	@echo "    make lint              -> Lint with ruff"
	@echo "    make typecheck         -> Type-check with mypy"
	@echo ""
	@echo "  Database:"
	@echo "    make db-init           -> Run all migrations"
	@echo "    make db-dry            -> Show pending migrations (no changes)"
	@echo "    make db-reset          -> Delete DB and re-run migrations"
	@echo "    make db-status         -> Show applied migrations"
	@echo "    make seed              -> Insert minimal seed data"
	@echo ""
	@echo "  Docker:"
	@echo "    make docker-build      -> Build container"
	@echo "    make docker-up         -> Build + start with docker compose"
	@echo "    make docker-down       -> Stop containers"
	@echo ""
	@echo "  CI:"
	@echo "    make ci-migrations     -> Idempotency check for migrations"

# ---- FULL BOOTSTRAP (local) ----
full-bootstrap: db-init seed
	@echo "Starting dev server..."
	OPENCLAW_ENV=dev OPENCLAW_DB=$(DB_PATH) \
	$(PYTHON) -m packages.app --host $(HOST) --port $(PORT)

# ---- BUILD / DEV ----
install:
	$(PYTHON) -m pip install -U pip
	$(PYTHON) -m pip install -e ".[dev]"

dev:
	OPENCLAW_ENV=dev OPENCLAW_DB=$(DB_PATH) \
	$(PYTHON) -m packages.app --host $(HOST) --port $(PORT)

test:
	pytest -q

lint:
	ruff check .

typecheck:
	mypy .

# ---- MIGRATIONS ----
db-init:
	@echo "Running migrations..."
	$(PYTHON) -m packages.db.migrate --db $(DB_PATH) --migrations $(MIGRATIONS_DIR)

db-dry:
	@echo "Dry run..."
	$(PYTHON) -m packages.db.migrate --db $(DB_PATH) --migrations $(MIGRATIONS_DIR) --dry-run

db-reset:
ifeq ($(ENVIRONMENT),production)
	@echo "ERROR: Refusing to reset DB in production."
	@exit 1
else
	@echo "Resetting DB..."
	rm -f $(DB_PATH)
	$(MAKE) db-init
endif

db-status:
	@echo "Applied migrations:"
	@if [ -f "$(DB_PATH)" ]; then \
		$(PYTHON) -c "import sqlite3; conn = sqlite3.connect('$(DB_PATH)'); [print(f'{r[0]:45s} {r[1]}') for r in conn.execute('SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at')]"; \
	else \
		echo "  DB not found at $(DB_PATH)"; \
	fi

# ---- SEED ----
seed:
	@echo "Seeding minimal data (idempotent)..."
	$(PYTHON) -m packages.db.seed --db $(DB_PATH)

# ---- CLUSTER (M1 controller -> claw-m4, claw-i7) ----
# Deployment model: each node has its own git clone at ~/openclaw.
# GitHub is the distribution layer. rsync is only for non-repo assets.
# ~/cluster (SMB) is for jobs/logs/results ONLY — never repo or secrets.

cluster-check:
	@echo "Checking SSH connectivity..."
	@for h in $(CLUSTER_HOSTS); do \
		printf "  %-12s " "$$h:"; \
		ssh -o ConnectTimeout=5 $$h 'echo OK: $$(hostname)' 2>/dev/null || echo "FAILED"; \
	done

cluster-sync:
	@echo "Syncing repo to cluster nodes via rsync (use cluster-update for git-based deploy)..."
	@for h in $(CLUSTER_HOSTS); do \
		echo "  ==> rsync to $$h:$(REMOTE_APP_DIR)"; \
		ssh $$h 'mkdir -p $(REMOTE_APP_DIR)'; \
		rsync -az --delete $(RSYNC_EXCLUDES) ./ $$h:$(REMOTE_APP_DIR)/; \
	done
	@echo "cluster-sync complete"

cluster-bootstrap: cluster-check
	@echo "Bootstrapping nodes (venv + deps + migrate + seed)..."
	@echo "NOTE: Each node must have a git clone at $(REMOTE_APP_DIR) first."
	@echo "  If not yet cloned: ssh <host> 'git clone <repo-url> $(REMOTE_APP_DIR)'"
	@for h in $(CLUSTER_HOSTS); do \
		echo "==> bootstrap $$h"; \
		ssh $$h 'APP_DIR=$(REMOTE_APP_DIR) DB_PATH=$(REMOTE_DB_PATH) bash $(REMOTE_APP_DIR)/scripts/remote_bootstrap.sh'; \
	done
	@echo "cluster-bootstrap complete"

cluster-update:
	@echo "Updating cluster nodes (git pull + migrate)..."
	@for h in $(CLUSTER_HOSTS); do \
		printf "\n==> $$h\n"; \
		ssh -o ConnectTimeout=5 $$h '\
			cd $(REMOTE_APP_DIR) && \
			echo "  pulling..." && \
			git pull --ff-only 2>&1 | sed "s/^/  /" && \
			if [ -d ".venv" ]; then \
				source .venv/bin/activate && \
				echo "  installing deps..." && \
				pip install -e "." -q 2>&1 | tail -1 | sed "s/^/  /" && \
				echo "  migrating..." && \
				python -m packages.db.migrate \
					--db $(REMOTE_DB_PATH) \
					--migrations $(REMOTE_MIGRATIONS_DIR) 2>&1 | sed "s/^/  /"; \
			else \
				echo "  WARN: no .venv found — run make cluster-bootstrap first"; \
			fi' || echo "  FAILED (SSH error)"; \
	done
	@echo "\ncluster-update complete"

cluster-status:
	@echo "Cluster Status:"
	@echo "──────────────────────────────────────────────────────────────"
	@for h in $(CLUSTER_HOSTS); do \
		printf "\n  %-12s\n" "$$h:"; \
		ssh -o ConnectTimeout=5 $$h '\
			cd $(REMOTE_APP_DIR) 2>/dev/null && \
			printf "    git:        %s (%s)\n" "$$(git rev-parse --short HEAD 2>/dev/null || echo "no-repo")" "$$(git branch --show-current 2>/dev/null || echo "?")" && \
			if [ -f $(REMOTE_DB_PATH) ]; then \
				count=$$(sqlite3 $(REMOTE_DB_PATH) "SELECT COUNT(*) FROM schema_migrations;" 2>/dev/null || echo "?"); \
				printf "    migrations: %s applied\n" "$$count"; \
			else \
				echo "    migrations: DB not found"; \
			fi && \
			if tmux has-session -t $(TMUX_SESSION) 2>/dev/null; then \
				echo "    service:    RUNNING (tmux: $(TMUX_SESSION))"; \
			else \
				echo "    service:    STOPPED"; \
			fi && \
			printf "    uptime:     %s\n" "$$(uptime -s 2>/dev/null || uptime | sed "s/.*up /up /" | sed "s/,.*//")"' \
		2>/dev/null || echo "    SSH FAILED"; \
	done
	@echo ""

cluster-start:
	@echo "Starting services on cluster nodes (tmux: $(TMUX_SESSION))..."
	@for h in $(CLUSTER_HOSTS); do \
		printf "  %-12s " "$$h:"; \
		ssh -o ConnectTimeout=5 $$h '\
			if tmux has-session -t $(TMUX_SESSION) 2>/dev/null; then \
				echo "already running"; \
			else \
				mkdir -p ~/cluster/logs && \
				tmux new-session -d -s $(TMUX_SESSION) \
					"cd $(REMOTE_APP_DIR) && source .venv/bin/activate && \
					OPENCLAW_DB=$(REMOTE_DB_PATH) \
					OPENCLAW_MIGRATIONS=$(REMOTE_MIGRATIONS_DIR) \
					OPENCLAW_AUTO_MIGRATE=true \
					python -m packages.app --host 0.0.0.0 --port 8080 2>&1 | tee -a ~/cluster/logs/$$(hostname)-app.log" && \
				tmux new-window -t $(TMUX_SESSION) \
					"cd $(REMOTE_APP_DIR) && source .venv/bin/activate && \
					OPENCLAW_DB=$(REMOTE_DB_PATH) \
					python -m packages.jobs.worker 2>&1 | tee -a ~/cluster/logs/$$(hostname)-worker.log" && \
				echo "STARTED (app + worker)"; \
			fi' 2>/dev/null || echo "SSH FAILED"; \
	done

cluster-stop:
	@echo "Stopping services on cluster nodes..."
	@for h in $(CLUSTER_HOSTS); do \
		printf "  %-12s " "$$h:"; \
		ssh -o ConnectTimeout=5 $$h '\
			if tmux has-session -t $(TMUX_SESSION) 2>/dev/null; then \
				tmux kill-session -t $(TMUX_SESSION) && echo "STOPPED"; \
			else \
				echo "not running"; \
			fi' 2>/dev/null || echo "SSH FAILED"; \
	done

cluster-restart: cluster-stop cluster-start

cluster-logs:
	@echo "Tailing logs from cluster nodes (Ctrl+C to stop)..."
	@echo "──────────────────────────────────────────────────────────────"
	@for h in $(CLUSTER_HOSTS); do \
		echo "==> $$h (last 20 lines + follow)"; \
		ssh -o ConnectTimeout=5 $$h '\
			logfile=~/cluster/logs/$$(hostname)-app.log; \
			if [ -f "$$logfile" ]; then \
				tail -20f "$$logfile"; \
			else \
				echo "  no log file yet"; \
			fi' 2>/dev/null || echo "  SSH FAILED"; \
	done

# ---- OPENCLAW GATEWAY ----
# Gateway runs on M4 (always-on coordinator).
# Requires: npm install -g openclaw@latest

gateway-start:
	@echo "Starting OpenClaw Gateway on M4..."
	@ssh -o ConnectTimeout=5 claw-m4 '\
		cd $(REMOTE_APP_DIR) && \
		bash scripts/start-gateway.sh' \
	2>/dev/null || echo "SSH FAILED"

gateway-stop:
	@echo "Stopping OpenClaw Gateway on M4..."
	@ssh -o ConnectTimeout=5 claw-m4 '\
		if tmux has-session -t openclaw-gateway 2>/dev/null; then \
			tmux kill-session -t openclaw-gateway && echo "STOPPED"; \
		else \
			echo "not running"; \
		fi' 2>/dev/null || echo "SSH FAILED"

healthcheck:
	@bash scripts/healthcheck.sh

warm-models:
	@bash scripts/warm-models.sh

failover:
	@bash scripts/failover.sh

# ---- DOCKER ----
docker-build:
	docker build -t openclaw:dev .

docker-up:
	docker compose up --build

docker-down:
	docker compose down

# ---- CI ----
ci-migrations:
	@echo "CI: migration idempotency check..."
	rm -f /tmp/openclaw_ci.db
	$(PYTHON) -m packages.db.migrate --db /tmp/openclaw_ci.db --migrations $(MIGRATIONS_DIR)
	$(PYTHON) -m packages.db.migrate --db /tmp/openclaw_ci.db --migrations $(MIGRATIONS_DIR)
	rm -f /tmp/openclaw_ci.db
	@echo "CI migration check passed (idempotent)."
