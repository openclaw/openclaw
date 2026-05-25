# Core 产品化钩子收敛计划

**状态**：草案（P2）  
**更新**：2026-05-25  
**目标**：减少 fork 内 scattered `productizeUserCopy` / `isClaworksProduct` 分支，收敛为少量可测试、可 upstream 合并的 seam。

---

## 1. 现状

ClaWorks 在 core `src/` 中通过 `CLAWORKS_PRODUCT=1` 与 `src/cli/product-surface.ts` 做白标：

| 机制                                    | 位置                              | 用途                              |
| --------------------------------------- | --------------------------------- | --------------------------------- |
| `productizeUserCopy()`                  | `src/cli/product-surface.ts`      | 字符串级 CLI 名 / 路径 / 端口替换 |
| `formatCliCommand()`                    | `src/cli/command-format.ts`       | 命令示例产品化                    |
| `isClaworksProduct()`                   | `src/config/paths.ts`             | 状态目录与配置文件名              |
| `isClaworksCliProduct()`                | `src/cli/cli-name.ts`             | CLI 二进制名与 banner             |
| `wizardT()` / `applyClaworksWizardCopy` | wizard i18n                       | 向导文案                          |
| `doctorFixHint()`                       | `src/flows/doctor-core-checks.ts` | health fixHint 产品化             |
| `register.*` intro hooks                | `src/cli/program/register.*.ts`   | 子命令 intro                      |

**问题**：新增用户可见文案需在多处手动包 `productizeUserCopy`；upstream 合并时冲突面大；extension doctor-contract 仍有裸 `openclaw` 字符串（见 `OPENCLAW-ALIGNMENT-AUDIT.md` §8.5）。

---

## 2. 收敛原则

1. **Core 保持 plugin-agnostic**：不在 `src/` 硬编码 ClaWorks 业务；产品事实经 env + 单一 surface 模块注入。
2. **显示层 vs 真源分离**：config schema / validation 源字符串可保留 `openclaw.json` 真源；用户可见输出统一过 surface。
3. **Additive seam**：优先扩展 `product-surface` 与 health-check metadata，避免新 scattered `if (isClaworks)`。
4. **Upstream 可合并**：seam 设计应允许 OpenClaw 主仓以 no-op 默认实现同样接口。

---

## 3. 分阶段计划

### Phase A — 清单与 lint（小 diff，1–2 天）

- [x] 生成「用户可见字符串」清单：`scripts/audit-product-copy.mjs` grep `openclaw` / `~/.openclaw` / `18789` in `src/cli`, `src/commands`, `src/flows`, bundled extension doctor-contract。
- [ ] 在 `pnpm check:changed` 增加 optional lane：`audit:product-copy`（仅 ClaWorks CI / local）。
- [x] 文档化豁免：`schema.help.ts` 静态源、内部 tui/progress 日志、CHANGELOG。

### Phase B — Health / Doctor 统一 metadata（中 diff，3–5 天）

- [ ] 扩展 `HealthFinding.fixHint` 为 `{ raw, productized? }` 或统一在 `formatHealthReport()` 层调用 `productizeUserCopy`，删除各 check 内联 `doctorFixHint`。
- [ ] `doctor-security` / `doctor-gateway-daemon-flow` 等大段 `productizeUserCopy([...])` 改为模板常量 + 单次 surface pass。
- [ ] Bundled extension doctor-contract：批量 `formatCliCommand` 包装 legacy 规则（ollama/vllm/plugin-sdk 等，见审计 §8.5 遗留项）。

### Phase C — Profile / paths 单一入口（小 diff，1 天）

- [ ] `applyCliProfileEnv` 与 `resolveStateDir` 共用 `resolveProductStateBasename()`（本轮已在 `profile.ts` 落地，需补文档与测试矩阵：`--dev` / `--profile` × OpenClaw/ClaWorks）。
- [ ] 导出 `resolveProductPaths()` barrel，供 onboard/setup/doctor 复用，删除重复 hint 字符串。

### Phase D — 可选 upstream 提案（大项，defer）

- [ ] 向 OpenClaw 提案 `ProductSurface` 注入点（env-driven display adapter），ClaWorks fork 仅提供 `claworks-product-surface` 实现。
- [ ] Gateway protocol：产品 health contributor 注册已存在；评估是否将 `runClaworksProductDoctorHealth` 完全移出 core 加载路径（仅 `claworks-robot` manifest hook）。

---

## 4. 不在本计划范围（明确 defer）

| 项                                              | 原因                             |
| ----------------------------------------------- | -------------------------------- |
| Core 大 refactor / 删除所有 `openclaw` 源字符串 | upstream 合并成本；显示层已覆盖  |
| Gateway e2e 进默认 CI workflow                  | 见 `RELEASE-CHECKLIST.md` §3 P2+ |
| npm 发布 / OTEL                                 | P2 产品化 backlog                |
| Studio 审批 UI                                  | 独立 Epic                        |

---

## 5. 验收

```bash
# Phase A 完成后
node scripts/audit-product-copy.mjs --strict

# 回归
pnpm test src/cli/product-surface.test.ts src/cli/profile.test.ts src/flows/doctor-core-checks.test.ts
CLAWORKS_PRODUCT=1 node claworks.mjs doctor --help
```

**权威交叉引用**：`OPENCLAW-ALIGNMENT-AUDIT.md` §8.5、`REBRAND-TO-CLAWORKS.md`、`RELEASE-CHECKLIST.md`。
