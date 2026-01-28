---
read_when:
  - 你需要在不提升全局日志级别的情况下获取定向调试日志
  - 你需要为技术支持捕获特定子系统的日志
summary: 用于定向调试日志的诊断标志
title: 诊断标志
x-i18n:
  generated_at: "2026-02-01T20:24:56Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: daf0eca0e6bd1cbc2c400b2e94e1698709a96b9cdba1a8cf00bd580a61829124
  source_path: diagnostics/flags.md
  workflow: 14
---

# 诊断标志

诊断标志允许你在不开启全局详细日志的情况下启用定向调试日志。标志为可选启用，除非相关子系统检查了它们，否则不会产生任何效果。

## 工作原理

- 标志为字符串（不区分大小写）。
- 你可以在配置中或通过环境变量覆盖来启用标志。
- 支持通配符：
  - `telegram.*` 匹配 `telegram.http`
  - `*` 启用所有标志

## 通过配置启用

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

多个标志：

```json
{
  "diagnostics": {
    "flags": ["telegram.http", "gateway.*"]
  }
}
```

更改标志后需重启 Gateway网关。

## 环境变量覆盖（一次性）

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

禁用所有标志：

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 日志输出位置

标志会将日志输出到标准诊断日志文件中。默认路径为：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

如果你设置了 `logging.file`，则使用该路径。日志格式为 JSONL（每行一个 JSON 对象）。脱敏处理仍根据 `logging.redactSensitive` 设置生效。

## 提取日志

选择最新的日志文件：

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

筛选 Telegram HTTP 诊断信息：

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

或在复现问题时实时追踪：

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

对于远程 Gateway网关，你也可以使用 `openclaw logs --follow`（参见 [/cli/logs](/cli/logs)）。

## 注意事项

- 如果 `logging.level` 设置为高于 `warn` 的级别，这些日志可能会被抑制。默认的 `info` 级别即可。
- 标志可以安全地保持启用状态；它们只会影响特定子系统的日志量。
- 使用 [/logging](/logging) 更改日志输出目标、级别和脱敏设置。
