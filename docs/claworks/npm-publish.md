# @claworks/runtime npm 发布就绪

**状态**：dry-run 与 preflight 已就绪；公开发布需组织审批 + npm org。

---

## 发布前检查

```bash
pnpm claworks:release:preflight
pnpm claworks:npm-publish-checklist          # 只读清单
pnpm claworks:npm-publish-checklist --verify  # 含 dry-run
pnpm claworks:runtime:publish:dry-run
pnpm claworks:publish:dry-run   # 根包 claworks CLI（可选）
```

`release:preflight` 串联：runtime 测试、smoke、OT dry-run、docker compose config、npm pack dry-run、git clean。

---

## 包结构

| 项               | 说明                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| 包名             | `@claworks/runtime`                                                                         |
| 版本             | `packages/claworks-runtime/package.json`                                                    |
| 入口             | `dist/index.mjs` + `dist/index.d.mts`                                                       |
| 子路径           | `./kernel`, `./pack-loader`, `./claworks`, `./planes/data`, `./planes/orch`, `./interfaces` |
| `files`          | `dist/`, `README.md`                                                                        |
| `prepublishOnly` | 自动 `pnpm run build`（tsdown）                                                             |

仓内开发使用 `exports` 指向 `src/`；`publishConfig.exports` 指向 `dist/`（npm tarball 仅含编译产物）。

---

## Dry-run 验证

```bash
pnpm claworks:runtime:build
cd packages/claworks-runtime && npm pack --dry-run
```

确认 tarball **不含** `src/`、`.env`、测试文件；**含** 全部 `dist/**/*.mjs` 与 `.d.mts`。

---

## 发布命令（维护者）

```bash
# 私有 registry 示例
npm publish --registry=https://registry.example.com --access restricted

# 公开 npm（需审批）
npm publish --access public --tag beta
```

根 CLI 包 `claworks` 发布流程见 `docs/design/REBRAND-TO-CLAWORKS.md`。

---

## 阻塞项

- npm org `@claworks` 所有权与 CI publish token
- 商业许可证与 `LICENSE-COMMERCIAL.md` 签收
- 首次 beta 需更新 `CHANGELOG.md` / release notes
