# Message Composition with MML (MIME Meta Language)

> **Himalaya 2.x:** himalaya no longer parses MML itself. `message compose`, `message reply` and `message forward` emit RFC 5322 from flags, and MML handling belongs to a standalone composer such as `mml`, whose output pipes into `himalaya message send`. The syntax below describes that composer step, not a himalaya subcommand.

MML is a simple XML-based syntax that compiles to MIME messages.

## Basic Message Structure

An email message is a list of **headers** followed by a **body**, separated by a blank line:

```
From: sender@example.com
To: recipient@example.com
Subject: Hello World

This is the message body.
```

## Headers

Common headers:

- `From`: Sender address
- `To`: Primary recipient(s)
- `Cc`: Carbon copy recipients
- `Bcc`: Blind carbon copy recipients
- `Subject`: Message subject
- `Reply-To`: Address for replies (if different from From)
- `In-Reply-To`: Message ID being replied to

### Address Formats

```
To: user@example.com
To: John Doe <john@example.com>
To: "John Doe" <john@example.com>
To: user1@example.com, user2@example.com, "Jane" <jane@example.com>
```

## Plain Text Body

Simple plain text email:

```
From: alice@localhost
To: bob@localhost
Subject: Plain Text Example

Hello, this is a plain text email.
No special formatting needed.

Best,
Alice
```

## MML for Rich Emails

### Multipart Messages

Alternative text/html parts:

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

### Attachments

Attach a file:

```
From: alice@localhost
To: bob@localhost
Subject: With Attachment

Here is the document you requested.

<#part filename=/path/to/document.pdf><#/part>
```

Attachment with custom name:

```
<#part filename=/path/to/file.pdf name=report.pdf><#/part>
```

Multiple attachments:

```
<#part filename=/path/to/doc1.pdf><#/part>
<#part filename=/path/to/doc2.pdf><#/part>
```

### Inline Images

Embed an image inline:

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

### Mixed Content (Text + Attachments)

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

## MML Tag Reference

### `<#multipart>`

Groups multiple parts together.

- `type=alternative`: Different representations of same content
- `type=mixed`: Independent parts (text + attachments)
- `type=related`: Parts that reference each other (HTML + images)

### `<#part>`

Defines a message part.

- `type=<mime-type>`: Content type (e.g., `text/html`, `application/pdf`)
- `filename=<path>`: File to attach
- `name=<name>`: Display name for attachment
- `disposition=inline`: Display inline instead of as attachment
- `id=<cid>`: Content ID for referencing in HTML

## Composing from CLI

Himalaya 2.x composes from flags, not from an editor. `message compose`, `reply` and `forward`
write RFC 5322 bytes to stdout; add `--send` to send, `--save <mailbox>` to keep a copy, or both.
Multipart and MML bodies come from a standalone composer piped into `message send`.

### New message

```bash
himalaya message compose \
  --to recipient@example.com \
  --subject "Quick Message" \
  --body "Message body here" \
  --send
```

### Reply and forward

```bash
himalaya message reply 42 --body "Thanks, will look." --send
himalaya message reply 42 --to team@example.com --body "Adding the team." --send
himalaya message forward 42 --to recipient@example.com --body "See below." --send
```

2.2.1 has no `--all` flag: pass the extra recipients with `--to` or `--cc`. The source message is
fetched to fill `In-Reply-To`, `References` and the `Re:` subject, and its text body is quoted.

### Send a prepared message

```bash
cat message.eml | himalaya message send
himalaya message send --save sent /path/to/message.eml
```

## Tips

- `message compose`, `reply` and `forward` print the RFC 5322 message; `--send` sends it and `--save` stores a copy.
- Pipe a standalone MML composer into `himalaya message send` for multipart bodies; himalaya itself does not compile MML.
- MML parts are compiled to proper MIME by that composer.
- Use `himalaya message read <id> --raw` to inspect the raw MIME structure of received emails.
