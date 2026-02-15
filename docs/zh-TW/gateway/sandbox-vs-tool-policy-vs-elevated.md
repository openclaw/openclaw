---
title: 沙箱 vs 工具策略 vs 提權
summary: "工具被阻擋的原因：沙箱隔離執行環境、工具允許/拒絕策略，以及提權執行閘道"
read_when: "當你遇到「沙箱監禁」或工具/提權拒絕，並想知道要修改哪個確切的設定鍵時。"
status: active
---

# 沙箱 vs 工具策略 vs 提權

OpenClaw 具有三種相關（但不同）的控制：

1. **沙箱** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) 決定**工具在哪裡執行** (Docker vs 主機)。
2. **工具策略** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) 決定**哪些工具可用/允許**。
3. **提權** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) 是一個**僅限執行的應急方案**，用於當你處於沙箱隔離時，在主機上執行。

## 快速偵錯

使用檢查器查看 OpenClaw *實際*在做什麼：

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

它會列印：

- 有效的沙箱模式/範圍/工作區存取
- 工作階段目前是否處於沙箱隔離 (主要 vs 非主要)
- 有效的沙箱工具允許/拒絕 (以及它來自智慧代理/全域/預設何處)
- 提權閘道和修復鍵路徑

## 沙箱：工具執行位置

沙箱隔離由 `agents.defaults.sandbox.mode` 控制：

- `"off"`: 所有內容都在主機上執行。
- `"non-main"`: 只有非主要的工作階段會被沙箱隔離 (群組/頻道常見的「意外」)。
- `"all"`: 所有內容都會被沙箱隔離。

請參閱[沙箱隔離](/gateway/sandboxing)了解詳情 (範圍、工作區掛載、映像檔)。

### 繫結掛載 (安全快速檢查)

- `docker.binds` _穿透_沙箱檔案系統：你掛載的任何內容都會以你設定的模式 (`:ro` 或 `:rw`) 在容器內可見。
- 如果省略模式，預設為讀寫；建議用於原始碼/機密資訊時使用 `:ro`。
- `scope: "shared"` 會忽略每個智慧代理的繫結 (僅套用全域繫結)。
- 繫結 `/var/run/docker.sock` 實際上是將主機控制權交給沙箱；請務必在有意為之時才這樣做。
- 工作區存取 (`workspaceAccess: "ro"`/`"rw"`) 與繫結模式無關。

## 工具策略：哪些工具存在/可呼叫

有兩個層面很重要：

- **工具設定檔**: `tools.profile` 和 `agents.list[].tools.profile` (基礎允許列表)
- **供應商工具設定檔**: `tools.byProvider[provider].profile` 和 `agents.list[].tools.byProvider[provider].profile`
- **全域/每個智慧代理工具策略**: `tools.allow`/`tools.deny` 和 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **供應商工具策略**: `tools.byProvider[provider].allow/deny` 和 `agents.list[].tools.byProvider[provider].allow/deny`
- **沙箱工具策略** (僅在沙箱隔離時套用): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 和 `agents.list[].tools.sandbox.tools.*`

經驗法則：

- `deny` 總是優先。
- 如果 `allow` 非空，則所有其他內容都被視為已阻擋。
- 工具策略是硬性停止：`/exec` 無法覆寫被拒絕的 `exec` 工具。
- `/exec` 僅為授權寄件者變更工作階段預設值；它不授予工具存取權限。
供應商工具鍵接受 `provider` (例如 `google-antigravity`) 或 `provider/model` (例如 `openai/gpt-5.2`)。

### 工具群組 (簡寫)

工具策略 (全域、智慧代理、沙箱) 支援 `group:*` 項目，這些項目會展開為多個工具：

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

可用的群組：

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: 所有內建 OpenClaw 工具 (不包括供應商外掛程式)

## 提權：僅限執行「在主機上執行」

提權**不會**授予額外的工具；它只會影響 `exec`。

- 如果你處於沙箱隔離狀態，`/elevated on` (或帶有 `elevated: true` 的 `exec`) 會在主機上執行 (核准可能仍然適用)。
- 使用 `/elevated full` 可跳過該工作階段的執行核准。
- 如果你已經直接執行，提權實際上是無作用的 (仍然受閘道保護)。
- 提權**不是**技能範圍的，也**不會**覆寫工具允許/拒絕。
- `/exec` 與提權是分開的。它僅為授權寄件者調整每個工作階段的執行預設值。

閘道：

- 啟用：`tools.elevated.enabled` (以及可選的 `agents.list[].tools.elevated.enabled`)
- 寄件者允許列表：`tools.elevated.allowFrom.<provider>` (以及可選的 `agents.list[].tools.elevated.allowFrom.<provider>`)

請參閱[提權模式](/tools/elevated)。

## 常見的「沙箱監禁」修復

### 「工具 X 被沙箱工具策略阻擋」

修復鍵 (擇一)：

- 停用沙箱：`agents.defaults.sandbox.mode=off` (或每個智慧代理 `agents.list[].sandbox.mode=off`)
- 允許該工具在沙箱內執行：
  - 從 `tools.sandbox.tools.deny` 中移除它 (或每個智慧代理 `agents.list[].tools.sandbox.tools.deny`)
  - 或將它新增至 `tools.sandbox.tools.allow` (或每個智慧代理允許列表)

### 「我以為這是主要工作階段，為什麼它被沙箱隔離了？」

在 `"non-main"` 模式下，群組/頻道鍵*不是*主要工作階段。請使用主要工作階段鍵 (由 `sandbox explain` 顯示) 或將模式切換為 `"off"`。
