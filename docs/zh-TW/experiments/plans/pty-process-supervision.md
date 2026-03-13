---
summary: >-
  Production plan for reliable interactive process supervision (PTY + non-PTY)
  with explicit ownership, unified lifecycle, and deterministic cleanup
read_when:
  - Working on exec/process lifecycle ownership and cleanup
  - Debugging PTY and non-PTY supervision behavior
owner: openclaw
status: in-progress
last_updated: "2026-02-15"
title: PTY and Process Supervision Plan
---

# PTY 和進程監控計劃

## 1. 問題與目標

我們需要一個可靠的生命週期來執行長時間執行的命令，涵蓋：

- `exec` 前景執行
- `exec` 背景執行
- `process` 後續動作 (`poll`, `log`, `send-keys`, `paste`, `submit`, `kill`, `remove`)
- CLI 代理執行程序子進程

目標不僅僅是支援 PTY。目標是可預測的擁有權、取消、超時和清理，並且不使用不安全的進程匹配啟發式方法。

## 2. 範圍與界限

- 在 `src/process/supervisor` 中保持實作為內部使用。
- 不要為此創建新的套件。
- 在可行的情況下保持當前行為的相容性。
- 不要擴大範圍至終端重播或 tmux 風格的會話持久性。

## 3. 在此分支中實作的內容

### Supervisor baseline 已經存在

- 監控模組已在 `src/process/supervisor/*` 下就緒。
- Exec 執行時和 CLI 執行器已透過監控器進行啟動和等待的路由。
- 註冊的最終化是冪等的。

### 此通行證已完成

1. 明確的 PTY 命令合約

- `SpawnInput` 現在是 `src/process/supervisor/types.ts` 中的一個區分聯合。
- PTY 執行需要 `ptyCommand` 而不是重用通用的 `argv`。
- Supervisor 不再從 argv 連接中重建 PTY 命令字串於 `src/process/supervisor/supervisor.ts`。
- Exec 執行時現在直接在 `src/agents/bash-tools.exec-runtime.ts` 中傳遞 `ptyCommand`。

2. 處理層類型解耦

- 監督者類型不再從代理匯入 `SessionStdin`。
- 處理本地標準輸入合約存在於 `src/process/supervisor/types.ts` (`ManagedRunStdin`)。
- 適配器現在僅依賴於處理層級類型：
  - `src/process/supervisor/adapters/child.ts`
  - `src/process/supervisor/adapters/pty.ts`

3. 改進工具生命週期擁有權

- `src/agents/bash-tools.process.ts` 現在要求先通過主管進行取消。
- `process kill/remove` 現在在主管查找失敗時使用進程樹回退終止。
- `remove` 通過在請求終止後立即刪除執行中的會話條目來保持確定性的移除行為。

[[BLOCK_4]] 單一來源監控預設值 [[BLOCK_4]]

- 在 `src/agents/cli-watchdog-defaults.ts` 中新增了共享預設值。
- `src/agents/cli-backends.ts` 使用這些共享預設值。
- `src/agents/cli-runner/reliability.ts` 也使用相同的共享預設值。

5. 清理無效的輔助程式

- 從 `src/agents/bash-tools.shared.ts` 移除了未使用的 `killSession` 幫助路徑。

6. 已新增直接主管路徑測試

- 新增 `src/agents/bash-tools.process.supervisor.test.ts` 以涵蓋透過監督者取消來終止和移除路由。

7. 可靠性差距修復已完成

- `src/agents/bash-tools.process.ts` 現在在監控器查找失敗時回退到真實的作業系統級別進程終止。
- `src/process/supervisor/adapters/child.ts` 現在對於預設的取消/超時終止路徑使用進程樹終止語義。
- 在 `src/process/kill-tree.ts` 中新增了共享的進程樹工具。

8. 已新增 PTY 合約邊界案例覆蓋

- 新增 `src/process/supervisor/supervisor.pty-command.test.ts` 用於逐字轉發 PTY 命令和空命令拒絕。
- 新增 `src/process/supervisor/adapters/child.test.ts` 用於子適配器取消中的進程樹終止行為。

## 4. 剩餘的空白與決策

### 可靠性狀態

這次通過所需的兩個可靠性差距現在已經關閉：

- `process kill/remove` 現在在監控查找失敗時具有真正的作業系統終止回退機制。
- 子進程取消/超時現在使用進程樹殺死語義作為預設的殺死路徑。
- 針對這兩種行為新增了回歸測試。

### 耐久性與啟動調和

