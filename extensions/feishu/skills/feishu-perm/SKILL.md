---
name: feishu-perm
description: |
  Feishu permission management for documents and files. Activate when user mentions sharing, permissions, collaborators, public links, or transfer owner, but only when `feishu_perm` is actually available in the tool list.
metadata: { "openclaw": { "requires": { "config": ["channels.feishu.tools.perm"] } } }
---

# Feishu Permission Tool

Single tool `feishu_perm` for managing file/document permissions, public sharing, and owner transfer.

Availability: this skill is opt-in. If `channels.feishu.tools.perm` is not enabled, OpenClaw does not register `feishu_perm`, and the model must treat permission-changing actions as unavailable even if this skill text is present elsewhere.

## Actions

### List Collaborators

```json
{ "action": "list", "token": "ABC123", "type": "docx" }
```

Returns: members with `member_type`, `member_id`, `perm`, and `name`.

### Add Collaborator

```json
{
  "action": "add",
  "token": "ABC123",
  "type": "docx",
  "member_type": "email",
  "member_id": "user@example.com",
  "perm": "edit"
}
```

### Remove Collaborator

```json
{
  "action": "remove",
  "token": "ABC123",
  "type": "docx",
  "member_type": "email",
  "member_id": "user@example.com"
}
```

### Transfer Owner

```json
{
  "action": "transfer_owner",
  "token": "ABC123",
  "type": "docx",
  "member_type": "openid",
  "member_id": "ou_xxx",
  "need_notification": false,
  "remove_old_owner": false
}
```

Use this when the app is the current document owner and needs to hand ownership to a user.

### Get Public Share Settings

```json
{ "action": "get_public", "token": "ABC123", "type": "docx" }
```

Returns the current `permission_public` object, including `external_access`, `share_entity`, and `link_share_entity`.

### Update Public Share Settings

```json
{
  "action": "update_public",
  "token": "ABC123",
  "type": "docx",
  "link_share_entity": "anyone_readable"
}
```

Prefer minimal updates. If you only need to make a document readable via public link, set only `link_share_entity`.

## Token Types

| Type       | Description                  |
| ---------- | ---------------------------- |
| `doc`      | Old format document          |
| `docx`     | New format document          |
| `sheet`    | Spreadsheet                  |
| `bitable`  | Multi-dimensional table      |
| `folder`   | Folder (member actions only) |
| `file`     | Uploaded file                |
| `wiki`     | Wiki node                    |
| `mindnote` | Mind map                     |
| `minutes`  | Minutes                      |
| `slides`   | Slides                       |

## Member Types

| Type               | Description        |
| ------------------ | ------------------ |
| `email`            | Email address      |
| `openid`           | User open_id       |
| `userid`           | User user_id       |
| `unionid`          | User union_id      |
| `openchat`         | Group chat open_id |
| `opendepartmentid` | Department open_id |
| `groupid`          | Group ID           |
| `wikispaceid`      | Wiki space ID      |

## Permission Levels

| Perm          | Description                          |
| ------------- | ------------------------------------ |
| `view`        | View only                            |
| `edit`        | Can edit                             |
| `full_access` | Full access (can manage permissions) |

## Public Share Fields

| Field               | Example Value     | Description                |
| ------------------- | ----------------- | -------------------------- |
| `external_access`   | `true`            | Allow external access      |
| `security_entity`   | `anyone_can_view` | Public access level        |
| `comment_entity`    | `anyone_can_view` | Public comment level       |
| `share_entity`      | `anyone`          | Who can share the document |
| `link_share_entity` | `anyone_readable` | Public link visibility     |
| `invite_external`   | `true`            | Allow external invite      |

## Examples

Share document with email:

```json
{
  "action": "add",
  "token": "doxcnXXX",
  "type": "docx",
  "member_type": "email",
  "member_id": "alice@company.com",
  "perm": "edit"
}
```

Transfer a document to a Feishu user:

```json
{
  "action": "transfer_owner",
  "token": "EYs4dtmJboA62qxsbXociL4on7f",
  "type": "docx",
  "member_type": "openid",
  "member_id": "ou_4f10daf0aa00d40205772bb28c6aab81"
}
```

Make a public link readable by anyone:

```json
{
  "action": "update_public",
  "token": "EYs4dtmJboA62qxsbXociL4on7f",
  "type": "docx",
  "link_share_entity": "anyone_readable"
}
```

## Configuration

```yaml
channels:
  feishu:
    tools:
      perm: true # default: false
```

`perm` is opt-in because it can change document permissions and public sharing. Set `channels.feishu.tools.perm: true` to enable it for a deployment.

## Permissions

Required: `drive:permission`
