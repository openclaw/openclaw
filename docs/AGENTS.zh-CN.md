# 文档指南

本目录负责文档编写、Mintlify链接规则和文档国际化政策。

## Mintlify规则

- 文档托管在Mintlify（`https://docs.openclaw.ai`）。
- `docs/**/*.md`中的内部文档链接必须保持根相对路径，不带`.md`或`.mdx`后缀（例如：`[Config](/configuration)`）。
- 章节交叉引用应使用根相对路径上的锚点（例如：`[Hooks](/configuration#hooks)`）。
- 文档标题应避免使用长破折号和撇号，因为Mintlify锚点生成在这些地方比较脆弱。
- README和其他GitHub渲染的文档应保持绝对文档URL，以便链接在Mintlify之外也能工作。
- 文档内容必须保持通用：不要使用个人设备名称、主机名或本地路径；使用像`user@gateway-host`这样的占位符。

## 文档内容规则

- 对于文档、UI文案和选择器列表，服务/提供商按字母顺序排序，除非该章节明确描述运行时顺序或自动检测顺序。
- 保持捆绑插件命名与根目录`AGENTS.md`中整个仓库的插件术语规则一致。

## 文档国际化

- 外国语文档不在本仓库维护。生成的发布输出位于单独的`openclaw/docs`仓库（通常本地克隆为`../openclaw-docs`）。
- 不要在这里添加或编辑`docs/<locale>/**`下的本地化文档。
- 将本仓库中的英文文档加上词汇表文件视为真实来源。
- 工作流程：在这里更新英文文档，根据需要更新`docs/.i18n/glossary.<locale>.json`，然后让发布仓库同步并在`openclaw/docs`中运行`scripts/docs-i18n`。
- 在重新运行`scripts/docs-i18n`之前，为任何新的技术术语、页面标题或简短导航标签添加词汇表条目，这些必须保持英文或使用固定翻译。
- `pnpm docs:check-i18n-glossary`是更改后的英文文档标题和简短内部文档标签的防护措施。
- 翻译内存位于发布仓库中生成的`docs/.i18n/*.tm.jsonl`文件中。
- 参见`docs/.i18n/README.md`。
