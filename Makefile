# Clawdbot Development Makefile
# Provides targets for building, deploying, and switching between dev/prod modes

SHELL := /bin/bash
PROJECT_DIR := $(shell pwd)
LAUNCHD_LABEL := com.clawdbot.gateway
LAUNCHD_LABEL_DEV := com.clawdbot.gateway.dev
LAUNCHD_PLIST := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL).plist
LAUNCHD_PLIST_DEV := $(HOME)/Library/LaunchAgents/$(LAUNCHD_LABEL_DEV).plist
GATEWAY_PORT := 18789

.PHONY: build restart deploy dev dev-daemon prod status logs help plist-dev

# Default target
help:
	@echo "Clawdbot Development Commands:"
	@echo ""
	@echo "  make build      - Build TypeScript to dist/"
	@echo "  make restart    - Restart the gateway service (launchd)"
	@echo "  make deploy     - Build and restart (use this after code changes)"
	@echo ""
	@echo "  make dev        - Stop launchd and run interactively with tsx (Ctrl+C to stop)"
	@echo "  make dev-daemon - Switch to dev mode via launchd (tsx, auto-restart, persistent)"
	@echo "  make prod       - Switch back to production mode (built dist/)"
	@echo ""
	@echo "  make status     - Show gateway process status and current mode"
	@echo "  make logs       - Tail gateway logs"
	@echo ""

# Build TypeScript to dist/
build:
	@echo "==> Building TypeScript..."
	pnpm build

# Restart the gateway service via launchd (whichever mode is active)
restart:
	@echo "==> Restarting gateway service..."
	@if launchctl list $(LAUNCHD_LABEL_DEV) >/dev/null 2>&1; then \
		echo "==> Restarting dev-daemon..."; \
		launchctl kickstart -k gui/$$(id -u)/$(LAUNCHD_LABEL_DEV); \
	elif launchctl list $(LAUNCHD_LABEL) >/dev/null 2>&1; then \
		echo "==> Restarting prod service..."; \
		launchctl kickstart -k gui/$$(id -u)/$(LAUNCHD_LABEL); \
	else \
		echo "No service loaded. Run 'make prod' or 'make dev-daemon' first."; \
		exit 1; \
	fi
	@sleep 2
	@$(MAKE) -s status-short

# Build and restart - the main deployment target (for prod mode)
deploy: build restart
	@echo "==> Deploy complete"

# Generate the dev-mode plist
plist-dev:
	@echo "==> Generating dev-mode plist..."
	@mkdir -p $(HOME)/Library/LaunchAgents
	@echo '<?xml version="1.0" encoding="UTF-8"?>' > $(LAUNCHD_PLIST_DEV)
	@echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' >> $(LAUNCHD_PLIST_DEV)
	@echo '<plist version="1.0">' >> $(LAUNCHD_PLIST_DEV)
	@echo '  <dict>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <key>Label</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <string>$(LAUNCHD_LABEL_DEV)</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <key>Comment</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <string>Clawdbot Gateway (dev mode - tsx)</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <key>RunAtLoad</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <true/>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <key>KeepAlive</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <true/>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <key>WorkingDirectory</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <string>$(PROJECT_DIR)</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <key>ProgramArguments</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <array>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>/opt/homebrew/bin/node</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>--import</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>tsx</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>$(PROJECT_DIR)/src/cli/index.ts</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>gateway</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>--port</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>$(GATEWAY_PORT)</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    </array>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <key>StandardOutPath</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <string>$(HOME)/.clawdbot/logs/gateway.log</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <key>StandardErrorPath</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <string>$(HOME)/.clawdbot/logs/gateway.err.log</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <key>EnvironmentVariables</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    <dict>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <key>HOME</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>$(HOME)</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <key>PATH</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$(HOME)/Library/pnpm</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <key>NODE_PATH</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>$(PROJECT_DIR)/node_modules</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <key>CLAWDBOT_GATEWAY_PORT</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>$(GATEWAY_PORT)</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <key>CLAWDBOT_LAUNCHD_LABEL</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>$(LAUNCHD_LABEL_DEV)</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <key>CLAWDBOT_SERVICE_KIND</key>' >> $(LAUNCHD_PLIST_DEV)
	@echo '      <string>gateway-dev</string>' >> $(LAUNCHD_PLIST_DEV)
	@echo '    </dict>' >> $(LAUNCHD_PLIST_DEV)
	@echo '  </dict>' >> $(LAUNCHD_PLIST_DEV)
	@echo '</plist>' >> $(LAUNCHD_PLIST_DEV)
	@echo "==> Created $(LAUNCHD_PLIST_DEV)"

