# 文档指南

本目录负责文档编写、Mintlify 链接规则和文档国际化政策。

## Mintlify 规则

- 文档托管在 Mintlify 上 (`https://docs.openclaw.ai`)。
- `docs/**/*.md` 中的内部文档链接必须保持根相对路径，不带 `.md` 或 `.mdx` 后缀（例如：`[配置](/configuration)`）。
- 章节交叉引用应在根相对路径上使用锚点（例如：`[钩子](/configuration#hooks)`）。
- 文档标题应避免使用破折号和撇号，因为 Mintlify 的锚点生成在这些地方很脆弱。
- README 和其他 GitHub 渲染的文档应保持绝对文档 URL，以便链接在 Mintlify 外部也能正常工作。
- 文档内容必须保持通用：不使用个人设备名称、主机名或本地路径；使用占位符，如 `user@gateway-host`。

## 文档内容规则

- 对于文档、UI 文案和选择器列表，除非该部分明确描述运行时顺序或自动检测顺序，否则服务/提供商应按字母顺序排序。
- 保持捆绑插件的命名与根目录 `AGENTS.md` 中的仓库范围插件术语规则一致。

## 文档国际化

- 外语文档不在此仓库中维护。生成的发布输出位于单独的 `openclaw/docs` 仓库中（通常本地克隆为 `../openclaw-docs`）。
- 不要在此处添加或编辑 `docs/<locale>/**` 下的本地化文档。
- 将此仓库中的英文文档和词汇表文件视为真实来源。
- 流程：在此处更新英文文档，根据需要更新 `docs/.i18n/glossary.<locale>.json`，然后让发布仓库同步并在 `openclaw/docs` 中运行 `scripts/docs-i18n`。
- 在重新运行 `scripts/docs-i18n` 之前，为任何必须保持英文或使用固定翻译的新技术术语、页面标题或简短导航标签添加词汇表条目。
- `pnpm docs:check-i18n-glossary` 是更改英文文档标题和简短内部文档标签的保护措施。
- 翻译记忆库位于发布仓库中生成的 `docs/.i18n/*.tm.jsonl` 文件中。
- 请参阅 `docs/.i18n/README.md`。