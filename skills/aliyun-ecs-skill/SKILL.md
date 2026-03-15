---
name: aliyun-ecs-skill
description: Manage Alibaba Cloud ECS (Elastic Compute Service) — query instances, monitoring, firewall, snapshots, remote execution. Use when user asks about ECS, 阿里云服务器, or Alibaba Cloud. NOT for Tencent Cloud or other cloud providers.
metadata:
  {
    "openclaw":
      {
        "emoji": "☁️",
        "requires": {},
        "install":
          [
            {
              "id": "node-aliyun-sdk",
              "kind": "node",
              "package": "@alicloud/openapi-client",
              "label": "Install AliCloud SDK",
            },
            {
              "id": "node-aliyun-ecs-sdk",
              "kind": "node",
              "package": "@alicloud/ecs20140526",
              "label": "Install AliCloud ECS SDK",
            },
          ],
      },
  }
---

# Aliyun ECS 云服务器运维

管理阿里云ECS（弹性计算服务）实例。

## 首次使用 — 自动设置

当用户首次要求管理阿里云服务器时，按以下流程操作：

### 步骤 1：检查当前状态

```bash
{baseDir}/scripts/setup.sh --check-only
```

如果输出显示一切 OK（SDK 已安装、config 已配置、ECS 已就绪），跳到「调用格式」。

### 步骤 2：如果未配置，引导用户提供密钥

告诉用户：
> 我需要你的阿里云 API 密钥来连接 ECS 服务器。请提供：
> 1. **AccessKey ID** — 阿里云 API 密钥 ID
> 2. **AccessKey Secret** — 阿里云 API 密钥 Secret
>
> 你可以在 [阿里云控制台 > 访问控制 > AccessKey管理](https://ram.console.aliyun.com/manage/ak) 获取。
> 
> ⚠️ 建议使用子账号，只授予ECS相关权限（ecs:*）

### 步骤 3：用户提供密钥后，运行自动设置

```bash
{baseDir}/scripts/setup.sh --access-key-id "<用户提供的AccessKeyId>" --access-key-secret "<用户提供的AccessKeySecret>"
```

脚本会自动：
- 检查并安装阿里云SDK（如未安装）
- 创建 `~/.aliyun/config.json` 配置文件
- 写入 ECS 配置和密钥
- 验证连接

设置完成后即可开始使用。

## 调用格式

所有命令使用以下格式：

```
aliyun-ecs <command> [options]
```

或直接使用 Node.js 脚本：

```bash
node {baseDir}/src/index.js <command> [options]
```

## 工具总览

| 类别 | 说明 |
|------|------|
| 地域查询 | 获取可用地域列表 |
| 实例管理 | 查询、启动、停止、重启实例 |
| 监控与告警 | 获取多指标监控数据 |
| 快照管理 | 创建、查询、回滚快照 |
| 安全组 | 规则增删改查 |

## 常用操作

### 获取地域列表

```bash
aliyun-ecs regions
```

### 实例管理

```bash
# 查询实例列表
aliyun-ecs list --region cn-hangzhou

# 查询指定实例
aliyun-ecs info --region cn-hangzhou --id i-xxxxxxxxxx

# 启动实例
aliyun-ecs start --region cn-hangzhou --id i-xxxxxxxxxx

# 停止实例
aliyun-ecs stop --region cn-hangzhou --id i-xxxxxxxxxx

# 重启实例
aliyun-ecs restart --region cn-hangzhou --id i-xxxxxxxxxx
```

### 监控与告警

```bash
# 获取监控数据（CPU、内存、网络）
aliyun-ecs monitor --region cn-hangzhou --id i-xxxxxxxxxx --metrics CPU,Memory

# 支持的监控指标:
# CPU - CPU使用率
# Memory - 内存使用率
# InternetIn - 公网入带宽(Kbps)
# InternetOut - 公网出带宽(Kbps)
# IntranetIn - 内网入带宽(Kbps)
# IntranetOut - 内网出带宽(Kbps)
```

### 快照管理

```bash
# 创建快照
aliyun-ecs snapshot create --region cn-hangzhou --disk-id d-xxxxxxxxxx --name "backup-20260312"

# 列出快照
aliyun-ecs snapshot list --region cn-hangzhou --id i-xxxxxxxxxx

# 回滚快照
aliyun-ecs snapshot rollback --region cn-hangzhou --disk-id d-xxxxxxxxxx --snapshot-id s-xxxxxxxxxx
```

### 安全组（防火墙）

```bash
# 查询安全组规则
aliyun-ecs security-group list --region cn-hangzhou --group-id sg-xxxxxxxxxx

# 添加安全组规则（开放80端口）
aliyun-ecs security-group add --region cn-hangzhou --group-id sg-xxxxxxxxxx --port 80 --protocol tcp

# 删除安全组规则
aliyun-ecs security-group remove --region cn-hangzhou --group-id sg-xxxxxxxxxx --port 80 --protocol tcp
```

## 使用规范

1. **Region 参数规则**: 除 `regions` 外，所有操作都**必须**传入 `--region` 参数
2. **首次使用流程**: 先调用 `regions` 获取地域列表 → 再调用 `list` 获取实例列表 → 记住 InstanceId 和 Region 供后续使用
3. **危险操作前先确认**: 安全组修改、实例停止/重启、快照回滚等，先向用户确认
4. **错误处理**: 如果调用失败，先用 `setup.sh --check-only` 诊断问题
5. **建议子账号**: 为了安全，建议用户使用子账号AccessKey，只授予ECS相关权限
