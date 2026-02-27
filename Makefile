.PHONY: help vivgrid-gateway-local vivgrid-gateway-local-bg vivgrid-tui-local vivgrid-models-local vivgrid-reset-models-list vivgrid-debug-config

LOCAL_GATEWAY_PORT ?= 18890
LOCAL_GATEWAY_TOKEN ?=

help:
	@printf "Available targets:\n"
	@printf "  make vivgrid-gateway-local   # Start local gateway using current dist build\n"
	@printf "  make vivgrid-gateway-local-bg # Start local gateway in background\n"
	@printf "  make vivgrid-tui-local       # Open TUI and connect to local gateway\n"
	@printf "  make vivgrid-models-local    # Print models.list from local gateway\n"
	@printf "  make vivgrid-reset-models-list # Remove explicit vivgrid.models override\n"
	@printf "  make vivgrid-debug-config    # Print local Vivgrid config/debug info\n"
	@printf "\n"
	@printf "Optional vars:\n"
	@printf "  LOCAL_GATEWAY_PORT=18890\n"
	@printf "  LOCAL_GATEWAY_TOKEN=<token>  # optional override; default reads ~/.openclaw/openclaw.json gateway.auth.token\n"

vivgrid-gateway-local:
	@key=$$(zsh -lc 'source ~/.zshrc >/dev/null 2>&1 || true; print -r -- "$${VIVGRID_API_KEY:-$${vivgrid_api_key:-}}"'); \
	token="$(LOCAL_GATEWAY_TOKEN)"; \
	if [ -z "$$token" ]; then \
		token=$$(node -e 'const fs=require("fs"),p=(process.env.HOME||"")+"/.openclaw/openclaw.json";try{const c=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(c?.gateway?.auth?.token||"")}catch{process.stdout.write("")}'); \
	fi; \
	if [ -z "$$key" ]; then \
		echo "Vivgrid API key not found. Set VIVGRID_API_KEY or vivgrid_api_key in ~/.zshrc"; \
		exit 1; \
	fi; \
	if [ -z "$$token" ]; then \
		echo "Gateway token not found. Set LOCAL_GATEWAY_TOKEN or configure gateway.auth.token"; \
		exit 1; \
	fi; \
	pids=$$(lsof -ti tcp:$(LOCAL_GATEWAY_PORT) 2>/dev/null || true); \
	if [ -n "$$pids" ]; then \
		echo "Killing processes on port $(LOCAL_GATEWAY_PORT): $$pids"; \
		kill $$pids >/dev/null 2>&1 || true; \
		sleep 1; \
		left=$$(lsof -ti tcp:$(LOCAL_GATEWAY_PORT) 2>/dev/null || true); \
		if [ -n "$$left" ]; then \
			echo "Force killing remaining processes on port $(LOCAL_GATEWAY_PORT): $$left"; \
			kill -9 $$left >/dev/null 2>&1 || true; \
		fi; \
	fi; \
	echo "Starting local gateway on ws://127.0.0.1:$(LOCAL_GATEWAY_PORT)"; \
	echo "Token: $$token"; \
	VIVGRID_API_KEY="$$key" \
	node dist/index.js gateway run --bind loopback --port $(LOCAL_GATEWAY_PORT) --force

vivgrid-gateway-local-bg:
	@key=$$(zsh -lc 'source ~/.zshrc >/dev/null 2>&1 || true; print -r -- "$${VIVGRID_API_KEY:-$${vivgrid_api_key:-}}"'); \
	token="$(LOCAL_GATEWAY_TOKEN)"; \
	if [ -z "$$token" ]; then \
		token=$$(node -e 'const fs=require("fs"),p=(process.env.HOME||"")+"/.openclaw/openclaw.json";try{const c=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(c?.gateway?.auth?.token||"")}catch{process.stdout.write("")}'); \
	fi; \
	if [ -z "$$key" ]; then \
		echo "Vivgrid API key not found. Set VIVGRID_API_KEY or vivgrid_api_key in ~/.zshrc"; \
		exit 1; \
	fi; \
	if [ -z "$$token" ]; then \
		echo "Gateway token not found. Set LOCAL_GATEWAY_TOKEN or configure gateway.auth.token"; \
		exit 1; \
	fi; \
	pids=$$(lsof -ti tcp:$(LOCAL_GATEWAY_PORT) 2>/dev/null || true); \
	if [ -n "$$pids" ]; then \
		echo "Killing processes on port $(LOCAL_GATEWAY_PORT): $$pids"; \
		kill $$pids >/dev/null 2>&1 || true; \
		sleep 1; \
		left=$$(lsof -ti tcp:$(LOCAL_GATEWAY_PORT) 2>/dev/null || true); \
		if [ -n "$$left" ]; then \
			echo "Force killing remaining processes on port $(LOCAL_GATEWAY_PORT): $$left"; \
			kill -9 $$left >/dev/null 2>&1 || true; \
		fi; \
	fi; \
	log_file="/tmp/openclaw-vivgrid-gateway-$(LOCAL_GATEWAY_PORT).log"; \
	echo "Starting local gateway in background on ws://127.0.0.1:$(LOCAL_GATEWAY_PORT)"; \
	echo "Log: $$log_file"; \
	VIVGRID_API_KEY="$$key" \
	nohup node dist/index.js gateway run --bind loopback --port $(LOCAL_GATEWAY_PORT) --force >"$$log_file" 2>&1 & \
	for i in 1 2 3 4 5 6 7 8 9 10; do \
		if lsof -ti tcp:$(LOCAL_GATEWAY_PORT) >/dev/null 2>&1; then \
			echo "Gateway is ready."; \
			exit 0; \
		fi; \
		sleep 1; \
	done; \
	echo "Gateway failed to start. Last log lines:"; \
	tail -n 40 "$$log_file" || true; \
	exit 1

