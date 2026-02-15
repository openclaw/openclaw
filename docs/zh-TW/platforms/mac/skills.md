---
summary: "macOS 技能設定使用者介面與由 Gateway 支援的狀態"
read_when:
  - 更新 macOS 技能設定使用者介面時
  - 變更技能閘道或安裝行為時
title: "技能"
---

# 技能 (macOS)

macOS 應用程式透過 Gateway 顯示 OpenClaw 技能；它不在本機解析技能。

## 資料來源

- `skills.status` (Gateway) 回傳所有技能、資格和缺少的需求 (包括捆綁技能的允許清單封鎖)。
- 需求來自每個 `SKILL.md` 中的 `metadata.openclaw.requires`。

## 安裝動作

- `metadata.openclaw.install` 定義了安裝選項 (brew/node/go/uv)。
- 應用程式呼叫 `skills.install` 以在 Gateway 主機上執行安裝程式。
- Gateway 在提供多個安裝程式時，只提供一個首選安裝程式 (可用時為 brew，否則為 `skills.install` 中的節點管理器，預設為 npm)。

## 環境/API 密鑰

- 應用程式將密鑰儲存在 `~/.openclaw/openclaw.json` 中的 `skills.entries.<skillKey>` 下。
- `skills.update` 修補 `enabled`、`apiKey` 和 `env`。

## 遠端模式

- 安裝 + 設定更新發生在 Gateway 主機上 (而非本機 Mac)。
