/**
 * Memory Core CLI 命令注册模块
 * 定义和注册所有 memory 相关的 CLI 命令
 */

// 从 commander 库导入 Command 类型，用于创建 CLI 命令
import type { Command } from "commander";

// 从 memory-core 主机运行时 CLI 模块导入格式化文档链接和帮助示例的函数
import {
  // 格式化文档链接的函数
  formatDocsLink,
  // 格式化帮助示例的函数
  formatHelpExamples,
  // 主题样式对象
  theme,
} from "openclaw/plugin-sdk/memory-core-host-runtime-cli";

// 从 CLI 类型模块导入各种命令选项类型
import type {
  // Memory 命令选项类型
  MemoryCommandOptions,
  // Memory 提升命令选项类型
  MemoryPromoteCommandOptions,
  // Memory 提升解释命令选项类型
  MemoryPromoteExplainOptions,
  // Memory REM 填充命令选项类型
  MemoryRemBackfillOptions,
  // Memory REM 测试工具选项类型
  MemoryRemHarnessOptions,
  // Memory 搜索命令选项类型
  MemorySearchCommandOptions,
} from "./cli.types.js";

// 从短期提升模块导入默认的提升参数常量
import {
  // 默认的最小回忆次数
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  // 默认的最小分数
  DEFAULT_PROMOTION_MIN_SCORE,
  // 默认的最小唯一查询数
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
} from "./short-term-promotion.js";

/**
 * Memory CLI 运行时模块的类型
 * 延迟加载 cli.runtime.js 的类型定义
 */
type MemoryCliRuntime = typeof import("./cli.runtime.js");

/**
 * Memory CLI 运行时模块的Promise实例
 * 用于实现单例模式，避免重复加载
 */
let memoryCliRuntimePromise: Promise<MemoryCliRuntime> | null = null;

/**
 * 加载 Memory CLI 运行时模块
 * 使用单例模式确保只加载一次
 * @returns 内存 CLI 运行时模块
 */
async function loadMemoryCliRuntime(): Promise<MemoryCliRuntime> {
  // 如果还没有加载，则开始加载
  memoryCliRuntimePromise ??= import("./cli.runtime.js");
  // 等待加载完成并返回
  return await memoryCliRuntimePromise;
}

/**
 * 执行 memory status 命令
 * 显示内存搜索索引状态
 * @param opts - Memory 命令选项
 */
export async function runMemoryStatus(opts: MemoryCommandOptions) {
  // 加载运行时模块
  const runtime = await loadMemoryCliRuntime();
  // 调用运行时的 status 命令
  await runtime.runMemoryStatus(opts);
}

/**
 * 执行 memory index 命令
 * 重新索引内存文件
 * @param opts - Memory 命令选项
 */
async function runMemoryIndex(opts: MemoryCommandOptions) {
  // 加载运行时模块
  const runtime = await loadMemoryCliRuntime();
  // 调用运行时的 index 命令
  await runtime.runMemoryIndex(opts);
}

/**
 * 执行 memory search 命令
 * 搜索内存文件
 * @param queryArg - 位置参数查询字符串
 * @param opts - 搜索命令选项
 */
async function runMemorySearch(queryArg: string | undefined, opts: MemorySearchCommandOptions) {
  // 加载运行时模块
  const runtime = await loadMemoryCliRuntime();
  // 调用运行时的 search 命令
  await runtime.runMemorySearch(queryArg, opts);
}

/**
 * 执行 memory promote 命令
 * 对短期记忆候选项进行排名，可选择追加到 MEMORY.md
 * @param opts - 提升命令选项
 */
async function runMemoryPromote(opts: MemoryPromoteCommandOptions) {
  // 加载运行时模块
  const runtime = await loadMemoryCliRuntime();
  // 调用运行时的 promote 命令
  await runtime.runMemoryPromote(opts);
}

/**
 * 执行 memory promote-explain 命令
 * 解释特定提升候选项及其分数明细
 * @param selectorArg - 选择器参数（候选项键、路径片段或代码片段片段）
 * @param opts - 提升解释命令选项
 */
