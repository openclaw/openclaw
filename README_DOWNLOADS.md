# 论文下载说明 (Reference Download Guide)

由于 Google Scholar 和 ACM 等学术网站对自动化工具（如 OpenClaw）进行了严格的反爬虫限制（Cloudflare/CAPTCHA），直接批量自动化下载已部分受阻。

为了确保您能顺利获取剩余文献，我已经为您生成了一个包含所有文献直接搜索链接的 HTML 文件。

## ✅ 您的下一步操作

1. **打开生成的下载清单**:
   - 文件路径: `file:///Users/lizhihong/claw/full_download_list.html`
   - 或者在 Finder 中找到并双击打开: `/Users/lizhihong/claw/full_download_list.html`

2. **手动下载流程**:
   - 在 HTML 列表中，点击每篇论文右侧的 **"Search 🔍"** 按钮。
   - 这将直接在浏览器中打开 Google Scholar 搜索结果。
   - **英文文献**: 如果右侧有 `[PDF]` 链接，直接点击下载。
   - **中文文献 [1-36]**: 部分可以直接下载，部分可能需要通过学校图书馆入口访问 CNKI (知网)。
   - **被阻止的文献**: 如果遇到 Cloudflare 验证（"请确认您是真人"），请手动完成验证即可继续访问。

3. **保存文件**:
   - 将下载的 PDF 文件保存到 `~/claw/thesis_refs/` 目录下。

## 📊 当前进度

- **已下载**: 7篇关键英文文献 (位于 `~/claw/thesis_refs/`)
- **待下载**: 剩余约 88 篇 (包含中文文献 [1-36] 和英文文献 [38-95])

## ⚠️ 常见问题

- **ACM 阻止访问**: 部分 ACM 论文（如 Kunkel, Glikson）可能会拦截下载。
  - **解决方法**: 在搜索结果中点击 "所有版本 (All versions)"，通常能找到 ResearchGate 或作者主页的替代下载链接。
- **Sci-Hub**: 对于无法直接下载的英文文献，可以复制 DOI 号（如 `10.1145/...`）到 Sci-Hub 下载。

祝您论文写作顺利！
