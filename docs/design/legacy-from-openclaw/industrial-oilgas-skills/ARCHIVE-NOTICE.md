# 归档说明 — ClawTwin Python 时代设计包

> **状态**：只读归档 · 2026-05-22  
> **勿用于**：新功能实现、API 路径、目录布局、CI 命令

## 为什么归档

- 代码真源已从 `clawtwin-platform/platform-api/`（Python）迁移到 **`claworks/packages/claworks-runtime/`**（TypeScript）。
- `clawtwin-studio`、`clawtwin-platform` 已移入 `~/Projects/archive/ecosystem-legacy-20260522/`。

## 仍可读（概念/远景）

| 文档                                   | 价值                                           |
| -------------------------------------- | ---------------------------------------------- |
| `CLAWTWIN-DEFINITIVE-REFERENCE.md`     | 产品定位、Palantir 映射                        |
| `CLAWTWIN-ARCHITECTURE-OVERVIEW.md`    | 对外架构叙事                                   |
| `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`   | Ontology / ObjectType 思想（YAML pack 仍适用） |
| `CLAWTWIN-RELIABILITY-ARCHITECTURE.md` | Doctor/Outbox/Health 模式（已实现于 runtime）  |
| `CLAWTWIN-OPERATOR-GUIDE.md`           | 飞书 HITL 操作说明                             |

## 已 superseded（优先读新文档）

| 旧文档                              | 新真源                                             |
| ----------------------------------- | -------------------------------------------------- |
| `CLAWTWIN-ARCHITECTURE-V2/V3/V4.md` | `docs/design/ARCHITECTURE.md`                      |
| `DESIGN-FINAL-LOCK.md` HTTP 表      | `docs/design/API-SPEC.md`                          |
| `DEV-QUICKSTART.md`                 | `pnpm claworks:smoke` + `IMPLEMENTATION-STATUS.md` |
| `MODULE-DESIGN-PLATFORM.md`         | `packages/claworks-runtime/` 源码                  |
| `archive/*`（84 份）                | 历史决策记录，不引用                               |

## 版本文档处理

- **V2、V3**：中间迭代稿，已移入 `./archive/superseded-versions/`。
- **V4**：含大量 Studio/Python CLI 规划（§43–50），仅 §1–42 部分叙事仍有参考价值。
- **DESIGN-FINAL-MASTER-INDEX.md**：历史导航，入口改为 `docs/design/README.md`。