async function runMemoryPromoteExplain(
  selectorArg: string | undefined,
  opts: MemoryPromoteExplainOptions,
) {
  // 加载运行时模块
  const runtime = await loadMemoryCliRuntime();
  // 调用运行时的 promoteExplain 命令
  await runtime.runMemoryPromoteExplain(selectorArg, opts);
}

/**
 * 执行 memory rem-harness 命令
 * 预览 REM 反思、候选项真相和深度提升（不写入）
 * @param opts - REM 测试工具命令选项
 */
async function runMemoryRemHarness(opts: MemoryRemHarnessOptions) {
  // 加载运行时模块
  const runtime = await loadMemoryCliRuntime();
  // 调用运行时的 remHarness 命令
  await runtime.runMemoryRemHarness(opts);
}

/**
 * 执行 memory rem-backfill 命令
 * 将基于历史 REM 摘要写入 DREAMS.md 以供 UI 审查
 * @param opts - REM 填充命令选项
 */
async function runMemoryRemBackfill(opts: MemoryRemBackfillOptions) {
  // 加载运行时模块
  const runtime = await loadMemoryCliRuntime();
  // 调用运行时的 remBackfill 命令
  await runtime.runMemoryRemBackfill(opts);
}

/**
 * 注册 Memory CLI 命令到程序
 * 在插件初始化时被调用
 * @param program - Commander 程序实例
 */
