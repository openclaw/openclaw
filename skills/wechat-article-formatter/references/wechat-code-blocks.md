# 微信公众号代码块格式完全指南

## 问题背景

微信公众号的 HTML 编辑器对代码块有非常严格的限制，不支持标准的 `<pre><code>` 标签格式。

## 唯一可行的格式

经过大量测试，微信公众号**唯一支持**的代码块格式是：

```html
<section
  style="background-color: #282c34; border-radius: 4px; border: 1px solid #1e2229; padding: 15px; margin: 15px 0; overflow-x: auto;"
>
  <div
    style="margin: 0; color: #dcdfe4; font-size: 13px; line-height: 1.6; font-family: 'Consolas', 'Monaco', monospace;"
  >
    <span style="color: #c678dd;">import</span>&nbsp;asyncio<br />
    <br />
    <span style="color: #c678dd;">async</span>&nbsp;<span style="color: #c678dd;">def</span
    >&nbsp;<span style="color: #61dafb;">main</span>():<br />
    &nbsp;&nbsp;&nbsp;&nbsp;print(<span style="color: #98c379;">"Hello"</span>)
  </div>
</section>
```

## 关键要点

### ✅ 必须使用的元素

1. **容器**：`<div>` (不是 `<pre>`)
2. **空格**：`&nbsp;` (命名 HTML 实体)
3. **换行**：`<br>` (显式换行标签)
4. **语法高亮**：`<span style="color: ...">` 标签
5. **横向滚动**：在外层 `<section>` 添加 `overflow-x: auto`

### ❌ 不能使用的元素

1. ❌ `<pre>` 标签 - 微信会删除其内容的所有空格
2. ❌ `<code>` 标签 - 同样会导致空格丢失
3. ❌ `white-space: pre` CSS - 微信会忽略
4. ❌ `white-space: pre-wrap` CSS - 微信会忽略
5. ❌ 真实空格字符 - 微信会删除标签之间的空格
6. ❌ Unicode 不间断空格 `\u00A0` - 微信也会删除
7. ❌ 数字 HTML 实体 `&#160;` - 微信会删除

## 为什么必须这样做

微信的 HTML 处理器会：

1. **删除所有标签之间的空白字符**（包括空格、制表符、换行）
2. **忽略 `white-space` CSS 属性**
3. **只保留 HTML 实体 `&nbsp;` 作为空格**
4. **只保留 `<br>` 作为换行**

## 转换方法

使用提供的转换脚本：

```bash
python scripts/convert-code-blocks.py input.html output.html
```

该脚本会：

1. 找到所有 `<pre><code>...</code></pre>` 块
2. 将空格替换为 `&nbsp;`
3. 将换行替换为 `<br>`
4. 将 `<pre><code>` 替换为 `<div>`
5. 保留所有语法高亮的 `<span>` 标签

## 示例对比

### ❌ 错误格式（会导致空格丢失）

```html
<pre style="white-space: pre"><code>
<span style="color: #c678dd;">import</span> asyncio

<span style="color: #c678dd;">async</span> <span style="color: #c678dd;">def</span> <span style="color: #61dafb;">main</span>():
    print("Hello")
</code></pre>
```

**结果**：`importasyncioasyncdefmain():print("Hello")` - 所有空格消失

### ✅ 正确格式

```html
<div>
  <span style="color: #c678dd;">import</span>&nbsp;asyncio<br />
  <br />
  <span style="color: #c678dd;">async</span>&nbsp;<span style="color: #c678dd;">def</span
  >&nbsp;<span style="color: #61dafb;">main</span>():<br />
  &nbsp;&nbsp;&nbsp;&nbsp;print(<span style="color: #98c379;">"Hello"</span>)
</div>
```

**结果**：正确显示所有空格、换行和缩进

## 横向滚动

为了支持长代码行的横向滚动，在外层容器添加：

```html
<section style="overflow-x: auto; ...">
  <div>...</div>
</section>
```

这样当代码行超过屏幕宽度时，可以左右滑动查看。

## 注意事项

1. **每次生成 HTML 后必须运行转换脚本**
2. **模板文件必须使用正确格式**（已更新）
3. **不要依赖 CSS 来保留空格** - 只有 HTML 结构有效
4. **测试时注意区分微信编辑器和最终渲染**
   - 编辑器中可能显示正常
   - 发布后查看手机端才是真实效果

## 总结

微信公众号的代码块必须使用：

- **结构**：`<div>` + `<br>` + `&nbsp;`
- **样式**：内联样式在 `<div>` 和 `<span>` 上
- **滚动**：`overflow-x: auto` 在外层容器

这是目前唯一可靠的方法。