vivgrid-tui-local:
	@key=$$(zsh -lc 'source ~/.zshrc >/dev/null 2>&1 || true; print -r -- "$${VIVGRID_API_KEY:-$${vivgrid_api_key:-}}"'); \
	token="$(LOCAL_GATEWAY_TOKEN)"; \
	if [ -z "$$token" ]; then \
		token=$$(node -e 'const fs=require("fs"),p=(process.env.HOME||"")+"/.openclaw/openclaw.json";try{const c=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(c?.gateway?.auth?.token||"")}catch{process.stdout.write("")}'); \
	fi; \
	if [ -z "$$key" ]; then \
		echo "Vivgrid API key not found. Set VIVGRID_API_KEY or vivgrid_api_key in ~/.zshrc"; \
		exit 1; \
	fi; \
	if [ -z "$$token" ]; then \
		echo "Gateway token not found. Set LOCAL_GATEWAY_TOKEN or configure gateway.auth.token"; \
		exit 1; \
	fi; \
	ready=0; \
	for i in 1 2 3 4 5 6 7 8 9 10; do \
		if lsof -ti tcp:$(LOCAL_GATEWAY_PORT) >/dev/null 2>&1; then \
			ready=1; \
			break; \
		fi; \
		sleep 1; \
	done; \
	if [ "$$ready" -ne 1 ]; then \
		echo "Local gateway not reachable, attempting auto-start..."; \
		$(MAKE) --no-print-directory vivgrid-gateway-local-bg LOCAL_GATEWAY_PORT=$(LOCAL_GATEWAY_PORT) LOCAL_GATEWAY_TOKEN="$$token"; \
	fi; \
	echo "Connecting TUI to ws://127.0.0.1:$(LOCAL_GATEWAY_PORT)"; \
	VIVGRID_API_KEY="$$key" \
	node dist/index.js tui --url ws://127.0.0.1:$(LOCAL_GATEWAY_PORT) --token "$$token"

vivgrid-models-local:
	@token="$(LOCAL_GATEWAY_TOKEN)"; \
	if [ -z "$$token" ]; then \
		token=$$(node -e 'const fs=require("fs"),p=(process.env.HOME||"")+"/.openclaw/openclaw.json";try{const c=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(c?.gateway?.auth?.token||"")}catch{process.stdout.write("")}'); \
	fi; \
	if [ -z "$$token" ]; then \
		echo "Gateway token not found. Set LOCAL_GATEWAY_TOKEN or configure gateway.auth.token"; \
		exit 1; \
	fi; \
	OPENCLAW_GATEWAY_TOKEN="$$token" \
	node dist/index.js gateway call --url ws://127.0.0.1:$(LOCAL_GATEWAY_PORT) --token $$token models.list

vivgrid-reset-models-list:
	@echo "Removing explicit models.providers.vivgrid override..."; \
	node -e 'const fs=require("fs"); const path=(process.env.HOME||"")+"/.openclaw/openclaw.json"; if(!fs.existsSync(path)){ console.log("Config file not found:", path); process.exit(0);} const cfg=JSON.parse(fs.readFileSync(path,"utf8")); const providers=cfg?.models?.providers; if(providers && Object.prototype.hasOwnProperty.call(providers,"vivgrid")){ delete providers.vivgrid; if(Object.keys(providers).length===0){ delete cfg.models.providers; } console.log("Removed models.providers.vivgrid from", path);} else { console.log("No explicit models.providers.vivgrid found in", path);} fs.writeFileSync(path, JSON.stringify(cfg,null,2)+"\n");'; \
	echo "Done. Restart gateway and rerun /models in TUI."

vivgrid-debug-config:
	@echo "== Vivgrid config debug =="; \
	echo "config path: $$HOME/.openclaw/openclaw.json"; \
	echo "-- models.providers.vivgrid --"; \
	node dist/index.js config get models.providers.vivgrid || true; \
	echo "-- models.providers.vivgrid.models --"; \
	node dist/index.js config get models.providers.vivgrid.models || true; \
	echo "-- agents.defaults.model.primary --"; \
	node dist/index.js config get agents.defaults.model.primary || true