export function registerMemoryCli(program: Command) {
  // 创建 memory 子命令
  const memory = program
    // 命令名称
    .command("memory")
    // 命令描述
    .description("Search, inspect, and reindex memory files")
    // 在帮助文本后添加示例
    .addHelpText(
      // 放置位置：主帮助文本之后
      "after",
      // 格式化帮助示例的函数
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          // 示例 1：显示索引和提供者状态
          ["openclaw memory status", "Show index and provider status."],
          // 示例 2：修复过时的回忆锁并规范化提升元数据
          [
            "openclaw memory status --fix",
            "Repair stale recall locks and normalize promotion metadata.",
          ],
          // 示例 3：探测嵌入提供者可用性
          ["openclaw memory status --deep", "Probe embedding provider readiness."],
          // 示例 4：强制全量重新索引
          ["openclaw memory index --force", "Force a full reindex."],
          // 示例 5：使用位置查询进行快速搜索
          ['openclaw memory search "meeting notes"', "Quick search using positional query."],
          // 示例 6：限制结果数量用于故障排除
          [
            'openclaw memory search --query "deployment" --max-results 20',
            "Limit results for focused troubleshooting.",
          ],
          // 示例 7：审查加权短期候选项用于长期记忆
          [
            `openclaw memory promote --limit 10 --min-score ${DEFAULT_PROMOTION_MIN_SCORE}`,
            "Review weighted short-term candidates for long-term memory.",
          ],
          // 示例 8：将排名最高的短期候选项追加到 MEMORY.md
          [
            "openclaw memory promote --apply",
            "Append top-ranked short-term candidates into MEMORY.md.",
          ],
          // 示例 9：解释为什么某个候选项会或不会提升
          [
            'openclaw memory promote-explain "router vlan"',
            "Explain why a specific candidate would or would not promote.",
          ],
          // 示例 10：预览 REM 反思、候选项真相和深度提升输出
          [
            "openclaw memory rem-harness --json",
            "Preview REM reflections, candidate truths, and deep promotion output.",
          ],
          // 示例 11：将基于历史 daily memory 文件的 grounded 历史 REM 条目写入 DREAMS.md
          [
            "openclaw memory rem-backfill --path ./memory",
            "Write grounded historical REM entries into DREAMS.md for UI review.",
          ],
          // 示例 12：还将持久的 grounded 候选项种子到实时短期提升存储中
          [
            "openclaw memory rem-backfill --path ./memory --stage-short-term",
            "Also seed durable grounded candidates into the live short-term promotion store.",
          ],
          // 示例 13：输出机器可读的 JSON（适合脚本）
          ["openclaw memory status --json", "Output machine-readable JSON (good for scripts)."],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`,
    );

  // 注册 status 子命令
  memory
    // 命令名称
    .command("status")
    // 命令描述
    .description("Show memory search index status")
    // 选项：代理 ID（默认 default agent）
    .option("--agent <id>", "Agent id (default: default agent)")
    // 选项：打印 JSON 格式
    .option("--json", "Print JSON")
    // 选项：探测嵌入提供者可用性
    .option("--deep", "Probe embedding provider availability")
    // 选项：如果索引脏了则重新索引（隐含 --deep）
    .option("--index", "Reindex if dirty (implies --deep)")
    // 选项：修复过时的回忆锁并规范化提升元数据
    .option("--fix", "Repair stale recall locks and normalize promotion metadata")
    // 选项：详细日志
    .option("--verbose", "Verbose logging", false)
    // 命令执行动作
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      // 调用 status 命令
      await runMemoryStatus(opts);
    });

  // 注册 index 子命令
  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      await runMemoryIndex(opts);
    });

  // 注册 search 子命令
  memory
    .command("search")
    .description("Search memory files")
    // 位置参数：查询字符串
    .argument("[query]", "Search query")
    .option("--query <text>", "Search query (alternative to positional argument)")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(async (queryArg: string | undefined, opts: MemorySearchCommandOptions) => {
      await runMemorySearch(queryArg, opts);
    });

  // 注册 promote 子命令
  memory
    .command("promote")
    .description("Rank short-term recalls and optionally append top entries to MEMORY.md")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--limit <n>", "Max candidates", (value: string) => Number(value))
    .option(
      "--min-score <n>",
      `Minimum weighted score (default: ${DEFAULT_PROMOTION_MIN_SCORE})`,
      (value: string) => Number(value),
    )
    .option(
      "--min-recall-count <n>",
      `Minimum recall count (default: ${DEFAULT_PROMOTION_MIN_RECALL_COUNT})`,
      (value: string) => Number(value),
    )
    .option(
      "--min-unique-queries <n>",
      `Minimum distinct query count (default: ${DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES})`,
      (value: string) => Number(value),
    )
    .option("--apply", "Append selected candidates to MEMORY.md", false)
    .option("--include-promoted", "Include already promoted candidates", false)
    .option("--json", "Print JSON")
    .action(async (opts: MemoryPromoteCommandOptions) => {
      await runMemoryPromote(opts);
    });

  // 注册 promote-explain 子命令
  memory
    .command("promote-explain")
    .description("Explain a specific promotion candidate and its score breakdown")
    // 必需的位置参数：选择器
    .argument("<selector>", "Candidate key, path fragment, or snippet fragment")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--include-promoted", "Include already promoted candidates", false)
    .option("--json", "Print JSON")
    .action(async (selectorArg: string | undefined, opts: MemoryPromoteExplainOptions) => {
      await runMemoryPromoteExplain(selectorArg, opts);
    });

  // 注册 rem-harness 子命令
  memory
    .command("rem-harness")
    .description("Preview REM reflections, candidate truths, and deep promotions without writing")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--path <file-or-dir>", "Seed the harness from historical daily memory file(s)")
    .option("--grounded", "Also render a grounded day-level REM preview")
    .option("--include-promoted", "Include already promoted deep candidates", false)
    .option("--json", "Print JSON")
    .action(async (opts: MemoryRemHarnessOptions) => {
      await runMemoryRemHarness(opts);
    });

  // 注册 rem-backfill 子命令
  memory
    .command("rem-backfill")
    .description("Write grounded historical REM summaries into DREAMS.md for UI review")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--path <file-or-dir>", "Historical daily memory file(s) or directory")
    .option("--rollback", "Remove previously written grounded REM backfill entries", false)
    .option(
      "--stage-short-term",
      "Also seed grounded durable candidates into the short-term promotion store",
      false,
    )
    .option(
      "--rollback-short-term",
      "Remove previously seeded grounded short-term candidates",
      false,
    )
    .option("--json", "Print JSON")
    .action(async (opts: MemoryRemBackfillOptions) => {
      await runMemoryRemBackfill(opts);
    });

  // memory 命令的默认动作（无子命令时）
  memory.action(() => {
    // 输出帮助信息
    memory.outputHelp();
    // 设置退出码为 0（成功）
    process.exitCode = 0;
  });
}
