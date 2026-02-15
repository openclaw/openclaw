---
summary: "Bun 工作流程 (實驗性): 安裝及常見陷阱與 pnpm 比較"
read_when:
  - 您需要最快的本機開發循環 (bun + watch)
  - 您遇到 Bun 安裝/修補/生命週期指令碼問題
title: "Bun (實驗性)"
---

# Bun (實驗性)

目標：使用 **Bun** 執行此儲存庫 (可選，不建議用於 WhatsApp/Telegram)，同時不偏離 pnpm 工作流程。

⚠️ **不建議用於 Gateway 執行時期** (WhatsApp/Telegram 錯誤)。正式環境請使用 Node。

## 狀態

- Bun 是一個可選的本機執行時期，用於直接執行 TypeScript (`bun run …`、`bun --watch …`)。
- `pnpm` 是建置的預設值，並仍獲得全面支援 (也用於部分文件工具)。
- Bun 無法使用 `pnpm-lock.yaml`，並會忽略它。

## 安裝

預設：

```sh
bun install
```

注意：`bun.lock`/`bun.lockb` 已加入 .gitignore，因此無論如何都不會造成儲存庫變動。如果您想要 _不寫入鎖定檔案_：

```sh
bun install --no-save
```

## 建置 / 測試 (Bun)

```sh
bun run build
bun run vitest run
```

## Bun 生命周期指令碼 (預設情況下封鎖)

除非明確信任，否則 Bun 可能會封鎖依賴項生命週期指令碼 (`bun pm untrusted` / `bun pm trust`)。
對於此儲存庫，通常封鎖的指令碼不是必需的：

- ` @whiskeysockets/baileys` `preinstall`: 檢查 Node 主要版本 >= 20 (我們執行 Node 22+)。
- `protobufjs` `postinstall`: 發出關於不相容版本方案的警告 (無建置產物)。

如果您遇到需要這些指令碼的實際執行時期問題，請明確信任它們：

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 注意事項

- 某些指令碼仍然硬編碼 pnpm (例如 `docs:build`、`ui:*`、`protocol:check`)。目前請透過 pnpm 執行這些指令碼。
