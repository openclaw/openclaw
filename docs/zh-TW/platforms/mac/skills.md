---
summary: "macOS Skills 設定介面與 Gateway 後端狀態"
read_when:
  - 更新 macOS Skills 設定介面時
  - 變更 Skills 限制或安裝行為時
title: "Skills"
---

# Skills (macOS)

macOS 應用程式透過 Gateway 呈現 OpenClaw Skills；它不會在本地解析 Skills。

## 資料來源

- `skills.status` (Gateway) 會回傳所有 Skills，以及其符合資格與缺少的的需求
  （包括針對內建 Skills 的白名單阻擋）。
- 需求源自每個 `SKILL.md` 中的 `metadata.openclaw.requires`。

## 安裝動作

- `metadata.openclaw.install` 定義了安裝選項 (brew/node/go/uv)。
- 應用程式呼叫 `skills.install` 以在 Gateway 主機上執行安裝程式。
- 當提供多個安裝選項時，Gateway 僅呈現一個偏好的安裝程式
  （有 brew 時優先使用，否則使用 `skills.install` 的 node 管理器，預設為 npm）。

## 環境變數 / API 金鑰

- 應用程式將金鑰儲存於 `~/.openclaw/openclaw.json` 中的 `skills.entries.<skillKey>` 下。
- `skills.update` 用於更新 `enabled`、`apiKey` 和 `env`。

## 遠端模式

- 安裝與設定更新發生在 Gateway 主機上（而非本地的 Mac）。
