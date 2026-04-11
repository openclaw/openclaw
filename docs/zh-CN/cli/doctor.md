---
summary: "OpenClaw doctor CLI (`openclaw doctor`) — 健康检查 + 快速修复"
read_when:
  - 诊断配置、Gateway 和遗留服务问题
  - 应用自动修复和迁移
title: "doctor"
x-i18n:
  source_path: cli/doctor.md
  source_hash: d257a9e2797b4b0b50c1020165c8a1cd6a2342381bf9c351645ca37494c881e1
  generated_at: "2026-04-10T00:00:00Z"
  workflow: manual
---

# Doctor CLI

`openclaw doctor` 运行健康检查并应用快速修复（配置 + Gateway + 遗留服务）。

## 运行 doctor

```bash
openclaw doctor
```

### 选项

- `--no-workspace-suggestions`：禁用工作区内存提示。
- `--yes`：无需提示即可接受默认值（headless 模式）。
- `--non-interactive`：跳过提示；仅应用安全迁移。
- `--deep`：扫描系统服务以查找额外的 Gateway 安装。
- `--repair`（别名：`--fix`）：尝试自动修复检测到的问题。
- `--force`：即使不需要也强制修复。
- `--generate-gateway-token`：生成新的 Gateway 认证 token。

## Doctor 执行哪些检查

Doctor 会验证：

1. **配置完整性** — 检查 `openclaw.json` 是否存在且有效。
2. **Gateway 可达性** — 检查 Gateway 是否正在运行并可访问。
3. **遗留服务冲突** — 查找可能冲突的旧服务。
4. **权限** — 验证配置和工作区目录权限。
5. **凭证** — 检查凭证是否已配置且未过期。

## 自动修复

使用 `--repair` 或 `--fix` 时，doctor 可以：

- 修复损坏的配置文件
- 重启无响应的 Gateway 进程
- 清理孤立的会话文件
- 更新过时的配置模式
- 修复权限问题

## 示例

```bash
# 运行诊断
openclaw doctor

# 应用修复
openclaw doctor --repair

# 深度扫描
openclaw doctor --deep

# 生成新 token
openclaw doctor --generate-gateway-token
```

## 输出

Doctor 打印：

- ✅ 通过的检查
- ⚠️ 警告（建议的改进）
- ❌ 错误（需要修复）
- 🔧 应用的修复

使用 `--json` 获取机器可读的输出（如果支持）。
