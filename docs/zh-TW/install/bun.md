---
summary: "Bun 工作流程（實驗性）：安裝方式與相較 pnpm 的注意事項"
read_when:
  - 你想要最快的本地開發迴圈（bun + watch）
  - 生產環境請使用 Node。
title: "Bun（實驗性）"
---

# Bun（實驗性）

目標：使用 **Bun** 執行此儲存庫（可選，不建議用於 WhatsApp／Telegram），
且不偏離 pnpm 的工作流程。

⚠️ **不建議用於 Gateway runtime**（WhatsApp／Telegram 的錯誤）。正式環境請使用 Node。 如果你想要 _不寫入 lockfile_：

## Status

- Bun 是用於直接執行 TypeScript 的可選本地執行環境（`bun run …`、`bun --watch …`）。
- `pnpm` 是建置的預設方案，並持續獲得完整支援（且被部分文件工具使用）。
- Bun 無法使用 `pnpm-lock.yaml`，並會忽略它。

## 安裝

Default:

```sh
bun install
```

注意：`bun.lock`／`bun.lockb` 已加入 gitignore，因此不論採用哪種方式都不會造成儲存庫變動。若你希望「不寫入任何 lockfile」： Bun 生命週期腳本（預設被封鎖）

```sh
bun install --no-save
```

## 建置／測試（Bun）

```sh
bun run build
bun run vitest run
```

## Bun 可能會封鎖相依套件的生命週期腳本，除非明確信任（`bun pm untrusted` / `bun pm trust`）。

對於此 repo，常被封鎖的腳本並非必要：
注意事項

- `@whiskeysockets/baileys` `preinstall`：檢查 Node 主要版本是否 >= 20（我們使用 Node 22+）。
- `protobufjs` `postinstall`：輸出關於不相容版本配置的警告（不會產生建置產物）。

如果你遇到需要這些腳本的實際執行期問題，請明確信任它們：

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 注意事項

- 部分腳本仍硬編碼為 pnpm（例如 `docs:build`、`ui:*`、`protocol:check`）。目前請透過 pnpm 執行這些腳本。 穩定版、beta 與 dev 頻道：語意、切換與標記
