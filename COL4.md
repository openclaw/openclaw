<!-- COL4.md · AI-facing module summary · 由 `gen-col4.sh` 生成 -->
<!-- 手改无效：下次跑 gen-col4.sh 会覆盖。要持久化笔记请写到 wiki/methods/ 或 top/decisions/ -->

# COL 4 · Module Summary

_generated: 2026-05-06T14:33:24Z_  _project: `openclaw`_

## Stack
- TS/JS
- Python

## Top-level Modules (供 AI 一眼看全景，详细查 Serena `get_symbols_overview`)

```
./apps
./apps/android
./apps/ios
./apps/macos
./apps/macos-mlx-tts
./apps/shared
./apps/swabble
./config
./config/tsconfig
./deploy
./docs
./docs/assets
./docs/automation
./docs/channels
./docs/cli
./docs/concepts
./docs/debug
./docs/diagnostics
./docs/gateway
./docs/.generated
```

## 导航协议（AI 必读）

1. **要找符号定义** → Serena MCP `find_symbol "<name path>"`（不要读全文件）
2. **要找谁调用 X** → Serena MCP `find_referencing_symbols "X"`（codemap/grep 不可靠）
3. **要看模块概览** → Serena MCP `get_symbols_overview "<module>"`
4. **要全 repo 打包** → `npx repomix`（仅 handoff / 离线 review，不当默认）

## Dead-code Status

- 报告：[`.audit-rot/report.md`](.audit-rot/report.md)（生成时间 2026-05-06 22:33）
- **改文件前先看本报告**；若改的文件在报告里 → 顺手清理本文件 orphan 再做正事
- 报告过期？跑 `bash ~/.claude/skills/share-top/scripts/audit-rot.sh` 刷新

## 删除决策标准（防误杀）

任何 dead-code 候选删之前必须确认 **不在以下列表**：

- 动态 import / `__import__` / `importlib`
- 反射 / `getattr` / `setattr` / `hasattr`
- 插件注册（entry_points / 装饰器注册器）
- CLI 入口 / Click / Typer / argparse 命令
- pytest fixture / parametrize 间接引用
- conftest.py / hooks / `__all__`
- 配置 / YAML / JSON 里的 string-based class path
- Notebook 引用（`.ipynb`）
- 测试中的 mock target

存疑 → 保留 + 在 `top/decisions/` 加一行 ADR 解释为啥。

## 工具就近指针

- **L1 Serena MCP** — 已配 `~/.claude.json`，cc 启动自动加载
- **L2 audit-rot** — `bash ~/.claude/skills/share-top/scripts/audit-rot.sh`
- **L3 Repomix** — `npx --yes repomix --output /tmp/pack.md --compress`（按需）
- 完整文档 — `~/.claude/skills/share-top/references/code-tools.md`