# Switch to dev mode: stop launchd, run with tsx interactively
dev:
	@echo "==> Switching to interactive dev mode..."
	@# Stop any launchd services
	@launchctl unload $(LAUNCHD_PLIST_DEV) 2>/dev/null || true
	@launchctl unload $(LAUNCHD_PLIST) 2>/dev/null || true
	@echo ""
	@echo "==> Starting dev server (Ctrl+C to stop)..."
	@echo "==> Run 'make prod' or 'make dev-daemon' in another terminal to switch modes"
	@echo ""
	pnpm dev

# Switch to dev-daemon mode: tsx via launchd (persistent, auto-restart)
dev-daemon: plist-dev
	@echo "==> Switching to dev-daemon mode..."
	@# Stop prod service if running
	@if launchctl list $(LAUNCHD_LABEL) >/dev/null 2>&1; then \
		echo "==> Stopping prod service..."; \
		launchctl unload $(LAUNCHD_PLIST) 2>/dev/null || true; \
	fi
	@# Kill any interactive dev processes
	@pkill -f "tsx.*gateway" 2>/dev/null || true
	@# Load or restart dev service
	@if launchctl list $(LAUNCHD_LABEL_DEV) >/dev/null 2>&1; then \
		echo "==> Restarting dev-daemon..."; \
		launchctl kickstart -k gui/$$(id -u)/$(LAUNCHD_LABEL_DEV); \
	else \
		echo "==> Loading dev-daemon..."; \
		launchctl load $(LAUNCHD_PLIST_DEV); \
	fi
	@sleep 2
	@$(MAKE) -s status

# Switch back to prod mode: built dist/ via launchd
prod:
	@echo "==> Switching to prod mode..."
	@# Stop dev-daemon if running
	@if launchctl list $(LAUNCHD_LABEL_DEV) >/dev/null 2>&1; then \
		echo "==> Stopping dev-daemon..."; \
		launchctl unload $(LAUNCHD_PLIST_DEV) 2>/dev/null || true; \
	fi
	@# Kill any interactive dev processes
	@pkill -f "tsx.*gateway" 2>/dev/null || true
	@pkill -f "bun.*gateway" 2>/dev/null || true
	@# Load or restart prod service
	@if launchctl list $(LAUNCHD_LABEL) >/dev/null 2>&1; then \
		echo "==> Restarting prod service..."; \
		launchctl kickstart -k gui/$$(id -u)/$(LAUNCHD_LABEL); \
	else \
		echo "==> Loading prod service..."; \
		launchctl load $(LAUNCHD_PLIST); \
	fi
	@sleep 2
	@$(MAKE) -s status

# Show gateway process status
status:
	@echo "==> Gateway Status:"
	@echo ""
	@if launchctl list $(LAUNCHD_LABEL_DEV) >/dev/null 2>&1; then \
		echo "Mode: DEV-DAEMON (tsx via launchd)"; \
		echo ""; \
	elif launchctl list $(LAUNCHD_LABEL) >/dev/null 2>&1; then \
		echo "Mode: PROD (dist/ via launchd)"; \
		echo ""; \
	elif pgrep -f "tsx.*gateway" >/dev/null 2>&1; then \
		echo "Mode: DEV (interactive tsx)"; \
		echo ""; \
	else \
		echo "Mode: NOT RUNNING"; \
		echo ""; \
	fi
	@echo "Process:"
	@pgrep -fl "gateway" | grep -E "(clawdbot|node.*gateway|tsx.*gateway)" | head -3 || echo "  No gateway process found"
	@echo ""
	@echo "Port $(GATEWAY_PORT):"
	@lsof -i :$(GATEWAY_PORT) 2>/dev/null | grep LISTEN | head -1 || echo "  Nothing listening"
	@echo ""
	@curl -s http://localhost:$(GATEWAY_PORT)/ >/dev/null 2>&1 && echo "HTTP: Responding" || echo "HTTP: Not responding"

# Short status for internal use
status-short:
	@curl -s http://localhost:$(GATEWAY_PORT)/ >/dev/null 2>&1 && echo "Gateway is responding on port $(GATEWAY_PORT)" || echo "Warning: Gateway not responding yet"

# Tail gateway logs
logs:
	@tail -f $(HOME)/.clawdbot/logs/gateway.log
