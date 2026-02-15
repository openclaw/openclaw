---
title: 沙箱 vs 工具策略 vs Elevated
summary: "為什麼工具被封鎖：沙箱執行環境、工具允許/拒絕策略以及 Elevated 執行門檻"
read_when: "當你遇到「沙箱牢籠」或看到工具/Elevated 拒絕，並想知道要修改哪個確切的設定鍵名時。"
status: active
---

# 沙箱 vs 工具策略 vs Elevated

OpenClaw 有三個相關（但不同）的控制項：

1. **沙箱**（`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`）決定**工具在哪裡執行**（Docker vs 主機）。
2. **工具策略**（`tools.*`、`tools.sandbox.tools.*`、`agents.list[].tools.*`）決定**哪些工具可用/被允許**。
3. **Elevated**（`tools.elevated.*`、`agents.list[].tools.elevated.*`）是**僅限執行（exec-only）的逃生口**，讓你在沙箱隔離時能在主機上執行。

## 快速除錯

使用檢測器查看 OpenClaw 實際上在做什麼：

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

它會印出：

- 生效的沙箱模式/範圍（scope）/工作區存取
- 工作階段目前是否處於沙箱隔離狀態（main vs non-main）
- 生效的沙箱工具允許/拒絕（以及它來自智慧代理/全域/預設）
- Elevated 門檻和修復鍵名路徑

## 沙箱：工具在哪裡執行

沙箱隔離由 `agents.defaults.sandbox.mode` 控制：

- `"off"`：所有內容都在主機上執行。
- `"non-main"`：只有非主導（non-main）工作階段會被沙箱隔離（這是群組/頻道常見的「意外」）。
- `"all"`：所有內容都會被沙箱隔離。

請參閱 [沙箱隔離](/gateway/sandboxing) 以獲取完整矩陣（範圍、工作區掛載、映像檔）。

### 綁定掛載（安全性快速檢查）

- `docker.binds` 會**穿透**沙箱檔案系統：你掛載的任何內容在容器內都是可見的，並遵循你設定的模式（`:ro` 或 `:rw`）。
- 如果省略模式，預設為讀寫；建議針對原始碼/機密資訊使用 `:ro`。
- `scope: "shared"` 會忽略個別智慧代理的綁定（僅套用全域綁定）。
- 綁定 `/var/run/docker.sock` 實際上是將主機控制權交給沙箱；請務必謹慎執行。
- 工作區存取（`workspaceAccess: "ro"`/`"rw"`）與綁定模式是獨立的。

## 工具策略：哪些工具存在/可被呼叫

涉及三個層面：

- **工具設定檔（Tool profile）**：`tools.profile` 和 `agents.list[].tools.profile`（基礎允許清單）
- **供應商工具設定檔**：`tools.byProvider[provider].profile` 和 `agents.list[].tools.byProvider[provider].profile`
- **全域/個別智慧代理工具策略**：`tools.allow`/`tools.deny` 和 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **供應商工具策略**：`tools.byProvider[provider].allow/deny` 和 `agents.list[].tools.byProvider[provider].allow/deny`
- **沙箱工具策略**（僅在沙箱隔離時套用）：`tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 和 `agents.list[].tools.sandbox.tools.*`

經驗法則：

- `deny`（拒絕）永遠優先。
- 如果 `allow`（允許）不為空，則其他所有內容都將被視為已封鎖。
- 工具策略是強制限制：`/exec` 無法覆蓋被拒絕的 `exec` 工具。
- `/exec` 僅更改工作階段預設值以供授權發送者使用；它不會授予工具存取權限。
  供應商工具鍵名接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.2`）。

### 工具群組（簡寫）

工具策略（全域、智慧代理、沙箱）支援 `group:*` 項目，可展開為多個工具：

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

可用群組：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有內建的 OpenClaw 工具（不包括供應商外掛程式）

## Elevated：僅限執行的「在主機上執行」

Elevated **不會**授予額外的工具；它只會影響 `exec`。

- 如果你處於沙箱隔離狀態，`/elevated on`（或將 `exec` 的 `elevated` 設為 `true`）將會在主機上執行（可能仍需經過核准）。
- 使用 `/elevated full` 可以跳過該工作階段的執行核准。
- 如果你已經直接執行，Elevated 實際上沒有作用（但仍受到門檻限制）。
- Elevated 的範圍不限於 Skill，且不會覆蓋工具的允許/拒絕設定。
- `/exec` 與 Elevated 是分開的。它僅調整授權發送者的個別工作階段執行預設值。

門檻：

- 啟用：`tools.elevated.enabled`（以及可選的 `agents.list[].tools.elevated.enabled`）
- 發送者允許清單：`tools.elevated.allowFrom.<provider>`（以及可選的 `agents.list[].tools.elevated.allowFrom.<provider>`）

請參閱 [Elevated 模式](/tools/elevated)。

## 常見的「沙箱牢籠」修復方法

### 「工具 X 被沙箱工具策略封鎖」

修復鍵名（擇一）：

- 停用沙箱：`agents.defaults.sandbox.mode=off`（或個別智慧代理的 `agents.list[].sandbox.mode=off`）
- 在沙箱內允許該工具：
  - 將其從 `tools.sandbox.tools.deny` 中移除（或個別智慧代理的 `agents.list[].tools.sandbox.tools.deny`）
  - 或將其新增至 `tools.sandbox.tools.allow`（或個別智慧代理的允許清單）

### 「我以為這是主導（main）工作階段，為什麼它被沙箱隔離了？」

在 `"non-main"` 模式下，群組/頻道鍵名**不是**主導工作階段。請使用主導工作階段鍵名（由 `sandbox explain` 顯示）或將模式切換為 `"off"`。
