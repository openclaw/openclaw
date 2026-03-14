---
read_when:
  - 从仓库运行脚本时
  - 在 ./scripts 下添加或修改脚本时
summary: 仓库脚本：用途、范围和安全注意事项
title: 脚本
x-i18n:
  generated_at: "2026-02-01T21:38:11Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bfedc3c123c4a43b351f793e2137568786f90732723da5fd223c2a088bc59e43
  source_path: help/scripts.md
  workflow: 15
---

# 脚本

`scripts/` 目录包含用于本地工作流和运维任务的辅助脚本。
当任务明确与某个脚本相关时使用这些脚本；否则优先使用 CLI。

## 约定

- 除非在文档或发布检查清单中引用，否则脚本为**可选**。
- 当 CLI 接口存在时优先使用（例如：认证监控使用 `openclaw models status --check`）。
- 假定脚本与特定主机相关；在新机器上运行前请先阅读脚本内容。

## 认证监控脚本

认证监控脚本的文档请参阅：
[/automation/auth-monitoring](/automation/auth-monitoring)

## 添加脚本时

- 保持脚本专注且有文档说明。
- 在相关文档中添加简短条目（如果缺少则创建一个）。
