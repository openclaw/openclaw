---
summary: "Defines capital-hft:* as a legacy compatibility namespace for Capital API workflows."
read_when:
  - You see capital-hft:* in package scripts or older automation reports
  - You need to choose between capital:* and capital-hft:* commands
title: "Capital capital-hft Compatibility"
---

# Capital / capital-hft 相容規則

- generatedAt: 2026-05-21
- status: active_compatibility_policy
- preferred namespace: `capital:*`
- legacy namespace: `capital-hft:*`

## 結論

`capital-hft:*` 不是目前架構名稱，只是舊命名的相容入口。

新文件、新自動化、新回報一律優先顯示 `capital:*`。  
`capital-hft:*` 只保留給既有 automation、舊報告、舊 Telegram/controlled runner task，不主動新增新功能。

## 保留原因

- 目前 `package.json` 仍有多個 `capital-hft:*` script，被歷史 automation 與 controlled runner 引用。
- 直接刪除會讓舊任務失敗，並造成不必要的回歸。
- 正確做法是保留相容 alias，並確保重要 `capital:*` 與 `capital-hft:*` 指向同一命令。

## 驗證

```powershell
pnpm capital:brokerdesk-compat:check
```

此檢查會確認常用 Capital 流程的 `capital:*` 與 `capital-hft:*` 命令完全一致。

## 禁止

- 不再用 `BrokerDesk` 當 OpenClaw Capital API 架構名稱。
- 不把 `D:\OpenClaw\BrokerDesk` 當新功能主路徑。
- 不新增只有 `capital-hft:*`、沒有 `capital:*` 對應的新交易流程。
