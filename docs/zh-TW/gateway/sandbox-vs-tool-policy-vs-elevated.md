---
title: Sandbox vs Tool Policy vs Elevated
summary: >-
  Why a tool is blocked: sandbox runtime, tool allow/deny policy, and elevated
  exec gates
read_when: >-
  You hit 'sandbox jail' or see a tool/elevated refusal and want the exact
  config key to change.
status: active
---

# Sandbox vs Tool Policy vs Elevated

OpenClaw 有三個相關（但不同）的控制項：

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) 決定 **工具執行的位置**（Docker 與主機）。
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) 決定 **哪些工具可用/被允許**。
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) 是一個 **僅限執行的逃生通道**，當你在沙盒中時可以在主機上執行。

## Quick debug

使用檢查器查看 OpenClaw 實際上在做什麼：

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

它會印出：

- 有效的沙盒模式/範圍/工作區存取
- 當前會話是否為沙盒模式（主要 vs 非主要）
- 有效的沙盒工具允許/拒絕（以及是否來自代理/全域/預設）
- 提升的閘道和修復鍵路徑

## Sandbox: 工具執行的地方

Sandboxing 由 `agents.defaults.sandbox.mode` 控制：

- `"off"`: 一切都在主機上執行。
- `"non-main"`: 只有非主要的會話會被沙盒化（對於群組/頻道來說是常見的“驚喜”）。
- `"all"`: 一切都被沙盒化。

請參閱 [Sandboxing](/gateway/sandboxing) 以獲取完整的矩陣（範圍、工作區掛載、映像）。

### 綁定掛載（安全性快速檢查）

- `docker.binds` _穿透_ 沙盒檔案系統：無論你掛載什麼，都可以在容器內部以你設定的模式可見 (`:ro` 或 `:rw`)。
- 如果你省略模式，預設為可讀寫；建議對於來源/秘密使用 `:ro`。
- `scope: "shared"` 忽略每個代理的綁定（僅適用全域綁定）。
- 綁定 `/var/run/docker.sock` 實際上將主機控制權交給沙盒；僅在有意識的情況下這樣做。
- 工作區訪問 (`workspaceAccess: "ro"`/`"rw"`) 與綁定模式無關。

## 工具政策：哪些工具存在/可調用

[[BLOCK_1]]  
兩層物質：  
[[BLOCK_1]]

- **工具設定檔**: `tools.profile` 和 `agents.list[].tools.profile` (基本允許清單)
- **供應商工具設定檔**: `tools.byProvider[provider].profile` 和 `agents.list[].tools.byProvider[provider].profile`
- **全域/每代理工具政策**: `tools.allow`/`tools.deny` 和 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **供應商工具政策**: `tools.byProvider[provider].allow/deny` 和 `agents.list[].tools.byProvider[provider].allow/deny`
- **沙盒工具政策** (僅在沙盒環境中適用): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 和 `agents.list[].tools.sandbox.tools.*`

[[BLOCK_1]]

- `deny` 總是獲勝。
- 如果 `allow` 非空，則其他所有內容都被視為被阻擋。
- 工具政策是硬性停止：`/exec` 不能覆蓋被拒絕的 `exec` 工具。
- `/exec` 只會更改授權發送者的會話預設；它不會授予工具訪問權限。
  提供者工具金鑰接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.2`）。

### 工具群組（簡稱）

工具政策（全域、代理、沙盒）支援 `group:*` 條目，這些條目可擴充為多個工具：

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
- `group:openclaw`: 所有內建的 OpenClaw 工具（不包括提供者插件）

## Elevated: exec-only “run on host”

Elevated 並不會提供額外的工具；它僅影響 `exec`。

- 如果你處於沙盒環境，`/elevated on`（或 `exec` 搭配 `elevated: true`）會在主機上執行（仍可能需要批准）。
- 使用 `/elevated full` 可以跳過該會話的執行批准。
- 如果你已經在直接執行，提升權限實際上是無效的（仍然受到限制）。
- 提升權限**不**是技能範圍內的，並且**不**會覆蓋工具的允許/拒絕設置。
- `/exec` 與提升權限是分開的。它僅調整授權發送者的每會話執行預設值。

Gates:

- 啟用: `tools.elevated.enabled` (以及選擇性地 `agents.list[].tools.elevated.enabled`)
- 發送者白名單: `tools.elevated.allowFrom.<provider>` (以及選擇性地 `agents.list[].tools.elevated.allowFrom.<provider>`)

請參閱 [Elevated Mode](/tools/elevated)。

## 常見的「沙盒監獄」修復方法

### “工具 X 被沙盒工具政策阻擋”

[[BLOCK_1]]  
修正鍵（選擇一個）：  
[[BLOCK_1]]

- 禁用沙盒: `agents.defaults.sandbox.mode=off` (或每個代理 `agents.list[].sandbox.mode=off`)
- 允許工具在沙盒內使用:
  - 從 `tools.sandbox.tools.deny` 中移除它 (或每個代理 `agents.list[].tools.sandbox.tools.deny`)
  - 或將它添加到 `tools.sandbox.tools.allow` (或每個代理允許)

### “我以為這是主環境，為什麼它是沙盒環境？”

在 `"non-main"` 模式下，群組/頻道金鑰並不是主要的。請使用主要的會話金鑰（由 `sandbox explain` 顯示）或切換模式至 `"off"`。
