# AGENTS.md - zh-CN 文档翻译工作区

## Read When

- 维护 `docs/zh-CN/**`
- 更新中文翻译流水线（glossary/TM/prompt）
- 处理中文翻译反馈或回归

## Pipeline（docs-i18n）

- 源文档：`docs/**/*.md`
- 目标文档：`docs/zh-CN/**/*.md`
- 术语表：`docs/.i18n/glossary.zh-CN.json`
- 翻译记忆库：`docs/.i18n/zh-CN.tm.jsonl`
- 提示词规则：`scripts/docs-i18n/translator.go`

常用运行方式：

```bash
# 批量（doc 模式，可并行）
go run scripts/docs-i18n/main.go -mode doc -parallel 6 docs/**/*.md

# 单文件

go run scripts/docs-i18n/main.go -mode doc docs/channels/matrix.md

# 小范围补丁（segment 模式，使用 TM；不支持并行）
go run scripts/docs-i18n/main.go -mode segment docs/channels/matrix.md
```

注意事项：

- doc 模式用于整页翻译；segment 模式用于小范围修补（依赖 TM）。
- 超大文件若超时，优先做**定点替换**或拆分后再跑。
- 翻译后检查中文引号、CJK-Latin 间距和术语一致性。

## zh-CN 样式规则

- CJK-Latin 间距：遵循 W3C CLREQ（如 `Gateway 网关`、`Skills 配置`）。
- 中文引号：正文/标题使用 `“”`；代码/CLI/键名保持 ASCII 引号。
- 术语保留英文：`Skills`、`local loopback`、`Tailscale`。
- 代码块/内联代码：保持原样，不在代码内插入空格或引号替换。

## 关键术语（#6995 修复）

- `Gateway 网关`
- `Skills 配置`
- `沙箱`
- `预期键名`
- `配套应用`
- `分块流式传输`
- `设备发现`

## 反馈与变更记录

- 反馈来源：GitHub issue #6995
- 反馈用户：@AaronWander、@taiyi747、@Explorer1092、@rendaoyuan
- 变更要点：更新 prompt 规则、扩充 glossary、清理 TM、批量再生成 + 定点修复
- 参考链接：https://github.com/openclaw/openclaw/issues/6995
