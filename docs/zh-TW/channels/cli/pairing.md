---
summary: CLI reference for `openclaw pairing` (approve/list pairing requests)
read_when:
  - You’re using pairing-mode DMs and need to approve senders
title: pairing
---

# `openclaw pairing`

批准或檢查 DM 配對請求（針對支援配對的頻道）。

[[BLOCK_1]]

- 配對流程: [配對](/channels/pairing)

## Commands

bash
openclaw pairing list telegram
openclaw pairing list --channel telegram --account work
openclaw pairing list telegram --json

openclaw 配對批准 telegram <code>
openclaw 配對批准 --channel telegram --account work <code> --notify

## Notes

- 通道輸入：可以透過位置傳遞 (`pairing list telegram`) 或使用 `--channel <channel>`。
- `pairing list` 支援 `--account <accountId>` 用於多帳戶通道。
- `pairing approve` 支援 `--account <accountId>` 和 `--notify`。
- 如果只設定了一個可配對的通道，則允許 `pairing approve <code>`。