重啟行為現在明確定義為僅限於記憶體生命週期。

- `reconcileOrphans()` 在 `src/process/supervisor/supervisor.ts` 中仍然是無操作（no-op），這是設計使然。
- 活動執行在進程重啟後不會被恢復。
- 這個邊界是為了避免部分持久性風險而故意設計的。

### 可維護性後續事項

1. `runExecProcess` 在 `src/agents/bash-tools.exec-runtime.ts` 中仍然處理多項責任，並且可以在後續中拆分為專注的輔助工具。

## 5. 實施計畫

所需的可靠性和合約專案的實施通過已完成。

完成：

- `process kill/remove` 回退實際終止
- 子適配器的預設終止路徑的進程樹取消
- 回退終止和子適配器終止路徑的回歸測試
- 在明確的 `ptyCommand` 下進行的 PTY 命令邊界案例測試
- 設計上無操作的 `reconcileOrphans()` 明確記憶體重啟邊界

[[BLOCK_1]]

- 將 `runExecProcess` 拆分為專注的輔助工具，並確保不產生行為漂移。

## 6. 檔案地圖

### Process supervisor

- `src/process/supervisor/types.ts` 更新了區分的 spawn 輸入和處理本地 stdin 合約。
- `src/process/supervisor/supervisor.ts` 更新為使用明確的 `ptyCommand`。
- `src/process/supervisor/adapters/child.ts` 和 `src/process/supervisor/adapters/pty.ts` 與代理類型解耦。
- `src/process/supervisor/registry.ts` 的冪等 finalize 保持不變並保留。

### Exec 和流程整合

- `src/agents/bash-tools.exec-runtime.ts` 更新為明確傳遞 PTY 命令並保留備用路徑。
- `src/agents/bash-tools.process.ts` 更新為通過監控者取消，並使用真實的進程樹備用終止。
- `src/agents/bash-tools.shared.ts` 移除了直接終止輔助路徑。

### CLI 可靠性

- `src/agents/cli-watchdog-defaults.ts` 被新增為共享基準。
- `src/agents/cli-backends.ts` 和 `src/agents/cli-runner/reliability.ts` 現在使用相同的預設值。

## 7. 此次通過的驗證執行

[[BLOCK_1]]

- `pnpm vitest src/process/supervisor/registry.test.ts`
- `pnpm vitest src/process/supervisor/supervisor.test.ts`
- `pnpm vitest src/process/supervisor/supervisor.pty-command.test.ts`
- `pnpm vitest src/process/supervisor/adapters/child.test.ts`
- `pnpm vitest src/agents/cli-backends.test.ts`
- `pnpm vitest src/agents/bash-tools.exec.pty-cleanup.test.ts`
- `pnpm vitest src/agents/bash-tools.process.poll-timeout.test.ts`
- `pnpm vitest src/agents/bash-tools.process.supervisor.test.ts`
- `pnpm vitest src/process/exec.test.ts`

E2E 目標：

- `pnpm vitest src/agents/cli-runner.test.ts`
- `pnpm vitest run src/agents/bash-tools.exec.pty-fallback.test.ts src/agents/bash-tools.exec.background-abort.test.ts src/agents/bash-tools.process.send-keys.test.ts`

[[BLOCK_1]]

- 在此倉庫中使用 `pnpm build`（以及 `pnpm check` 來進行完整的 lint/docs 門檻）。提到 `pnpm tsgo` 的舊筆記已經過時。

## 8. 保留的操作保證

- 執行環境強化行為保持不變。
- 批准和白名單流程保持不變。
- 輸出清理和輸出上限保持不變。
- PTY 轉接器仍然保證在強制終止和監聽器處置時的等待結算。

## 9. 完成定義

1. 監督者是受管理執行的生命週期擁有者。
2. PTY spawn 使用明確的命令合約，沒有 argv 重建。
3. 處理層對於監督者標準輸入合約在代理層上沒有類型依賴。
4. 看門狗的預設值是單一來源。
5. 針對單元測試和端對端測試仍然保持綠燈。
6. 重新啟動的耐久性邊界已明確記錄或完全實作。

## 10. 總結

該分支現在具有一致且更安全的監督形狀：

- 明確的 PTY 合約
- 更清晰的流程分層
- 由監督者驅動的流程操作取消路徑
- 當監督者查找失敗時的真正回退終止
- 子進程的流程樹取消預設終止路徑
- 統一的看門狗預設
- 明確的記憶體重啟邊界（在此過程中不進行孤兒重整）
