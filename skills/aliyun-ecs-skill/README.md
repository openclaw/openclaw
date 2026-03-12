# Aliyun ECS Skill for OpenClaw

阿里云ECS（弹性计算服务）管理技能，让你通过OpenClaw用自然语言管理阿里云服务器。

## 功能特性

- ✅ **实例管理** - 查询、启动、停止、重启ECS实例
- ✅ **监控查询** - 查看CPU、内存、网络等监控指标
- ✅ **快照管理** - 创建、查看、回滚磁盘快照
- ✅ **安全组** - 管理防火墙规则
- 🔄 **远程命令** - 通过云助手在实例上执行命令（开发中）

## 安装

```bash
# 进入skill目录
cd ~/.openclaw/skills/aliyun-ecs-skill

# 安装依赖
npm install

# 配置阿里云密钥
./scripts/setup.sh --access-key-id YOUR_ACCESS_KEY_ID --access-key-secret YOUR_ACCESS_KEY_SECRET
```

## 使用方法

### 查询地域列表
```bash
aliyun-ecs regions
```

### 查询实例列表
```bash
aliyun-ecs list --region cn-hangzhou
```

### 启动/停止/重启实例
```bash
aliyun-ecs start --region cn-hangzhou --id i-bp67acfmxazb4p****
aliyun-ecs stop --region cn-hangzhou --id i-bp67acfmxazb4p****
aliyun-ecs restart --region cn-hangzhou --id i-bp67acfmxazb4p****
```

### 创建快照
```bash
aliyun-ecs snapshot create --region cn-hangzhou --disk-id d-bp67acfmxazb4p**** --name "backup-20260312"
```

### 管理安全组
```bash
# 查看安全组列表
aliyun-ecs security-group list --region cn-hangzhou

# 添加规则（开放80端口）
aliyun-ecs security-group add --region cn-hangzhou --group-id sg-bp67acfmxazb4p**** --port 80

# 删除规则
aliyun-ecs security-group remove --region cn-hangzhou --group-id sg-bp67acfmxazb4p**** --port 80
```

## 与腾讯云Lighthouse的区别

| 对比项 | 阿里云ECS | 腾讯云Lighthouse |
|--------|-----------|------------------|
| 定位 | 企业级弹性计算 | 轻量应用服务器 |
| 目标用户 | 中大型企业、开发者 | 个人开发者、小企业 |
| 计费方式 | 包年包月/按量付费 | 套餐包（更便宜） |
| 功能丰富度 | 更丰富（SLB、VPC等） | 简洁够用 |
| 市场占有率 | ~35-40%（第一） | ~15-18%（第三） |

## 典型使用场景

### 场景1: 快速部署测试环境
```
"帮我创建一台杭州区域的2核4G服务器"
→ 选择镜像 → 配置安全组 → 启动实例
```

### 场景2: 大促前扩容
```
"双11快到了，给所有生产服务器做快照备份"
→ 批量创建快照
```

### 场景3: 安全加固
```
"检查所有服务器的安全组，只开放必要的端口"
→ 列出规则 → 识别风险 → 清理多余规则
```

## 配置说明

配置文件位于 `~/.aliyun/config.json`：

```json
{
  "accessKeyId": "YOUR_ACCESS_KEY_ID",
  "accessKeySecret": "YOUR_ACCESS_KEY_SECRET",
  "defaultRegion": "cn-hangzhou",
  "endpoint": "ecs.aliyuncs.com"
}
```

**安全建议**: 使用RAM子账号，只授予ECS相关权限（`ecs:*`）

## 开发计划

- [x] 基础实例管理
- [x] 快照管理
- [x] 安全组管理
- [ ] 监控告警
- [ ] 远程命令执行（云助手）
- [ ] 自动伸缩

## 贡献

欢迎提交PR！请确保：
1. 代码通过ESLint检查
2. 添加必要的测试
3. 更新文档

## 许可

MIT

## 作者

Leo & AI Agent

---

**关联**: 本项目与 [tencentcloud-lighthouse-skill](https://clawhub.ai/skills/tencentcloud-lighthouse-skill) 形成互补，共同覆盖中国主流云服务商。
