// SensitivityAnalyzer.mjs — 參數敏感度分析
// 解決問題：最佳參數是否只在特定市場環境有效？
//
// 功能：
//   1. 2D 熱圖（兩參數 × Sharpe/Return/WinRate）
//   2. 單參數掃描（折線圖資料）
//   3. 穩健性評分（多少 % 的參數組合有正報酬）
//   4. 參數重要性評估（哪個參數影響最大）
//   5. 自動輸出 CSV（可用 Excel/Python 視覺化）

import { writeFileSync } from "node:fs";
import { Backtester } from "./Backtester.mjs";

// ── 工具函數 ─────────────────────────────────────────────────────────
/** 產生線性等距序列 */
export function linspace(start, stop, num) {
  if (num <= 1) {
    return [start];
  }
  const step = (stop - start) / (num - 1);
  return Array.from({ length: num }, (_, i) => +(start + i * step).toFixed(6));
}

/** 取得嵌套物件的值（支援 'risk.sharpe' 形式） */
function getPath(obj, dotPath) {
  return dotPath.split(".").reduce((o, k) => o?.[k], obj);
}

// ── SensitivityAnalyzer ───────────────────────────────────────────────
export class SensitivityAnalyzer {
  /**
   * @param {object} opts
   * @param {Function} opts.StratClass      策略類別（new StratClass(config)）
   * @param {object}   opts.baseConfig      策略基礎設定（params 以外的部分）
   * @param {object[]} opts.bars            OHLCV 陣列
   * @param {string}   opts.metric         評估指標路徑（預設 'risk.sharpe'）
   * @param {number}   opts.annualFactor   年化因子
   */
  constructor(opts = {}) {
    this.StratClass = opts.StratClass;
    this.baseConfig = opts.baseConfig ?? {};
    this.bars = opts.bars ?? [];
    this.metric = opts.metric ?? "risk.sharpe";
    this.annualFactor = opts.annualFactor ?? 252;
    this._bt = new Backtester({ annualFactor: this.annualFactor });
  }

