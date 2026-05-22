/**
 * evolution-cli.ts — ClaWorks `claworks evolution` 子命令
 *
 * 用法：
 *   claworks evolution export [--days 30] > evolution-data.json
 *   claworks evolution import evolution-pack.json
 *   claworks evolution status
 */

import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { EvolutionPack } from "../kernel/evolution-sync.js";
import { loadPersistedInstalled } from "./pack-runtime.js";
import { isClaworksProduct } from "./product-env.js";
import { createClaworksRuntime, startClaworksRuntime, stopClaworksRuntime } from "./runtime.js";

export function registerClaworksEvolutionCli(program: Command): void {
  if (!isClaworksProduct()) {
    return;
  }

  const evolution = program
    .command("evolution")
    .description("ClaWorks 离线进化同步管道（导出数据 / 导入改进包 / 查看状态）");

  evolution
    .command("export")
    .description("导出机器人进化数据包（脱敏，可安全传输到有互联网的机器）")
    .option("--days <n>", "收集最近多少天的数据", "30")
    .option("--output <file>", "输出文件路径（不填则输出到 stdout）")
    .action(async (opts: { days: string; output?: string }) => {
      const runtime = await createClaworksRuntime({
        packs: { installed: await loadPersistedInstalled() },
      });
      await startClaworksRuntime(runtime);
      try {
        const days = Number.parseInt(opts.days, 10) || 30;
        if (!runtime.evolutionSync) {
          process.stderr.write("错误：evolutionSync 管理器未初始化\n");
          process.exit(1);
        }
        const data = await runtime.evolutionSync.exportEvolutionData(days);
        const json = JSON.stringify(data, null, 2);
        if (opts.output) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(opts.output, json, "utf-8");
          process.stderr.write(`✅ 进化数据已导出到 ${opts.output}（共 ${json.length} 字节）\n`);
        } else {
          process.stdout.write(json + "\n");
        }
      } finally {
        await stopClaworksRuntime(runtime);
      }
    });

  evolution
    .command("import")
    .description("导入进化包（热更新 Playbook、规则表、提示词模板、KB 条目）")
    .argument("<pack-file>", "进化包 JSON 文件路径（由 generate-evolution-pack.ts 生成）")
    .action(async (packFile: string) => {
      let packContent: string;
      try {
        packContent = await readFile(packFile, "utf-8");
      } catch (err) {
        process.stderr.write(
          `错误：无法读取文件 ${packFile}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }

      let pack: EvolutionPack;
      try {
        pack = JSON.parse(packContent) as EvolutionPack;
      } catch {
        process.stderr.write(`错误：文件 ${packFile} 不是有效的 JSON\n`);
        process.exit(1);
      }

      if (!pack.version) {
        process.stderr.write("错误：进化包缺少 version 字段，文件格式不正确\n");
        process.exit(1);
      }

      const runtime = await createClaworksRuntime({
        packs: { installed: await loadPersistedInstalled() },
      });
      await startClaworksRuntime(runtime);
      try {
        if (!runtime.evolutionSync) {
          process.stderr.write("错误：evolutionSync 管理器未初始化\n");
          process.exit(1);
        }
        const result = await runtime.evolutionSync.importEvolutionPack(pack);
        if (result.success) {
          process.stderr.write(`✅ 进化包导入成功！应用了 ${result.applied.length} 项改进：\n`);
          for (const item of result.applied) {
            process.stderr.write(`   • ${item}\n`);
          }
        } else {
          process.stderr.write(
            `⚠️  进化包部分导入，应用了 ${result.applied.length} 项，失败 ${result.errors?.length ?? 0} 项：\n`,
          );
          for (const err of result.errors ?? []) {
            process.stderr.write(`   ✗ ${err}\n`);
          }
        }
        console.log(JSON.stringify(result, null, 2));
      } finally {
        await stopClaworksRuntime(runtime);
      }
    });

  evolution
    .command("status")
    .description("查看进化同步历史（最近导入了哪些进化包）")
    .action(async () => {
      const runtime = await createClaworksRuntime({
        packs: { installed: await loadPersistedInstalled() },
      });
      await startClaworksRuntime(runtime);
      try {
        if (!runtime.evolutionSync) {
          console.log(JSON.stringify({ status: "unavailable" }, null, 2));
          return;
        }
        const status = runtime.evolutionSync.getStatus();
        const history = runtime.evolutionSync.getHistory().slice(0, 10);
        console.log(JSON.stringify({ ...status, history }, null, 2));
      } finally {
        await stopClaworksRuntime(runtime);
      }
    });
}
