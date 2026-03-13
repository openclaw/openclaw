---
summary: "Bun workflow (experimental): installs and gotchas vs pnpm"
read_when:
  - You want the fastest local dev loop (bun + watch)
  - You hit Bun install/patch/lifecycle script issues
title: Bun (Experimental)
---

# Bun（實驗性）

目標：使用 **Bun** 執行此倉庫（可選，不建議用於 WhatsApp/Telegram）
且不偏離 pnpm 工作流程。

⚠️ **不建議用於 Gateway 執行時**（WhatsApp/Telegram 有錯誤）。生產環境請使用 Node。

## 狀態

- Bun 是一個可選的本地執行環境，可直接執行 TypeScript (`bun run …`、`bun --watch …`)。
- `pnpm` 是預設的建置環境，且持續完全支援（部分文件工具仍在使用）。
- Bun 無法使用 `pnpm-lock.yaml`，且會忽略它。

## 安裝

預設：

```sh
bun install
```

注意：`bun.lock`/`bun.lockb` 被 git 忽略，因此不會造成倉庫變動。如果你想要 _不寫入鎖定檔_：

```sh
bun install --no-save
```

## 建置 / 測試（Bun）

```sh
bun run build
bun run vitest run
```

## Bun 生命週期腳本（預設被阻擋）

Bun 可能會阻擋依賴的生命週期腳本，除非明確信任 (`bun pm untrusted` / `bun pm trust`)。
對此倉庫而言，常被阻擋的腳本並非必要：

- `@whiskeysockets/baileys` `preinstall`：檢查 Node 主要版本是否 >= 20（OpenClaw 預設 Node 24，且仍支援 Node 22 LTS，目前為 `22.16+`）。
- `protobufjs` `postinstall`：發出不相容版本方案的警告（不產生建置產物）。

如果你遇到真正的執行時問題，需要使用這些腳本，請完全信任它們：

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## 注意事項

- 有些腳本仍然硬編碼使用 pnpm（例如 `docs:build`、`ui:*`、`protocol:check`）。目前請透過 pnpm 執行這些腳本。
