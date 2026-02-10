---
read_when:
  - 你需要定向调试日志而不提高全局日志级别
  - 你需要为支持人员捕获特定子系统的日志
summary: 用于定向调试日志的诊断标志
title: 诊断标志
x-i18n:
  generated_at: "2026-02-03T10:05:34Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: daf0eca0e6bd1cbc2c400b2e94e1698709a96b9cdba1a8cf00bd580a61829124
  source_path: diagnostics/flags.md
  workflow: 15
---

# 诊断标志

诊断标志让你可以启用定向调试日志，而无需在所有地方开启详细日志。标志是可选启用的，除非子系统检查它们，否则不会生效。

## 工作原理

- 标志是字符串（不区分大小写）。
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

更改标志后重启 Gateway 网关。

## 环境变量覆盖（一次性）

```bash
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

禁用所有标志：

```bash
OPENCLAW_DIAGNOSTICS=0
```

## 日志存储位置

标志将日志输出到标准诊断日志文件。默认位置：

```
/tmp/openclaw/openclaw-YYYY-MM-DD.log
```

如果你设置了 `logging.file`，则使用该路径。日志为 JSONL 格式（每行一个 JSON 对象）。脱敏仍然根据 `logging.redactSensitive` 应用。

## 提取日志

选择最新的日志文件：

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -n 1
```

过滤 Telegram HTTP 诊断：

```bash
rg "telegram http error" /tmp/openclaw/openclaw-*.log
```

或在复现时使用 tail：

```bash
tail -f /tmp/openclaw/openclaw-$(date +%F).log | rg "telegram http error"
```

对于远程 Gateway 网关，你也可以使用 `openclaw logs --follow`（参见 [/cli/logs](/cli/logs)）。

## 注意事项

- 如果 `logging.level` 设置为高于 `warn`，这些日志可能会被抑制。默认的 `info` 级别即可。
- 标志可以安全地保持启用状态；它们只影响特定子系统的日志量。
- 使用 [/logging](/logging) 更改日志目标、级别和脱敏设置。
