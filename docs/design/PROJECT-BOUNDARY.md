# ClaWorks 项目边界

## 三仓 + 上游

| 仓库                             | 你在这里做什么                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **claworks/**（本仓）            | 产品运行时：`claworks.mjs`、`src/kernel/`（规划）、`extensions/claworks-robot/`、`connectors/`、`packs/` |
| **openclaw/**                    | 仅 upstream 同步；Maibot/extraSystemPrompt 等通用 seam                                                   |
| **openclaw-claworks-extension/** | 官方 OpenClaw 用户的 `cw_*` 桥接插件                                                                     |

完整布局见 `~/Projects/PROJECT-LAYOUT.md`。

## 本仓目录说明

| 路径                                | 合理    | 说明                                                    |
| ----------------------------------- | ------- | ------------------------------------------------------- |
| `claworks.mjs`                      | ✅      | 产品 CLI 入口                                           |
| `extensions/claworks-robot/`        | ✅      | 内核挂载插件                                            |
| `packages/claworks-sdk/`            | ✅      | Pack 开发 SDK                                           |
| `connectors/`                       | ✅      | OT 连接器子进程                                         |
| `packs/`                            | ✅      | 运行时已安装 pack                                       |
| `contrib/`                          | ✅      | 产品配置片段、白名单 JSON                               |
| `docs/design/`                      | ✅      | 架构与迁移设计（REPO-STRUCTURE、MIGRATION-GUIDE 等）    |
| `docs/design/legacy-from-openclaw/` | 📦 归档 | 从 openclaw 迁入的旧 ClawTwin 设计 SSOT                 |
| `contrib/industrial-oilgas-skills/` | ⚠️ 精简 | 仅保留 capability 索引；完整设计见 legacy-from-openclaw |
| `openclaw.mjs`                      | ⚠️ 兼容 | upstream 入口，长期可仅保留 claworks.mjs                |

## 已废弃（勿再开发）

- `clawtwin-platform` — Python 后端 → 已归档
- `clawtwin-studio` — 旧 UI → 已归档
- `openclaw/extensions/clawtwin|clawops|claworks` — 不应在 upstream 存在

## 下一步实现（REPO-STRUCTURE 规划）

```
src/kernel/          ← EventKernel（待建）
src/planes/data/     ← ObjectStore
src/planes/orch/     ← PlaybookEngine
src/interfaces/a2a/  ← A2A Server
```

Python 概念与 YAML 见 `docs/design/MIGRATION-GUIDE.md`。
