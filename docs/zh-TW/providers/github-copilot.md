---
summary: Sign in to GitHub Copilot from OpenClaw using the device flow
read_when:
  - You want to use GitHub Copilot as a model provider
  - You need the `openclaw models auth login-github-copilot` flow
title: GitHub Copilot
---

# GitHub Copilot

## 什麼是 GitHub Copilot？

GitHub Copilot 是 GitHub 的 AI 程式碼助理。它提供您 GitHub 帳號和方案所對應的 Copilot 模型存取權限。OpenClaw 可以用兩種不同方式將 Copilot 作為模型提供者。

## 在 OpenClaw 中使用 Copilot 的兩種方式

### 1) 內建的 GitHub Copilot 提供者 (`github-copilot`)

使用原生的裝置登入流程取得 GitHub token，然後在 OpenClaw 執行時將其兌換成 Copilot API token。這是**預設**且最簡單的方式，因為不需要 VS Code。

### 2) Copilot Proxy 外掛 (`copilot-proxy`)

使用 **Copilot Proxy** VS Code 擴充功能作為本地橋接。OpenClaw 會與代理的 `/v1` 端點通訊，並使用您在那裡設定的模型清單。當您已在 VS Code 中執行 Copilot Proxy 或需要透過它路由時，請選擇此方式。您必須啟用該外掛並保持 VS Code 擴充功能持續執行。

將 GitHub Copilot 作為模型提供者 (`github-copilot`)。登入指令會執行 GitHub 裝置流程，儲存授權設定檔，並更新您的設定以使用該設定檔。

## CLI 設定

```bash
openclaw models auth login-github-copilot
```

系統會提示您造訪一個 URL 並輸入一次性程式碼。請保持終端機開啟直到完成。

### 選用參數

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
- Copilot 模型的可用性取決於您的方案；如果某個模型被拒絕，請嘗試使用其他 ID（例如 `github-copilot/gpt-4.1`）。
- 登入時會將 GitHub token 儲存在認證設定檔中，並在 OpenClaw 執行時將其兌換為 Copilot API token。
