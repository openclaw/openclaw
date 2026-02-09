---
summary: "macOS Skills 設定 UI 與以 Gateway 閘道器為後端的狀態"
read_when:
  - 更新 macOS Skills 設定 UI
  - 變更 Skills 的管控或安裝行為
title: "Skills"
---

# Skills（macOS）

macOS 應用程式透過 Gateway 閘道器呈現 OpenClaw Skills；不會在本機解析 Skills。

## 資料來源

- `skills.status`（Gateway 閘道器）會回傳所有 Skills，以及可用性與缺少的需求
  （包含對隨附 Skills 的允許清單封鎖）。
- 需求是從每個 `SKILL.md` 中的 `metadata.openclaw.requires` 推導而來。

## 安裝動作

- `metadata.openclaw.install` 定義安裝選項（brew/node/go/uv）。
- 應用程式會呼叫 `skills.install` 在閘道器主機上執行安裝程式。
- 當提供多個安裝器時，Gateway 閘道器只會呈現一個偏好的安裝器
  （可用時優先使用 brew，否則使用來自 `skills.install` 的 node 管理器，預設為 npm）。

## 環境變數／API 金鑰

- 應用程式會將金鑰儲存在 `~/.openclaw/openclaw.json` 的 `skills.entries.<skillKey>` 底下。
- `skills.update` 會修補 `enabled`、`apiKey` 與 `env`。

## 遠端模式

- Install + config updates happen on the gateway host (not the local Mac).
