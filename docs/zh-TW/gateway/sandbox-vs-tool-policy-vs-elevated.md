---
title: 沙箱 vs 工具政策 vs Elevated
summary: "為什麼工具會被封鎖：沙箱執行期、工具允許／拒絕政策，以及 Elevated 執行閘門"
read_when: "你遇到「sandbox jail」或看到工具／elevated 被拒，並想知道要修改的確切設定鍵時。"
status: active
---

# 沙箱 vs 工具政策 vs Elevated

OpenClaw 有三種相關（但不同）的控制：

1. **Sandbox**（`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`）決定 **工具在哪裡執行**（Docker vs 主機）。
2. **Tool policy**（`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`）決定 **哪些工具可用／被允許**。
3. **Elevated**（`tools.elevated.*`, `agents.list[].tools.elevated.*`）是一個 **僅限 exec 的逃生閥**，讓你在被沙箱隔離時仍能在主機上執行。

## Quick debug

使用檢查器查看 OpenClaw _實際上_ 在做什麼：

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

It prints:

- 生效中的沙箱模式／範圍／工作區存取
- whether the session is currently sandboxed (main vs non-main)
- 生效中的沙箱工具允許／拒絕（以及來源是 agent／global／default）
- Elevated 閘門與修正用的設定鍵路徑

## Sandbox：工具在哪裡執行

沙箱由 `agents.defaults.sandbox.mode` 控制：

- `"off"`：所有東西都在主機上執行。
- `"non-main"`：只有非 main 工作階段會被沙箱隔離（群組／頻道常見的「驚喜」）。
- `"all"`：所有東西都在沙箱中。

See [Sandboxing](/gateway/sandboxing) for the full matrix (scope, workspace mounts, images).

### Bind mounts（安全性快速檢查）

- `docker.binds` 會「穿透」沙箱檔案系統：你掛載的內容會依你設定的模式（`:ro` 或 `:rw`）在容器內可見。
- Default is read-write if you omit the mode; prefer `:ro` for source/secrets.
- `scope: "shared"` 會忽略每個 agent 的綁定（只套用全域綁定）。
- 綁定 `/var/run/docker.sock` 等同於把主機控制權交給沙箱；僅在有意識下使用。
- 工作區存取（`workspaceAccess: "ro"`/`"rw"`）與 bind 模式是獨立的。

## Tool policy：哪些工具存在／可被呼叫

Two layers matter:

- **Tool profile**：`tools.profile` 與 `agents.list[].tools.profile`（基礎允許清單）
- **Provider tool profile**：`tools.byProvider[provider].profile` 與 `agents.list[].tools.byProvider[provider].profile`
- **Global／per-agent 工具政策**：`tools.allow`/`tools.deny` 與 `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Provider 工具政策**：`tools.byProvider[provider].allow/deny` 與 `agents.list[].tools.byProvider[provider].allow/deny`
- **Sandbox 工具政策**（僅在沙箱中套用）：`tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` 與 `agents.list[].tools.sandbox.tools.*`

Rules of thumb:

- `deny` always wins.
- 若 `allow` 非空，其他一切都會被視為封鎖。
- 工具政策是硬性阻擋：`/exec` 無法覆寫被拒絕的 `exec` 工具。
- `/exec` only changes session defaults for authorized senders; it does not grant tool access.
  `/exec` 只會改變已授權寄件者的工作階段預設值；它不會授予工具存取權。
  Provider 工具鍵可接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.2`）。

### 工具群組（捷徑）

工具政策（global、agent、sandbox）支援 `group:*` 項目，會展開為多個工具：

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

- `group:runtime`：`exec`, `bash`, `process`
- `group:fs`：`read`, `write`, `edit`, `apply_patch`
- `group:sessions`：`sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`：`memory_search`, `memory_get`
- `group:ui`：`browser`, `canvas`
- `group:automation`：`cron`, `gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有內建的 OpenClaw 工具（不含 provider 外掛）

## Elevated：僅限 exec 的「在主機上執行」

Elevated **不會** 授予額外工具；它只影響 `exec`。

- 若你被沙箱隔離，`/elevated on`（或搭配 `elevated: true` 的 `exec`）會在主機上執行（仍可能需要核准）。
- 使用 `/elevated full` 可略過該工作階段的 exec 核准。
- If you’re already running direct, elevated is effectively a no-op (still gated).
- Elevated **不** 以 Skills 為範圍，且 **不** 覆寫工具的允許／拒絕。
- `/exec` is separate from elevated. 37. 它只會為已授權的傳送者調整每個 session 的 exec 預設值。

閘門：

- 啟用：`tools.elevated.enabled`（以及可選的 `agents.list[].tools.elevated.enabled`）
- 寄件者允許清單：`tools.elevated.allowFrom.<provider>`（以及可選的 `agents.list[].tools.elevated.allowFrom.<provider>`）

請參閱 [Elevated Mode](/tools/elevated)。

## 常見「sandbox jail」修正方式

### 「工具 X 被 sandbox 工具政策封鎖」

修正用設定鍵（擇一）：

- 停用沙箱：`agents.defaults.sandbox.mode=off`（或每 agent 的 `agents.list[].sandbox.mode=off`）
- 在沙箱內允許該工具：
  - 從 `tools.sandbox.tools.deny` 移除（或每 agent 的 `agents.list[].tools.sandbox.tools.deny`）
  - 或將其加入 `tools.sandbox.tools.allow`（或每 agent 的 allow）

### 「我以為這是 main，為什麼會被沙箱隔離？」

In `"non-main"` mode, group/channel keys are _not_ main. Use the main session key (shown by `sandbox explain`) or switch mode to `"off"`.
