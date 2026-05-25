# GitHub Branch Protection — ClaWorks Required Checks

维护者在 `main` / release 分支启用以下 **required status checks**，使 PR merge 前自动验收。

---

## 推荐 Required Checks

| Check 名称                                      | Workflow                             | 触发                                 |
| ----------------------------------------------- | ------------------------------------ | ------------------------------------ |
| `smoke / smoke`                                 | `claworks-smoke.yml`                 | PR（runtime / robot / scripts 路径） |
| `weak_model_regression / weak_model_regression` | `claworks-weak-model-regression.yml` | PR + nightly                         |
| `evolution_chain_smoke / evolution_chain_smoke` | `claworks-evolution-smoke.yml`       | PR（进化相关路径）+ 每周日           |

> 实际 job 名以 GitHub Actions UI 为准；首次 merge 后在 **Settings → Branches → Branch protection rules → Require status checks** 中勾选。

---

## 配置步骤

1. 打开仓库 **Settings → Branches**
2. **Add branch protection rule**（或编辑 `main`）
3. 勾选 **Require status checks to pass before merging**
4. 勾选 **Require branches to be up to date before merging**（可选，推荐）
5. 搜索并添加：
   - `ClaWorks Smoke` / `smoke`
   - `ClaWorks Weak Model Regression` / `weak_model_regression`
   - `ClaWorks Evolution Smoke` / `evolution_chain_smoke`（进化相关 PR）
6. 保存

---

## 本地等价验证

```bash
pnpm claworks:release:preflight
# 含 evolution + gateway e2e：
CLAWORKS_PREFLIGHT_EVOLUTION=1 CLAWORKS_PREFLIGHT_GATEWAY=1 pnpm claworks:release:preflight
```

---

## 说明

- **弱模型回归** 使用 stub LLM，无需 API key；依赖 `claworks-packs` checkout。
- **Evolution smoke** 进程内验证，不启动 Gateway（除非单独跑 `gateway:e2e`）。
- OpenClaw 上游 CI 与 ClaWorks 产品 CI **独立**；fork 维护者只需启用 ClaWorks workflow 名称。
