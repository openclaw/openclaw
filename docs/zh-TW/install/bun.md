---
summary: "Bun 工作流 (實驗性)：安裝以及與 pnpm 相比的注意事項"
read_when:
  - 你想要最快的本地開發迴圈 (bun + watch)
  - 你遇到了 Bun 安裝、修補程序或生命週期腳本的問題
title: "Bun (實驗性)"
---

# Bun (實驗性)

目標：使用 **Bun** 執行此專案庫（選用，不建議用於 WhatsApp/Telegram），且不偏離 pnpm 工作流。

⚠️ **不建議用於 Gateway 執行環境**（WhatsApp/Telegram 存在程式錯誤）。正式環境請使用 Node。

## 狀態

- Bun 是用於直接執行 TypeScript 的選用本地執行環境 (`bun run …`, `bun --watch …`)。
- `pnpm` 是建置的預設工具，並維持完整支援（部分文件工具仍會使用）。
- Bun 無法使用 `pnpm-lock.yaml` 且會將其忽略。

## 安裝

預設：

```sh
bun install
```

註：`bun.lock`/`bun.lockb` 已被加入 gitignore，因此無論如何都不會造成專案庫異動。如果你希望 _不要寫入 lockfile_：

```sh
bun install --no-save
```

## 建置 / 測試 (Bun)

```sh
bun run build
bun run vitest run
```

## Bun 生命週期腳本 (預設封鎖)

Bun 可能會封鎖依賴項的生命週期腳本，除非明確信任它們 (`bun pm untrusted` / `bun pm trust`)。對於此專案庫，通常被封鎖的腳本並非必要：

- `@whiskeysockets/baileys` `preinstall`：檢查 Node 主要版本是否 >= 20（我們執行 Node 22+）。
- `protobufjs` `postinstall`：發出關於不相容版本方案的警告（不產生建置產物）。

如果你遇到需要這些腳本才能運作的實際執行期問題，請明確信任它們：

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 注意事項

- 某些腳本仍硬編碼為使用 pnpm（例如 `docs:build`、`ui:*`、`protocol:check`）。目前請透過 pnpm 執行這些腳本。
