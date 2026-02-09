---
summary: "CLI 參考文件：`openclaw onboard`（互動式入門引導精靈）"
read_when:
  - 你想要為 Gateway 閘道器、工作區、身分驗證、頻道與 Skills 進行引導式設定
title: "onboard"
---

# `openclaw onboard`

互動式入門引導精靈（本機或遠端 Gateway 閘道器設定）。

## 相關指南

- CLI 入門引導中樞：[Onboarding Wizard (CLI)](/start/wizard)
- CLI 入門引導參考：[CLI Onboarding Reference](/start/wizard-cli-reference)
- CLI 自動化：[CLI Automation](/start/wizard-cli-automation)
- macOS 入門引導：[Onboarding (macOS App)](/start/onboarding)

## 範例

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Flow notes:

- `quickstart`：最少提示，自動產生 Gateway 閘道器權杖。
- `manual`：包含連接埠／綁定／身分驗證的完整提示（`advanced` 的別名）。
- 最快開始第一個聊天：`openclaw dashboard`（控制介面，不進行頻道設定）。

## 常見後續指令

```bash
openclaw configure
openclaw agents add <name>
```

<Note>

`--json` 並不代表非互動模式。用於腳本請使用 `--non-interactive`。
 Use `--non-interactive` for scripts.
</Note>
