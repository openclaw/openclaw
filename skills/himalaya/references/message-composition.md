# 使用 MML（ MIME 元语言）撰写消息

Himalaya 使用 MML 撰写电子邮件。MML 是一种简单的基于 XML 的语法，可编译为 MIME 消息。

## 基本消息结构

电子邮件消息是由空行分隔的** headers** 列表，后跟** body**：

```
From: sender@example.com
To: recipient@example.com
Subject: Hello World

This is the message body.
```

## Headers

常用 headers：

- `From`：发件人地址
- `To`：主要收件人
- `Cc`：抄送收件人
- `Bcc`：密送收件人
- `Subject`：邮件主题
- `Reply-To`：回复地址（如果与 From 不同）
- `In-Reply-To`：要回复的消息 ID

### 地址格式

```
To: user@example.com
To: John Doe <john@example.com>
To: "John Doe" <john@example.com>
To: user1@example.com, user2@example.com, "Jane" <jane@example.com>
```

## 纯文本 Body

简单纯文本电子邮件：

```
From: alice@localhost
To: bob@localhost
Subject: Plain Text Example

Hello, this is a plain text email.
No special formatting needed.

Best,
Alice
```

## MML 用于富电子邮件

### 多部分消息

替代 text/html 部分：

```
From: alice@localhost
To: bob@localhost
Subject: Multipart Example

<#multipart type=alternative>
This is the plain text version.
<#part type=text/html>
<html><body><h1>This is the HTML version</h1></body></html>
<#/multipart>
```

### 附件

附加文件：

```
From: alice@localhost
To: bob@localhost
Subject: With Attachment

Here is the document you requested.

<#part filename=/path/to/document.pdf><#/part>
```

带自定义名称的附件：

```
<#part filename=/path/to/file.pdf name=report.pdf><#/part>
```

多个附件：

```
<#part filename=/path/to/doc1.pdf><#/part>
<#part filename=/path/to/doc2.pdf><#/part>
```

### 内联图像

内联嵌入图像：

```
From: alice@localhost
To: bob@localhost
Subject: Inline Image

<#multipart type=related>
<#part type=text/html>
<html><body>
<p>Check out this image:</p>
<img src="cid:image1">
</body></html>
<#part disposition=inline id=image1 filename=/path/to/image.png><#/part>
<#/multipart>
```

### 混合内容（文本 + 附件）

```
From: alice@localhost
To: bob@localhost
Subject: Mixed Content

<#multipart type=mixed>
<#part type=text/plain>
Please find the attached files.

Best,
Alice
<#part filename=/path/to/file1.pdf><#/part>
<#part filename=/path/to/file2.zip><#/part>
<#/multipart>
```

## MML 标签参考

### `<#multipart>`

将多个部分分组在一起。

- `type=alternative`：相同内容的不同表示
- `type=mixed`：独立部分（文本 + 附件）
- `type=related`：相互引用的部分（HTML + 图像）

### `<#part>`

定义消息部分。

- `type=<mime-type>`：内容类型（例如 `text/html`、`application/pdf`）
- `filename=<path>`：要附加的文件
- `name=<name>`：附件的显示名称
- `disposition=inline`：内联显示而非作为附件
- `id=<cid>`：在 HTML 中引用的内容 ID

## 从 CLI 撰写

### 交互式撰写

打开您的 `$EDITOR`：

```bash
himalaya message write
```

### 回复（打开带引用消息的编辑器）

```bash
himalaya message reply 42
himalaya message reply 42 --all  # 回复所有人
```

### 转发

```bash
himalaya message forward 42
```

### 从 stdin 发送

```bash
cat message.txt | himalaya template send
```

### 从 CLI 预填充 headers

```bash
himalaya message write \
  -H "To:recipient@example.com" \
  -H "Subject:Quick Message" \
  "Message body here"
```

## 提示

- 编辑器使用模板打开；填写 headers 和 body。
- 保存并退出编辑器发送；退出不保存取消。
- 发送时 MML 部分被编译为正确的 MIME。
- 使用 `himalaya message export --full` 检查接收邮件的原始 MIME 结构。
