# 方案：为 OpenClaw 开启文件读写权限 (v1.0)

当前状态下，小屁（Agent）因为配置文件的安全限制，没有读写本地文件的能力。这是因为您的 `~/.openclaw/openclaw.json` 中配置了：

```json
"tools": {
  "profile": "messaging"
}
```

`messaging` 配置文件只给了基础的对话能力。为了让其具备持久化记忆的能力，我们需要为其开放文件操作工具。

## 拟议修改

我们将修改 `~/.openclaw/openclaw.json` 配置文件。

### 方案 A：切换至 `coding` 配置文件 (推荐)

将 `tools.profile` 从 `messaging` 改为 `coding`。
此配置文件不仅包含文件读写（read, write, edit, create），还包含代码执行终端（exec工具），是全功能助手的最佳选择。

**修改内容:**

#### [MODIFY] [openclaw.json](file:///Users/ppg/.openclaw/openclaw.json)

```diff
   "tools": {
-    "profile": "messaging"
+    "profile": "coding"
   },
```

### 方案 B：仅显式添加所需的文件读写工具

如果出于安全考虑，只希望其具有文件读写能力，而不开启其他高级功能（如终端）。

**修改内容:**

#### [MODIFY] [openclaw.json](file:///Users/ppg/.openclaw/openclaw.json)

```diff
   "tools": {
     "profile": "messaging",
+    "allow": ["read", "write", "edit", "create", "ls", "grep"]
   },
```

## 执行验证计划

1. 选择一种方案应用修改。
2. 重启 Gateway 服务：执行 `launchctl stop ai.openclaw.gateway && launchctl start ai.openclaw.gateway` （遵守 MEMORY.md 中的 P0 指令）。
3. 让用户在 TUI 中询问 Agent：“现在你看一下工具箱，有 write 或者 create 工具了吗？”
