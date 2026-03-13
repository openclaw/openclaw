---
summary: macOS Skills settings UI and gateway-backed status
read_when:
  - Updating the macOS Skills settings UI
  - Changing skills gating or install behavior
title: Skills
---

# 技能 (macOS)

macOS 應用程式透過 gateway 顯示 OpenClaw 技能；不會在本地解析技能。

## 資料來源

- `skills.status`（gateway）回傳所有技能以及資格和缺少的需求
  （包含捆綁技能的允許清單封鎖）。
- 需求來自每個 `SKILL.md` 中的 `metadata.openclaw.requires`。

## 安裝動作

- `metadata.openclaw.install` 定義安裝選項（brew/node/go/uv）。
- 應用程式呼叫 `skills.install` 在 gateway 主機上執行安裝程式。
- gateway 僅顯示一個偏好的安裝程式，當提供多個時
  （有 brew 則用 brew，否則使用 `skills.install` 的 node 管理器，預設為 npm）。

## 環境變數/API 金鑰

- 應用程式將金鑰儲存在 `~/.openclaw/openclaw.json` 的 `skills.entries.<skillKey>` 下。
- `skills.update` 修補 `enabled`、`apiKey` 和 `env`。

## 遠端模式

- 安裝與設定更新發生在 gateway 主機（非本地 Mac）。
