# OpenGen 使用说明

## 当前默认入口

OpenGen 的默认 Web 入口是 Next.js 控制台：

```bash
pnpm opengen:dev
```

默认访问地址：`http://127.0.0.1:3301`

你也可以使用脚本：

```bash
./scripts/start-web.sh
```

## 生成接口配置

`/api/generate` 依赖模型配置。请先设置环境变量（示例）：

```bash
export LLM_BASE_URL="https://your-openai-compatible-endpoint/v1"
export LLM_API_KEY="sk-your-api-key"
export LLM_MODEL="claude-sonnet-4-5-20250929"
```

## 常用命令

```bash
# 启动开发控制台
pnpm opengen:dev

# 构建控制台
pnpm opengen:build

# 运行控制台测试
pnpm opengen:test
```

## 健康检查与生成测试

```bash
curl -sS http://127.0.0.1:3301/api/health

curl -sS -X POST http://127.0.0.1:3301/api/generate \
  -H 'Content-Type: application/json' \
  --data '{"description":"todo app","type":"web"}'
```

## Legacy 说明

- `src/codegen/server.ts` 仍可作为 legacy API 调试入口。
- 默认路径已切换到 Next.js 控制台，不建议继续以 legacy 入口作为主流程。
