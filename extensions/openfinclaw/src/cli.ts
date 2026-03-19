/**
 * CLI commands for strategy management.
 */
import type { Command } from "commander";
import { forkStrategy, fetchStrategyInfo } from "./fork.js";
import { listLocalStrategies, findLocalStrategy, removeLocalStrategy } from "./strategy-storage.js";
import type { SkillApiConfig, LeaderboardResponse, BoardType } from "./types.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export function registerStrategyCli(params: {
  program: Command;
  config: SkillApiConfig;
  logger: Logger;
}) {
  const { program, config } = params;

  const root = program
    .command("strategy")
    .description("Strategy management: fork from Hub, list local, validate (FEP v2.0)");

  // ── strategy leaderboard ──
  root
    .command("leaderboard [boardType]")
    .description("Query strategy leaderboard from Hub (no API key required)")
    .option("-l, --limit <number>", "Number of results (max 100)", "20")
    .option("-o, --offset <number>", "Offset for pagination", "0")
    .action(
      async (boardType: BoardType = "composite", options: { limit?: string; offset?: string }) => {
        const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
        const offset = Math.max(Number(options.offset) || 0, 0);

        const url = new URL(`${config.baseUrl}/api/v1/skill/leaderboard/${boardType}`);
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("offset", String(offset));

        try {
          const response = await fetch(url.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(config.requestTimeoutMs),
          });

          if (!response.ok) {
            console.error(`✗ 请求失败: HTTP ${response.status}`);
            process.exitCode = 1;
            return;
          }

          const data = (await response.json()) as LeaderboardResponse;
          const boardNames: Record<string, string> = {
            composite: "综合榜",
            returns: "收益榜",
            risk: "风控榜",
            popular: "人气榜",
            rising: "新星榜",
          };

          console.log(
            `${boardNames[boardType] || boardType} Top ${data.strategies.length} (共 ${data.total} 个策略):`,
          );
          console.log("");

          for (const s of data.strategies) {
            const perf = s.performance || {};
            const returnStr =
              typeof perf.returnSincePublish === "number"
                ? `收益: ${(perf.returnSincePublish * 100).toFixed(1)}%`
                : "收益: --";
            const sharpeStr =
              typeof perf.sharpeRatio === "number"
                ? `夏普: ${perf.sharpeRatio.toFixed(2)}`
                : "夏普: --";
            const ddStr =
              typeof perf.maxDrawdown === "number"
                ? `回撤: ${(perf.maxDrawdown * 100).toFixed(1)}%`
                : "回撤: --";
            const author = s.author?.displayName || "未知";

            const truncatedName = s.name.length > 35 ? s.name.slice(0, 32) + "..." : s.name;
            const hubUrl = `https://hub.openfinclaw.ai/strategy/${s.id}`;
            const nameLink = `[${truncatedName}](${hubUrl})`;
            console.log(
              `#${String(s.rank).padStart(2)}  ${nameLink}  ${returnStr}  ${sharpeStr}  ${ddStr}  作者: ${author}`,
            );
          }

          console.log("");
          console.log("使用 openclaw strategy show <id> --remote 查看详情");
          console.log("使用 openclaw strategy fork <id> 下载策略（需要 API Key）");
        } catch (err) {
          console.error(`✗ 请求失败: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      },
    );

  // ── strategy fork ──
  root
    .command("fork <strategy-id>")
    .description("Fork a strategy from hub.openfinclaw.ai to local directory")
    .option("-d, --dir <path>", "Custom target directory")
    .option("--date <date>", "Date directory (YYYY-MM-DD, default: today)")
    .option("-y, --yes", "Skip confirmation", false)
    .action(async (strategyId: string, options: { dir?: string; date?: string; yes?: boolean }) => {
      const result = await forkStrategy(config, strategyId, {
        targetDir: options.dir,
        dateDir: options.date,
        skipConfirm: options.yes,
      });

      if (result.success) {
        console.log("✓ 策略 Fork 成功！");
        console.log("");
        console.log(`  名称: ${result.sourceName}`);
        console.log(`  本地路径: ${result.localPath}`);
        console.log("");
        console.log("下一步:");
        console.log(`  编辑: code ${result.localPath}/scripts/strategy.py`);
        console.log(`  验证: openfinclaw strategy validate ${result.localPath}`);
        console.log(`  发布: openfinclaw strategy publish ${result.localPath}`);
      } else {
        console.error(`✗ Fork 失败: ${result.error}`);
        process.exitCode = 1;
      }
    });

  // ── strategy list ──
  root
    .command("list")
    .description("List all local strategies")
    .option("--json", "Output as JSON", false)
    .action(async (options: { json?: boolean }) => {
      const strategies = await listLocalStrategies();

      if (options.json) {
        console.log(JSON.stringify(strategies, null, 2));
        return;
      }

      if (strategies.length === 0) {
        console.log("本地暂无策略。");
        console.log("");
        console.log("使用 'openfinclaw strategy fork <id>' 从 Hub 下载策略。");
        return;
      }

      console.log(`本地策略列表 (共 ${strategies.length} 个):`);
      console.log("");

      let currentDate = "";
      for (const s of strategies) {
        if (s.dateDir !== currentDate) {
          currentDate = s.dateDir;
          console.log(`${s.dateDir}/`);
        }
        const typeLabel = s.type === "forked" ? "(forked)" : "(created)";
        const name = s.name.length > 40 ? s.name.slice(0, 37) + "..." : s.name;
        const displayName =
          s.displayName.length > 20 ? s.displayName.slice(0, 17) + "..." : s.displayName;
        console.log(`  ${name.padEnd(40)} ${displayName.padEnd(20)} ${typeLabel}`);
      }
    });

  // ── strategy show ──
  root
    .command("show <name-or-id>")
    .description("Show strategy details")
    .option("--remote", "Fetch latest info from Hub", false)
    .option("--json", "Output as JSON", false)
    .action(async (nameOrId: string, options: { remote?: boolean; json?: boolean }) => {
      const local = await findLocalStrategy(nameOrId);

      if (!local && !options.remote) {
        console.error(`✗ 本地策略未找到: ${nameOrId}`);
        console.error("  使用 --remote 从 Hub 获取信息");
        process.exitCode = 1;
        return;
      }

      if (options.remote && local?.sourceId) {
        const infoResult = await fetchStrategyInfo(config, local.sourceId);
        if (infoResult.success && infoResult.data) {
          const info = infoResult.data;
          if (options.json) {
            console.log(JSON.stringify({ local, hub: info }, null, 2));
            return;
          }
          printStrategyInfo(local, info);
          return;
        }
      }

      if (local) {
        if (options.json) {
          console.log(JSON.stringify(local, null, 2));
          return;
        }
        printLocalStrategy(local);
        return;
      }

      console.error(`✗ 策略未找到: ${nameOrId}`);
      process.exitCode = 1;
    });

  // ── strategy remove ──
  root
    .command("remove <name-or-id>")
    .alias("rm")
    .description("Remove a local strategy")
    .option("-f, --force", "Force removal without confirmation", false)
    .action(async (nameOrId: string, options: { force?: boolean }) => {
      const local = await findLocalStrategy(nameOrId);
      if (!local) {
        console.error(`✗ 策略未找到: ${nameOrId}`);
        process.exitCode = 1;
        return;
      }

      if (!options.force) {
        console.log(`即将删除策略: ${local.displayName}`);
        console.log(`  路径: ${local.localPath}`);
        console.log("");
        console.log("使用 --force 确认删除");
        return;
      }

      const result = await removeLocalStrategy(nameOrId);
      if (result.success) {
        console.log("✓ 策略已删除");
      } else {
        console.error(`✗ 删除失败: ${result.error}`);
        process.exitCode = 1;
      }
    });

  // ── strategy validate ──
  root
    .command("validate <path>")
    .description("Validate a local strategy package (FEP v2.0)")
    .action(async (_path: string) => {
      console.log("验证功能请使用 skill_validate 工具");
      console.log("  调用 skill_validate 并传入目录路径");
    });
}

function printLocalStrategy(s: {
  name: string;
  displayName: string;
  localPath: string;
  dateDir: string;
  type: string;
  sourceId?: string;
  createdAt: string;
}) {
  console.log("本地策略信息:");
  console.log("");
  console.log(`  名称: ${s.displayName}`);
  console.log(`  目录: ${s.name}`);
  console.log(`  路径: ${s.localPath}`);
  console.log(`  日期: ${s.dateDir}`);
  console.log(`  类型: ${s.type === "forked" ? "Fork 自 Hub" : "自建"}`);
  if (s.sourceId) {
    console.log(`  来源 ID: ${s.sourceId}`);
  }
  console.log(`  创建时间: ${s.createdAt}`);
}

function printStrategyInfo(
  local: { name: string; displayName: string; localPath: string; sourceId?: string },
  hub: {
    id: string;
    name: string;
    version?: string;
    author?: { displayName?: string };
    market?: string;
    description?: string;
    backtestResult?: {
      totalReturn?: number;
      sharpe?: number;
      maxDrawdown?: number;
      winRate?: number;
    };
  },
) {
  console.log("策略信息:");
  console.log("");
  console.log("本地:");
  console.log(`  路径: ${local.localPath}`);
  console.log("");
  console.log("Hub:");
  console.log(`  ID: ${hub.id}`);
  console.log(`  名称: ${hub.name}`);
  if (hub.version) console.log(`  版本: ${hub.version}`);
  if (hub.author?.displayName) console.log(`  作者: ${hub.author.displayName}`);
  if (hub.market) console.log(`  市场: ${hub.market}`);
  if (hub.description) console.log(`  描述: ${hub.description}`);

  if (hub.backtestResult) {
    console.log("");
    console.log("绩效:");
    const perf = hub.backtestResult;
    if (typeof perf.totalReturn === "number") {
      console.log(`  总收益率: ${(perf.totalReturn * 100).toFixed(2)}%`);
    }
    if (typeof perf.sharpe === "number") {
      console.log(`  夏普比率: ${perf.sharpe.toFixed(3)}`);
    }
    if (typeof perf.maxDrawdown === "number") {
      console.log(`  最大回撤: ${(perf.maxDrawdown * 100).toFixed(2)}%`);
    }
    if (typeof perf.winRate === "number") {
      console.log(`  胜率: ${(perf.winRate * 100).toFixed(1)}%`);
    }
  }
}
