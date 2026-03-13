---
summary: CLI reference for `openclaw pairing` (approve/list pairing requests)
read_when:
  - You’re using pairing-mode DMs and need to approve senders
title: pairing
---

# `openclaw pairing`

批准或檢查 DM 配對請求（適用於支援配對的頻道）。

相關資訊：

- 配對流程：[配對](/channels/pairing)

## 指令

bash
openclaw pairing list telegram
openclaw pairing list --channel telegram --account work
openclaw pairing list telegram --json

openclaw pairing approve telegram <code>
openclaw pairing approve --channel telegram --account work <code> --notify

## 備註

- 頻道輸入：可使用位置參數傳入 (`pairing list telegram`) 或使用 `--channel <channel>`。
- `pairing list` 支援 `--account <accountId>` 用於多帳號頻道。
- `pairing approve` 支援 `--account <accountId>` 和 `--notify`。
- 若只設定一個支援配對的頻道，允許使用 `pairing approve <code>`。
