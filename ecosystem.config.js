// ecosystem.config.js
module.exports = {
  apps: [
    // 1. OpenClaw 网关（核心服务）
    {
      name: "claw-gateway",        // 进程名
      script: "openclaw",          // 全局 CLI 命令
      args: "gateway start",       // 启动网关参数
      interpreter: "none",         // 关键：禁用 node 解释器（二进制 CLI）
      exec_mode: "fork",           // 单实例（网关暂不支持多实例）
      autorestart: true,           // 崩溃自动重启
      restart_delay: 3000,         // 重启延迟 3 秒
      max_restarts: 10,            // 最大重启次数（防无限循环）
      kill_timeout: 5000,          // 停止超时时间
      // 资源限制（根据服务器配置调整）
      max_memory_restart: "2G",    // 内存超 2G 自动重启
      // 日志配置
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/gateway-out.log",
      error_file: "./logs/gateway-err.log",
      // 环境变量
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
        PORT: 18789                // 网关端口（默认 18789）
      }
    },
    // 2. OpenClaw Dashboard（Web UI）
    {
      name: "claw-dashboard",      // 进程名
      script: "openclaw",          // 全局 CLI 命令
      args: "dashboard",           // 启动 UI 参数
      interpreter: "none",         // 关键：禁用 node 解释器
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 5,
      kill_timeout: 5000,
      // 日志配置
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/dashboard-out.log",
      error_file: "./logs/dashboard-err.log",
      // 环境变量（可自定义 UI 端口）
      env: {
        NODE_ENV: "production",
        DASHBOARD_PORT: 3000       // UI 端口（默认 3000）
      }
    }
  ]
};
