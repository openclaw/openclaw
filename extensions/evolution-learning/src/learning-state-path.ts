import path from "node:path";

/**
 * 統一 Hermes learning-state.json 路徑（修復缺口① 橋斷裂）。
 *
 * 背景：原寫入端 hermes-gate 用 `stateDir/learning-state.json`
 *       （stateDir = <base>/.claude/evolution-state），
 *       但讀取端 runEvolutionCycle / croner / cognitive-cycle 讀的是
 *       `(NUWA_WORKSPACE ?? cwd)/reports/hermes-agent/state/learning-state.json`，
 *       兩個目錄不同 → 學習回流斷裂。
 *
 * 本 helper 為「單一路徑事實源」，對齊讀取端標準位置；
 * 寫入端改用它即可讓寫入與讀取指向同一檔。
 *
 * 注意：此檔為純新增、無副作用；在 hermes-gate 改用前不影響任何行為。
 */
export function resolveLearningStatePath(): string {
  return path.join(
    process.env.NUWA_WORKSPACE ?? process.cwd(),
    "reports",
    "hermes-agent",
    "state",
    "learning-state.json",
  );
}