  /**
   * 執行單次回測，取得 metric 值
   */
  _runOne(params) {
    try {
      const config = { ...this.baseConfig, params: { ...this.baseConfig.params, ...params } };
      const strat = new this.StratClass(config);
      const result = this._bt.run(strat, this.bars);
      const value = getPath(result, this.metric);
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  // ── 1D 掃描 ────────────────────────────────────────────────────────
  /**
   * 單參數敏感度掃描
   * @param {string}   paramName  參數名稱
   * @param {number[]} values     掃描值陣列
   * @returns {{ values, scores, best, worst, range }}
   */
  scan1D(paramName, values) {
    console.log(`[SA] 掃描 ${paramName} × ${values.length} 個值...`);
    const scores = values.map((v) => {
      const s = this._runOne({ [paramName]: v });
      return { value: v, score: s };
    });

    const valid = scores.filter((s) => s.score !== null);
    const best = valid.reduce(
      (a, b) => (a.score > b.score ? a : b),
      valid[0] ?? { value: null, score: null },
    );
    const worst = valid.reduce(
      (a, b) => (a.score < b.score ? a : b),
      valid[0] ?? { value: null, score: null },
    );
    const sRange =
      valid.length > 0
        ? Math.max(...valid.map((s) => s.score)) - Math.min(...valid.map((s) => s.score))
        : 0;

    return {
      paramName,
      metric: this.metric,
      values: scores,
      best,
      worst,
      range: +sRange.toFixed(4),
      robustPct: +((valid.filter((s) => s.score > 0).length / (valid.length || 1)) * 100).toFixed(
        1,
      ),
    };
  }

  // ── 2D 熱圖 ────────────────────────────────────────────────────────
  /**
   * 兩參數交叉敏感度（熱圖）
   * @param {string}   p1Name   橫軸參數名
   * @param {number[]} p1Values 橫軸掃描值
   * @param {string}   p2Name   縱軸參數名
   * @param {number[]} p2Values 縱軸掃描值
   * @returns {{ grid, best, robustPct, importance }}
   */
  scan2D(p1Name, p1Values, p2Name, p2Values) {
    const total = p1Values.length * p2Values.length;
    console.log(`[SA] 2D 掃描 ${p1Name}×${p2Name}，共 ${total} 個組合...`);

    let done = 0;
    const grid = p2Values.map((v2) =>
      p1Values.map((v1) => {
        const score = this._runOne({ [p1Name]: v1, [p2Name]: v2 });
        done++;
        if (done % Math.max(1, Math.floor(total / 5)) === 0) {
          process.stdout.write(
            `\r  進度: ${done}/${total} (${((done / total) * 100).toFixed(0)}%)`,
          );
        }
        return { [p1Name]: v1, [p2Name]: v2, score };
      }),
    );
    console.log(); // newline after progress

    const flat = grid.flat().filter((c) => c.score !== null);
    const best = flat.reduce((a, b) => (a.score > b.score ? a : b), flat[0] ?? null);
    const worst = flat.reduce((a, b) => (a.score < b.score ? a : b), flat[0] ?? null);

    const robustPct = +(
      (flat.filter((c) => c.score > 0).length / (flat.length || 1)) *
      100
    ).toFixed(1);

    // 參數重要性：各參數的 score variance
    const p1Importance = this._paramImportance(grid.flat(), p1Name, p1Values);
    const p2Importance = this._paramImportance(grid.flat(), p2Name, p2Values);

    return {
      p1Name,
      p1Values,
      p2Name,
      p2Values,
      metric: this.metric,
      grid,
      best,
      worst,
      robustPct,
      importance: {
        [p1Name]: +p1Importance.toFixed(4),
        [p2Name]: +p2Importance.toFixed(4),
        dominant: p1Importance > p2Importance ? p1Name : p2Name,
      },
    };
  }

  /** 計算單一參數的影響力（各值對應 score 的 variance） */
  _paramImportance(cells, paramName, paramValues) {
    const byParam = paramValues
      .map((v) => {
        const group = cells.filter((c) => c[paramName] === v && c.score !== null);
        const scores = group.map((c) => c.score);
        return scores.length > 0 ? scores.reduce((s, x) => s + x, 0) / scores.length : null;
      })
      .filter((v) => v !== null);

    if (byParam.length < 2) {
      return 0;
    }
    const mean = byParam.reduce((s, v) => s + v, 0) / byParam.length;
    return byParam.reduce((s, v) => s + (v - mean) ** 2, 0) / byParam.length;
  }

  // ── 穩健性報告 ─────────────────────────────────────────────────────
  /**
   * 跑多個 1D 掃描並彙總重要性排名
   * @param {object} paramRanges  { paramName: [values...] }
   */
  robustnessReport(paramRanges) {
    console.log(`\n[SA] 穩健性分析：${Object.keys(paramRanges).length} 個參數`);
    const results = {};
    for (const [name, values] of Object.entries(paramRanges)) {
      results[name] = this.scan1D(name, values);
    }

    const ranked = Object.entries(results)
      .map(([name, r]) => ({ name, range: r.range, robustPct: r.robustPct, best: r.best }))
      .toSorted((a, b) => b.range - a.range);

    return { results, ranked };
  }

  // ── CSV 匯出 ───────────────────────────────────────────────────────
  /**
   * 匯出 2D 熱圖為 CSV
   * @param {object} scan2DResult  scan2D() 的返回值
   * @param {string} outPath       輸出路徑
   */
  exportCsv(scan2DResult, outPath = "./sensitivity_heatmap.csv") {
    const { p1Name, p1Values, p2Name, p2Values, grid } = scan2DResult;

    // 標題列
    const header = [p2Name + "\\" + p1Name, ...p1Values.map((v) => String(v))].join(",");
    const rows = p2Values.map((v2, i) => {
      const scores = grid[i].map((cell) => (cell.score !== null ? cell.score.toFixed(3) : "NaN"));
      return [v2, ...scores].join(",");
    });

    const csv = [header, ...rows].join("\n");
    writeFileSync(outPath, csv);
    console.log(`[SA] 熱圖 CSV 已匯出: ${outPath}`);
    return outPath;
  }

  /**
   * 匯出 1D 掃描為 CSV
   */
  export1dCsv(scan1DResult, outPath = "./sensitivity_scan.csv") {
    const { paramName, metric, values } = scan1DResult;
    const header = `${paramName},${metric}`;
    const rows = values.map(
      ({ value, score }) => `${value},${score !== null ? score.toFixed(4) : "NaN"}`,
    );
    writeFileSync(outPath, [header, ...rows].join("\n"));
    console.log(`[SA] 掃描 CSV 已匯出: ${outPath}`);
    return outPath;
  }
}

// ── 列印工具 ──────────────────────────────────────────────────────────
export function print1DScan(result) {
  console.log(`\n  1D 敏感度：${result.paramName} → ${result.metric}`);
  console.log(`  ${"─".repeat(50)}`);
  const scores = result.values.map((v) => v.score);
  const min = Math.min(...scores.filter((s) => s !== null));
  const max = Math.max(...scores.filter((s) => s !== null));
  const rng = max - min || 1;

  for (const { value, score } of result.values) {
    if (score === null) {
      console.log(`    ${String(value).padStart(8)}  [無效]`);
      continue;
    }
    const bar = "█".repeat(Math.max(0, Math.round(((score - min) / rng) * 20)));
    const col = score > 0 ? "\x1b[32m" : "\x1b[31m";
    console.log(`    ${String(value).padStart(8)}  ${col}${bar}\x1b[0m ${score.toFixed(3)}`);
  }
  console.log(
    `\n  最佳: ${result.paramName}=${result.best?.value} (${result.metric}=${result.best?.score?.toFixed(3)})`,
  );
  console.log(`  穩健: ${result.robustPct}% 組合有正 ${result.metric}`);
}

export function print2DHeatmap(result) {
  const { p1Name, p1Values, p2Name, p2Values, grid, best, robustPct } = result;
  console.log(`\n  2D 熱圖：${p1Name} × ${p2Name} → ${result.metric}`);
  console.log(`  ${"─".repeat(Math.min(80, 12 + p1Values.length * 7))}`);

  // Header
  const colW = 7;
  const hdr = " ".repeat(10) + p1Values.map((v) => String(v).padStart(colW)).join("");
  console.log("  " + hdr);

  // Find score range for coloring
  const allScores = grid
    .flat()
    .map((c) => c.score)
    .filter((s) => s !== null);
  const sMax = allScores.length ? Math.max(...allScores) : 1;

  for (let j = 0; j < p2Values.length; j++) {
    const rowLabel = String(p2Values[j]).padEnd(10);
    const cells = grid[j].map((cell) => {
      if (cell.score === null) {
        return "  [--]";
      }
      const s = cell.score;
      const col = s > 0 ? (s > sMax * 0.7 ? "\x1b[32m" : "\x1b[36m") : "\x1b[31m";
      return col + String(s.toFixed(2)).padStart(colW) + "\x1b[0m";
    });
    console.log("  " + rowLabel + cells.join(""));
  }

  console.log(
    `\n  最佳: ${p1Name}=${best?.[p1Name]} ${p2Name}=${best?.[p2Name]} → ${result.metric}=${best?.score?.toFixed(3)}`,
  );
  console.log(`  穩健性: ${robustPct}%  主導參數: ${result.importance?.dominant}`);
}

export function printRobustnessReport(report) {
  console.log("\n  參數重要性排名（影響力由高到低）:");
  console.log("  " + "─".repeat(50));
  for (const { name, range, robustPct, best } of report.ranked) {
    const bar = "█".repeat(Math.max(0, Math.round(range * 10)));
    console.log(
      `    ${name.padEnd(20)} Range:${range.toFixed(3).padStart(8)}  穩健:${(robustPct + "%").padStart(7)}  ${bar}`,
    );
    if (best) {
      console.log(`      最佳值: ${best.value} (score=${best.score?.toFixed(3)})`);
    }
  }
}
