# ClawForge OpenClaw - 多租户定制版

这是 OpenClaw 的 ClawForge 定制版本，支持企业级多租户、无状态运行和水平扩展。

## 🎯 核心特性

### 1. 多租户支持
- ✅ 组织级数据隔离（基于 `tenant_id`）
- ✅ 用户级工作目录隔离
- ✅ 动态上下文切换（无需重启实例）

### 2. 配置与运行时分离
- ✅ 环境变量注入（`ORG_ID`, `USER_ID`, `API_KEYS`）
- ✅ 工作目录动态挂载
- ✅ 支持热更新配置

### 3. 记忆系统改造
- ✅ Qdrant 向量数据库集成
- ✅ 多租户隔离（自动添加 `tenant_id` 过滤）
- ✅ 作用域分层（company/department/personal）

### 4. 技能系统改造
- ✅ 组织级技能授权
- ✅ 运行时权限验证
- ✅ 试用期管理

### 5. 容器化支持
- ✅ Docker 镜像构建
- ✅ 无状态运行
- ✅ 健康检查
- ✅ 优雅关闭

### 6. 水平扩展
- ✅ 多实例部署
- ✅ 负载均衡支持
- ✅ 共享存储（Qdrant/PostgreSQL/NAS）

### 7. 主从架构（开发中）
- 🔄 Orchestrator-Worker 模式
- 🔄 任务智能拆分
- 🔄 并行执行

---

## 🚀 快速开始

### 环境要求

- Node.js 20+
- Docker & Docker Compose
- Qdrant（向量数据库）
- PostgreSQL（元数据存储，可选）

### 方式一：Docker Compose（推荐）

```bash
# 1. 克隆仓库
git clone https://github.com/ClawForge/openclaw.git
cd openclaw

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 文件，填入 API 密钥等配置

# 3. 启动服务
docker compose -f docker-compose.clawforge.yml up -d

# 4. 查看日志
docker compose -f docker-compose.clawforge.yml logs -f
```

### 方式二：直接运行

```bash
# 1. 安装依赖
pnpm install

# 2. 设置环境变量
export ORG_ID=org_alpha
export USER_ID=user_001
export WORKSPACE=/storage/org_alpha/user_001
export QDRANT_HOST=localhost
export EMBEDDING_API_KEY=your-key
export LLM_API_KEY=your-key

# 3. 启动
pnpm run start
```

---

## 📁 目录结构

```
openclaw/
├── src/
│   ├── config/
│   │   ├── clawforge-types.ts      # 多租户配置类型
│   │   └── clawforge-config.ts     # 配置加载器
│   ├── memory/
│   │   └── qdrant-backend.ts       # Qdrant 记忆后端
│   └── skills/
│       └── permission-verifier.ts  # 技能权限验证
├── Dockerfile.clawforge            # Docker 镜像
├── docker-compose.clawforge.yml    # Docker Compose 配置
├── CLAWFORGE_CHANGES.md            # 改造记录
└── README.clawforge.md             # 本文档
```

---

## 🔧 配置说明

### 环境变量

#### 必需变量（多租户模式）

| 变量 | 描述 | 示例 |
|------|------|------|
| `ORG_ID` | 组织 ID | `org_alpha` |
| `USER_ID` | 用户 ID | `user_001` |
| `WORKSPACE` | 工作目录路径 | `/storage/org_alpha/user_001` |

#### API 密钥

| 变量 | 描述 | 必需 |
|------|------|------|
| `EMBEDDING_API_KEY` | Embedding 模型 API 密钥 | ✅ |
| `LLM_API_KEY` | LLM API 密钥 | ✅ |
| `RERANK_API_KEY` | Reranker API 密钥 | ❌ |
| `QDRANT_API_KEY` | Qdrant API 密钥 | ❌ |

#### Qdrant 配置

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `QDRANT_HOST` | Qdrant 主机地址 | `localhost` |
| `QDRANT_PORT` | Qdrant 端口 | `6333` |

#### 运行模式

| 变量 | 描述 | 选项 | 默认 |
|------|------|------|------|
| `OPENCLAW_MODE` | 运行模式 | `standalone`/`orchestrator`/`worker` | `standalone` |

---

## 📊 架构设计

### 多租户隔离

```
┌─────────────────────────────────────────────────────────┐
│                    ClawForge 平台                        │
└─────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ↓               ↓               ↓
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │  组织 A       │ │  组织 B       │ │  组织 C       │
    │  user_001    │ │  user_003    │ │  user_005    │
    │  user_002    │ │  user_004    │ │              │
    └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
           │                │                │
           └────────────────┼────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ↓               ↓               ↓
    ┌───────────────────────────────────────────────────┐
    │              Qdrant（向量数据库）                  │
    │  tenant_id: org_alpha  │  tenant_id: org_beta    │
    │  [记忆数据隔离存储]     │  [记忆数据隔离存储]      │
    └───────────────────────────────────────────────────┘
```

### 数据隔离

所有数据访问自动添加租户过滤：

```typescript
// 记忆检索示例
qdrant.search({
  vector: embedding,
  filter: {
    must: [
      { key: "tenant_id", match: { value: orgId } }  // 自动添加
    ]
  }
})
```

---

## 🧪 测试

### 功能测试

```bash
# 1. 创建测试组织
docker compose -f docker-compose.clawforge.yml up -d

# 2. 验证数据隔离
# - 组织 A 用户无法访问组织 B 数据
# - 记忆检索只返回当前组织数据

# 3. 验证技能权限
# - 未授权技能无法使用
# - 试用期到期自动回收
```

### 性能测试

```bash
# 100 并发用户测试
ab -n 1000 -c 100 http://localhost:80/health

# 记忆检索延迟测试
# 目标：< 500ms
```

---

## 🔒 安全

### 路径安全

- 工作目录路径验证（防止 `..` 越权）
- 组织/用户 ID 白名单验证
- 路径注入防护

### 数据隔离

- 所有数据库查询自动添加 `tenant_id` 过滤
- 文件操作限制在工作目录内
- 跨租户访问拒绝

### API 安全

- JWT Token 认证
- API Key 管理
- 请求频率限制

---

## 📝 改造记录

详细改造记录见：[CLAWFORGE_CHANGES.md](./CLAWFORGE_CHANGES.md)

### 已完成

- ✅ 配置系统改造（环境变量注入）
- ✅ Qdrant 记忆后端（多租户支持）
- ✅ 技能权限验证模块
- ✅ Docker 容器化配置

### 进行中

- 🔄 主从架构实现
- 🔄 任务拆分与分配
- 🔄 进度跟踪系统

### 计划中

- ⏳ 与上游 OpenClaw 集成
- ⏳ 完整测试覆盖
- ⏳ 性能优化

---

## 🤝 与上游 OpenClaw 的关系

```
OpenClaw (上游)
    ↓ fork + 改造
ClawForge OpenClaw (本仓库)
    ↓ 集成
ClawForge 平台
```

我们保持与上游 OpenClaw 的兼容性，定期合并上游修复和改进。

---

## 📚 相关文档

- [OpenClaw 核心改造需求](../docs/01-需求/03-OpenClaw 核心改造需求.md)
- [主从设计需求](../docs/01-需求/04-OpenClaw 主从设计需求.md)
- [产品需求](../docs/01-需求/01-产品需求.md)

---

## 📄 许可证

MIT License（与上游 OpenClaw 保持一致）

---

## 👥 团队

- **开发：** ClawForge AI 团队（7×24 小时 AI 驱动开发）
- **联系：** 飞哥

---

**最后更新：** 2026-03-08
