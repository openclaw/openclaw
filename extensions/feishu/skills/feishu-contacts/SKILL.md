---
name: feishu-contacts
description: |
  Search Feishu contacts by name/email to get open_id. Activate when user mentions finding someone, looking up contacts, or needs to resolve a person's name to an ID before sending messages.
---

# Feishu Contacts Tool

Tool `feishu_contacts` searches the organization's contact list. Auto-syncs from Feishu API when local cache has no results.

## Actions

### Search Contacts

```json
{ "action": "search", "keyword": "张三" }
```

Fuzzy matches on: name, English name, email. Returns: `open_id`, `name`, `en_name`, `email`, `department_name`, `job_title`.

## Workflow: Send Message to a Person

When user says "给某某发消息" / "send message to someone":

1. **Search contact** → `feishu_contacts` with the person's name
2. **Get `open_id`** from results (if multiple matches, ask user to confirm)
3. **Send message** → `feishu_send` with the `open_id`

```json
// Step 1: Find the person
{ "action": "search", "keyword": "梅晓华" }
// → results: [{ "open_id": "ou_xxx", "name": "梅晓华", ... }]

// Step 2: Send the message
// Use feishu_send tool:
{ "action": "text", "receive_id": "ou_xxx", "receive_id_type": "open_id", "text": "你好" }
```

## Auto-Sync

If a search returns no results, the tool automatically:

1. Syncs all contacts from the Feishu API
2. Retries the search
3. Returns updated results

## Permissions

Required: `contact:user.base:readonly` — Read user basic info

If permission is missing, returns an error with a direct link to enable the scope.
