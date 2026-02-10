# Message Composition with MML (MIME Meta Language)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Himalaya uses MML for composing emails. MML is a simple XML-based syntax that compiles to MIME messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Basic Message Structure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
An email message is a list of **headers** followed by a **body**, separated by a blank line:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From: sender@example.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: recipient@example.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subject: Hello World（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the message body.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Headers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common headers:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `From`: Sender address（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `To`: Primary recipient(s)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Cc`: Carbon copy recipients（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Bcc`: Blind carbon copy recipients（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Subject`: Message subject（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Reply-To`: Address for replies (if different from From)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `In-Reply-To`: Message ID being replied to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Address Formats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: user@example.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: John Doe <john@example.com>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: "John Doe" <john@example.com>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: user1@example.com, user2@example.com, "Jane" <jane@example.com>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plain Text Body（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Simple plain text email:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From: alice@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: bob@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subject: Plain Text Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Hello, this is a plain text email.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No special formatting needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Best,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Alice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## MML for Rich Emails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multipart Messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Alternative text/html parts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From: alice@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: bob@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subject: Multipart Example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#multipart type=alternative>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the plain text version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part type=text/html>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<html><body><h1>This is the HTML version</h1></body></html>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#/multipart>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Attachments（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Attach a file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From: alice@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: bob@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subject: With Attachment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Here is the document you requested.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part filename=/path/to/document.pdf><#/part>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Attachment with custom name:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part filename=/path/to/file.pdf name=report.pdf><#/part>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multiple attachments:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part filename=/path/to/doc1.pdf><#/part>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part filename=/path/to/doc2.pdf><#/part>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Inline Images（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Embed an image inline:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From: alice@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: bob@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subject: Inline Image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#multipart type=related>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part type=text/html>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<html><body>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<p>Check out this image:</p>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<img src="cid:image1">（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
</body></html>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part disposition=inline id=image1 filename=/path/to/image.png><#/part>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#/multipart>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Mixed Content (Text + Attachments)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From: alice@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To: bob@localhost（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subject: Mixed Content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#multipart type=mixed>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part type=text/plain>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Please find the attached files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Best,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Alice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part filename=/path/to/file1.pdf><#/part>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#part filename=/path/to/file2.zip><#/part>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
<#/multipart>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## MML Tag Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `<#multipart>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Groups multiple parts together.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `type=alternative`: Different representations of same content（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `type=mixed`: Independent parts (text + attachments)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `type=related`: Parts that reference each other (HTML + images)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `<#part>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Defines a message part.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `type=<mime-type>`: Content type (e.g., `text/html`, `application/pdf`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `filename=<path>`: File to attach（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `name=<name>`: Display name for attachment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `disposition=inline`: Display inline instead of as attachment（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `id=<cid>`: Content ID for referencing in HTML（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Composing from CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Interactive compose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Opens your `$EDITOR`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
himalaya message write（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Reply (opens editor with quoted message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
himalaya message reply 42（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
himalaya message reply 42 --all  # reply-all（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Forward（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
himalaya message forward 42（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Send from stdin（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cat message.txt | himalaya template send（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Prefill headers from CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
himalaya message write \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "To:recipient@example.com" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H "Subject:Quick Message" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "Message body here"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tips（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The editor opens with a template; fill in headers and body.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Save and exit the editor to send; exit without saving to cancel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MML parts are compiled to proper MIME when sending.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `himalaya message export --full` to inspect the raw MIME structure of received emails.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
