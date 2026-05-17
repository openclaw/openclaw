# Dead-Code Report
_generated: 2026-05-06T14:33:06Z_  _project: `/mnt/data/yongan/workbase/openclaw-audit/openclaw`_

> 候选清单 — **未经人工确认禁止删除**。动态 import / 反射 / 插件注册 / CLI 入口都会触发误报。

## TypeScript / JavaScript (knip)
- files with issues: **7511**
- unused exports: **4049** · types: **3287** · duplicates: **56**
- unused deps: **40** · devDeps: **131** · unlisted (imported but not declared): **1298**
- raw: `.audit-rot/.dead-code-raw/knip.json`

## Python (vulture + ruff F401/F841)
- vulture (functions/classes/vars, conf≥80): **0** 候选
- ruff (unused imports/vars, 精确): **0** 候选
- raw: `.audit-rot/.dead-code-raw/vulture.txt`, `.audit-rot/.dead-code-raw/ruff.json`

---
_工具可用性_: jq=1 npx=1 uvx=1 cargo=0
_命令记录_:

```
knip:    npx knip --reporter json
vulture: uvx vulture . --min-confidence 80
ruff:    uvx ruff check . --select F401,F841
```
