module.exports = {
  apps: [
    {
      name: "mission-control",
      script: ".next/standalone/server.js",
      cwd: "/Users/a-binghaith/projects/openclaw-mission-control",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 2000,
      // Memory limit — restart if exceeds 512MB
      max_memory_restart: "512M",
      // Logs
      error_file: "/Users/a-binghaith/projects/openclaw-mission-control/logs/error.log",
      out_file: "/Users/a-binghaith/projects/openclaw-mission-control/logs/out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
