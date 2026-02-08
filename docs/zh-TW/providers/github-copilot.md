---
summary: 「使用裝置流程從 OpenClaw 登入 GitHub Copilot」
read_when:
  - 「你想將 GitHub Copilot 作為模型提供者使用」
  - 「你需要 `openclaw models auth login-github-copilot` 流程」
title: 「GitHub Copilot」
x-i18n:
  source_path: providers/github-copilot.md
  source_hash: 503e0496d92c921e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:55Z
---

# GitHub Copilot

## 什麼是 GitHub Copilot？

GitHub Copilot 是 GitHub 的 AI 程式設計助理。它會根據你的 GitHub 帳戶與方案，提供對 Copilot
模型的存取。OpenClaw 可以透過兩種不同方式將 Copilot 作為模型提供者使用。

## 在 OpenClaw 中使用 Copilot 的兩種方式

### 1) 內建 GitHub Copilot 提供者（`github-copilot`）

使用原生的裝置登入流程來取得 GitHub 權杖，然後在 OpenClaw 執行時將其交換為
Copilot API 權杖。這是**預設**且最簡單的途徑，因為它不需要 VS Code。

### 2) Copilot Proxy 外掛（`copilot-proxy`）

使用 **Copilot Proxy** VS Code 擴充功能作為本機橋接。OpenClaw 會與代理程式的
`/v1` 端點通訊，並使用你在其中設定的模型清單。當你已在 VS Code 中執行
Copilot Proxy，或需要透過它進行路由時，請選擇此方式。你必須啟用外掛，並保持
VS Code 擴充功能持續執行。

將 GitHub Copilot 作為模型提供者使用（`github-copilot`）。登入指令會執行
GitHub 裝置流程、儲存一個身分驗證設定檔，並更新你的設定以使用該設定檔。

## CLI 設定

```bash
openclaw models auth login-github-copilot
```

系統會提示你造訪一個 URL 並輸入一次性代碼。在流程完成之前，請保持終端機開啟。

### 選用旗標

```bash
openclaw models auth login-github-copilot --profile-id github-copilot:work
openclaw models auth login-github-copilot --yes
```

## 設定預設模型

```bash
openclaw models set github-copilot/gpt-4o
```

### 設定片段

```json5
{
  agents: { defaults: { model: { primary: "github-copilot/gpt-4o" } } },
}
```

## 注意事項

- 需要互動式 TTY；請直接在終端機中執行。
- Copilot 模型的可用性取決於你的方案；如果某個模型被拒絕，請嘗試
  其他 ID（例如 `github-copilot/gpt-4.1`）。
- 登入流程會在身分驗證設定檔儲存庫中儲存 GitHub 權杖，並在 OpenClaw 執行時將其交換為
  Copilot API 權杖。
