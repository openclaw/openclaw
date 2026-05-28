// ProcessManager.mjs — 自動重啟 & 健康監控
// 解決問題：程序崩潰後無人守護，需手動重啟
//
// 功能：
//   1. 子程序守護（spawn + auto-restart）
//   2. 健康心跳檢查（每 N 秒）
//   3. 崩潰次數限制（超過停止重啟）
//   4. 優雅關閉 (graceful shutdown)
//   5. 生成 ecosystem.config.cjs（PM2 設定）

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── PM2 設定產生器 ────────────────────────────────────────────────
/**
 * 產生 PM2 ecosystem.config.cjs，讓 PM2 管理自動重啟
 */
export function generatePm2Config(opts = {}) {
  const {
    name = "openclaw-strategy",
    script = "scripts/openclaw-strategy-runner.mjs",
    args = [],
    instances = 1,
    maxMemoryMb = 512,
    restartDelay = 5000,
    logDir = "logs",
    cwd = process.cwd(),
  } = opts;

  const config = {
    apps: [
      {
        name,
        script,
        args: args.join(" "),
        instances,
        exec_mode: instances > 1 ? "cluster" : "fork",
        interpreter: "node",
        interpreter_args: "--experimental-vm-modules",
        watch: false,
        max_memory_restart: `${maxMemoryMb}M`,
        restart_delay: restartDelay,
        max_restarts: 10,
        min_uptime: "30s",
        cwd,
        env: {
          NODE_ENV: "production",
          NODE_OPTIONS: "--max-old-space-size=512",
        },
        log_date_format: "YYYY-MM-DD HH:mm:ss",
        out_file: path.join(logDir, `${name}-out.log`),
        error_file: path.join(logDir, `${name}-err.log`),
        merge_logs: true,
      },
    ],
  };

  const content = `// PM2 Ecosystem Config — 自動生成，請勿手動修改\nmodule.exports = ${JSON.stringify(config, null, 2)};\n`;
  const filePath = path.join(cwd, "ecosystem.config.cjs");
  writeFileSync(filePath, content);
  console.log(`[ProcessManager] PM2 設定已生成: ${filePath}`);
  console.log("  啟動: pm2 start ecosystem.config.cjs");
  console.log("  狀態: pm2 status");
  console.log("  日誌: pm2 logs openclaw-strategy");
  console.log("  停止: pm2 stop openclaw-strategy");
  return filePath;
}

// ── 內建守護進程（不需要 PM2）────────────────────────────────────
export class ProcessWatcher {
  /**
   * @param {string}   scriptPath   要守護的腳本路徑
   * @param {string[]} args         啟動參數
   * @param {object}   opts
   * @param {number}   opts.maxRestarts    最大重啟次數（預設 10）
   * @param {number}   opts.restartDelay  重啟延遲 ms（預設 5000）
   * @param {number}   opts.resetWindow   重啟次數重置窗口 ms（預設 3600000 = 1h）
   * @param {number}   opts.healthPort    健康檢查 HTTP 埠（0=停用）
   * @param {Function} opts.onCrash       崩潰回呼
   */
  constructor(scriptPath, args = [], opts = {}) {
    this.scriptPath = scriptPath;
    this.args = args;
    this.maxRestarts = opts.maxRestarts ?? 10;
    this.restartDelay = opts.restartDelay ?? 5_000;
    this.resetWindow = opts.resetWindow ?? 3_600_000;
    this.onCrash = opts.onCrash ?? null;

    this._proc = null;
    this._restarts = 0;
    this._firstStart = Date.now();
    this._running = false;
  }

  start() {
    this._running = true;
    console.log(`[ProcessWatcher] 守護啟動: ${this.scriptPath}`);
    this._spawn();
  }

  stop() {
    this._running = false;
    if (this._proc) {
      this._proc.kill("SIGINT");
      this._proc = null;
    }
    console.log("[ProcessWatcher] 守護停止");
  }

  _spawn() {
    // 重置計數器（超過 resetWindow 後重啟次數歸零）
    if (Date.now() - this._firstStart > this.resetWindow) {
      this._restarts = 0;
      this._firstStart = Date.now();
    }

    this._proc = spawn(process.execPath, [this.scriptPath, ...this.args], {
      stdio: "inherit",
      env: process.env,
    });

    this._proc.on("exit", (code, signal) => {
      if (!this._running) {
        return;
      }

      console.error(`[ProcessWatcher] 程序結束 code=${code} signal=${signal}`);
      this._restarts++;

      if (code === 0) {
        console.log("[ProcessWatcher] 正常結束，停止守護");
        return;
      }

      if (this._restarts > this.maxRestarts) {
        console.error(`[ProcessWatcher] 重啟次數超過 ${this.maxRestarts}，放棄守護`);
        this.onCrash?.({ code, signal, restarts: this._restarts });
        return;
      }

      console.log(
        `[ProcessWatcher] ${this.restartDelay / 1000}s 後重啟... (第 ${this._restarts}/${this.maxRestarts} 次)`,
      );
      setTimeout(() => {
        if (this._running) {
          this._spawn();
        }
      }, this.restartDelay);
    });

    this._proc.on("error", (err) => {
      console.error(`[ProcessWatcher] 啟動失敗: ${err.message}`);
    });
  }

  status() {
    return {
      running: this._running,
      pid: this._proc?.pid,
      restarts: this._restarts,
    };
  }
}

// ── 健康端點（讓 PM2/k8s 做健康檢查）───────────────────────────
export class HealthEndpoint {
  /**
   * @param {number} port   HTTP 健康檢查埠（預設 3211）
   * @param {object} engine StrategyEngine 實例
   */
  constructor(port = 3211, engine = null) {
    this.port = port;
    this.engine = engine;
    this._server = null;
  }

  start() {
    this._server = createServer((req, res) => {
      if (req.url === "/health" || req.url === "/") {
        const status = {
          status: "ok",
          uptime: process.uptime(),
          memMb: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
          strategies: this.engine?.strategies?.length ?? 0,
          running: this.engine?._running ?? false,
          ts: new Date().toISOString(),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
    });
    this._server.listen(this.port, () => {
      console.log(`[HealthEndpoint] http://localhost:${this.port}/health`);
    });
  }

  stop() {
    this._server?.close();
  }
}

// ── 進入點：守護模式 CLI ─────────────────────────────────────────
// 用法: node scripts/strategy-engine/utils/ProcessManager.mjs --watch scripts/openclaw-strategy-runner.mjs --live
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const watchIdx = args.indexOf("--watch");

  if (args.includes("--gen-pm2")) {
    // 產生 PM2 設定
    generatePm2Config({
      args: args.filter((a) => a !== "--gen-pm2"),
    });
  } else if (watchIdx >= 0) {
    // 守護模式
    const script = args[watchIdx + 1];
    const rest = args.filter((_, i) => i !== watchIdx && i !== watchIdx + 1);
    const watcher = new ProcessWatcher(script, rest, {
      maxRestarts: 10,
      restartDelay: 5000,
    });
    watcher.start();
    process.on("SIGINT", () => {
      watcher.stop();
      process.exit(0);
    });
  } else {
    console.log("用法:");
    console.log("  守護模式: node ProcessManager.mjs --watch <script> [args...]");
    console.log("  PM2 設定: node ProcessManager.mjs --gen-pm2 [args...]");
  }
}
