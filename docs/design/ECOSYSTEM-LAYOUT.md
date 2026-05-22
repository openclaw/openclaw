# Projects 布局（ClaWorks 生态）

> 整理日期：2026-05-22  
> 原则：**openclaw = 上游网关**，**claworks = 产品本体**，**openclaw-claworks-extension = 官方 OpenClaw 桥接插件**

## 保留（主线）

| 目录                           | 角色               | 边界                                                       |
| ------------------------------ | ------------------ | ---------------------------------------------------------- |
| `openclaw/`                    | OpenClaw 上游 fork | Gateway、渠道、插件宿主；**不**放 ClaWorks 产品代码        |
| `claworks/`                    | ClaWorks 产品本体  | OpenClaw fork + EventKernel / DataPlane / OrchPlane（TS）  |
| `openclaw-claworks-extension/` | 桥接插件仓         | `cw_*` 工具、HTTP/MCP 客户端；给**官方** OpenClaw 用户安装 |
| `claworks-packs/`              | 行业 Pack 真源     | 分层 core/comms/… 与 classic base/enterprise-\*            |
| `daily-report-system/`         | 垂直行业应用       | Python 日报引擎 + `claworks-packs/daily-report` 集成       |

## 垂直应用：daily-report-system

日报分析引擎（Python）+ `claworks-packs/daily-report` Pack。  
**不要**在 `claworks/contrib/packs/` 维护 Pack（已迁移，仅留 README 指针）。

## 工作区

`~/Projects/openclaw.code-workspace` 包含上述五个目录。

## 已归档

见 `~/Projects/archive/ecosystem-legacy-20260522/`：

| 原路径                                                    | 原因                                  |
| --------------------------------------------------------- | ------------------------------------- |
| `clawtwin-platform/`                                      | 旧 Python 后端（已迁 TS → claworks）  |
| `clawtwin-studio/`                                        | 旧 MAIBOT/Refine UI（非当前三仓主线） |
| `openclaw-variants/`                                      | OpenClaw 实验 fork 沙箱               |
| Projects 根 orphan `contrib/`、`extensions/`、`packages/` | 与 canonical 仓重复的空壳             |

openclaw 内曾有的 ClaWorks WIP 快照：`archive/.../openclaw-claw-wip-untracked/`  
设计文档 SSOT 迁入：`claworks/docs/design/legacy-from-openclaw/`

## 依赖关系

```
openclaw (upstream)
    ↑ fork
claworks (产品运行时)
    ↑ HTTP/MCP
openclaw-claworks-extension (插件，装到官方 openclaw)
    ↑ pack manifest
claworks-packs (行业包)
    ↑ vertical integration
daily-report-system (Python 引擎 + install 脚本)
```

## Pack 加载

- 环境变量：`CLAWORKS_PACKS_DIR=../claworks-packs`
- 或 sibling 目录自动发现
- **不再**使用 `claworks/contrib/packs/` 作为代码目录

## 不要做的事

- 不要在 `openclaw/` 里新增 `extensions/clawtwin|clawops|claworks` 副本
- 不要在 `openclaw/` 核心里注册 `clawworks` CLI（应在 `claworks` 仓）
- 不要恢复 `clawtwin-platform` 除非明确维护 Python 遗留栈
