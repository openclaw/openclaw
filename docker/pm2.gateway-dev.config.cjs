module.exports = {
  apps: [
    {
      name: "openclaw-gateway-dev",
      cwd: "/app",
      script: "pnpm",
      args: "exec tsx watch --clear-screen=false src/entry.ts gateway --tailscale serve --verbose",
      interpreter: "none",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1000,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "openclaw-ui-dev",
      cwd: "/app",
      script: "bash",
      args: "-lc 'sleep \"${OPENCLAW_UI_DEV_START_DELAY_SECONDS:-20}\"; exec pnpm --dir ui dev --host 0.0.0.0 --port 5173 --strictPort'",
      interpreter: "none",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 1000,
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "openclaw-queue-worker",
      cwd: "/app",
      script: "scripts/start-queue-daemon.sh",
      interpreter: "bash",
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      // Wait for gateway to be up before starting queue worker
      wait_ready: false,
      env: {
        NODE_ENV: "development",
      },
    },
  ],
};
