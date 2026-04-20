---
summary: "背景任务之上的 Task Flow 流编排层"
read_when:
  - 您想了解 Task Flow 如何与后台任务相关
  - 您在发布说明或文档中遇到 Task Flow 或 openclaw tasks flow
  - 您想检查或管理持久流状态
title: "Task Flow"
---

# Task Flow

Task Flow 是位于 [后台任务](/automation/tasks) 之上的流编排基础。它管理具有自己状态、版本跟踪和同步语义的持久多步骤流，而单个任务仍然是分离工作的单位。

## 何时使用 Task Flow

当工作跨越多个顺序或分支步骤，并且您需要在网关重启后保持持久的进度跟踪时，使用 Task Flow。对于单个后台操作，普通的 [任务](/automation/tasks) 就足够了。

| 场景                              | 使用                  |
| ------------------------------------- | -------------------- |
| 单个后台作业                 | 普通任务           |
| 多步骤管道（A 然后 B 然后 C） | Task Flow（托管）  |
| 观察外部创建的任务      | Task Flow（镜像） |
| 一次性提醒                     | Cron 作业             |

## 同步模式

### 托管模式

Task Flow 拥有端到端的生命周期。它创建任务作为流步骤，驱动它们完成，并自动推进流状态。

示例：一个每周报告流，它（1）收集数据，（2）生成报告，（3）交付报告。Task Flow 将每个步骤创建为后台任务，等待完成，然后移动到下一步。

```
Flow: weekly-report
  Step 1: gather-data     → task created → succeeded
  Step 2: generate-report → task created → succeeded
  Step 3: deliver         → task created → running
```

### 镜像模式

Task Flow 观察外部创建的任务并保持流状态同步，而不取得任务创建的所有权。当任务来自 cron 作业、CLI 命令或其他来源，并且您希望将它们的进度作为流统一查看时，这很有用。

示例：三个独立的 cron 作业，一起形成一个 "晨间运维" 例程。镜像流跟踪它们的集体进度，而不控制它们何时或如何运行。

## 持久状态和版本跟踪

每个流都持久化自己的状态并跟踪版本，以便进度在网关重启后仍然存在。版本跟踪在多个来源尝试同时推进同一个流时启用冲突检测。

## 取消行为

`openclaw tasks flow cancel` 在流上设置粘性取消意图。流中的活动任务被取消，并且不启动新步骤。取消意图在重启后仍然存在，因此即使在所有子任务终止之前网关重启，已取消的流也会保持取消状态。

## CLI 命令

```bash
# 列出活动和最近的流
openclaw tasks flow list

# 显示特定流的详细信息
openclaw tasks flow show <lookup>

# 取消运行中的流及其活动任务
openclaw tasks flow cancel <lookup>
```

| 命令                           | 描述                                   |
| --------------------------------- | --------------------------------------------- |
| `openclaw tasks flow list`        | 显示带状态和同步模式的跟踪流 |
| `openclaw tasks flow show <id>`   | 通过流 ID 或查找键检查一个流     |
| `openclaw tasks flow cancel <id>` | 取消运行中的流及其活动任务    |

## 流如何与任务相关

流协调任务，而不是替换它们。单个流在其生命周期内可能驱动多个后台任务。使用 `openclaw tasks` 检查单个任务记录，使用 `openclaw tasks flow` 检查编排流。

## 相关

- [后台任务](/automation/tasks) — 流协调的分离工作 ledger
- [CLI: tasks](/cli/index#tasks) — `openclaw tasks flow` 的 CLI 命令参考
- [自动化概览](/automation) — 所有自动化机制一览
- [Cron 作业](/automation/cron-jobs) — 可能输入到流中的计划作业