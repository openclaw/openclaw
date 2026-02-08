-- OpenClaw Gateway Starter
-- Starts the gateway if not already running, then opens Control UI

on run
    -- Check for both "openclaw-gateway" (daemon) and "openclaw gateway" (cli invocation)
    set gatewayRunning to do shell script "pgrep -f 'openclaw-gateway|openclaw gateway' || echo ''"

    if gatewayRunning is "" then
        -- Gateway not running, start it
        -- Uses globally installed openclaw or falls back to npm/pnpm
        try
            do shell script "which openclaw > /dev/null 2>&1 && nohup openclaw gateway run --bind loopback --port 18789 > /tmp/openclaw-gateway.log 2>&1 &"
        on error
            -- Fallback: try npx
            do shell script "nohup npx openclaw gateway run --bind loopback --port 18789 > /tmp/openclaw-gateway.log 2>&1 &"
        end try
        delay 3
        do shell script "open http://127.0.0.1:18789/"
        display notification "OpenClaw Gateway started" with title "OpenClaw"
    else
        -- Already running, just open UI
        do shell script "open http://127.0.0.1:18789/"
        display notification "Gateway already running - opening UI" with title "OpenClaw"
    end if
end run
