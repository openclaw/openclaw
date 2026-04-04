# Trello Routing Reference

**App name:** `trello`
**Base URL proxied:** `api.trello.com`

## API Path Pattern

```
/trello/1/{resource}
```

## Common Endpoints

### Get Current Member

```bash
GET /trello/1/members/me
```

### Get Member's Boards

```bash
GET /trello/1/members/me/boards?filter=open
```

### Get Board

```bash
GET /trello/1/boards/{id}?lists=open&cards=open
```

### Create Board

```bash
POST /trello/1/boards
Content-Type: application/json

{
  "name": "Project Alpha",
  "desc": "Main project board",
  "defaultLists": false,
  "prefs_permissionLevel": "private"
}
```

### Get Board Lists

```bash
GET /trello/1/boards/{id}/lists?filter=open
```

### Get Board Cards

```bash
GET /trello/1/boards/{id}/cards
```

### Create List

```bash
POST /trello/1/lists
Content-Type: application/json

{
  "name": "To Do",
  "idBoard": "BOARD_ID",
  "pos": "top"
}
```

### Get Cards in List

```bash
GET /trello/1/lists/{id}/cards
```

### Get Card

```bash
GET /trello/1/cards/{id}?members=true&checklists=all
```

### Create Card

```bash
POST /trello/1/cards
Content-Type: application/json

{
  "name": "Implement feature X",
  "desc": "Description of the task",
  "idList": "LIST_ID",
  "pos": "bottom",
  "due": "2025-03-30T12:00:00.000Z",
  "idMembers": ["MEMBER_ID"],
  "idLabels": ["LABEL_ID"]
}
```

### Update Card

```bash
PUT /trello/1/cards/{id}
Content-Type: application/json

{
  "name": "Updated card name",
  "desc": "Updated description",
  "due": "2025-04-15T12:00:00.000Z"
}
```

### Move Card to List

```bash
PUT /trello/1/cards/{id}
Content-Type: application/json

{
  "idList": "NEW_LIST_ID",
  "pos": "top"
}
```

### Delete Card

```bash
DELETE /trello/1/cards/{id}
```

### Add Comment to Card

```bash
POST /trello/1/cards/{id}/actions/comments
Content-Type: application/json

{
  "text": "This is a comment"
}
```

### Create Checklist

```bash
POST /trello/1/checklists
Content-Type: application/json

{
  "idCard": "CARD_ID",
  "name": "Task Checklist"
}
```

### Create Checklist Item

```bash
POST /trello/1/checklists/{id}/checkItems
Content-Type: application/json

{
  "name": "Subtask 1",
  "pos": "bottom",
  "checked": false
}
```

### Get Board Labels

```bash
GET /trello/1/boards/{id}/labels
```

### Create Label

```bash
POST /trello/1/labels
Content-Type: application/json

{
  "name": "High Priority",
  "color": "red",
  "idBoard": "BOARD_ID"
}
```

### Search

```bash
GET /trello/1/search?query=keyword&modelTypes=cards,boards
```

## Notes

- IDs are 24-character alphanumeric strings
- Use `me` to reference the authenticated user
- Dates are in ISO 8601 format
- `pos` can be `top`, `bottom`, or a positive number
- Label colors: `yellow`, `purple`, `blue`, `red`, `green`, `orange`, `black`, `sky`, `pink`, `lime`, `null`
- Use `fields` parameter to limit returned data and improve performance
- Archived items can be retrieved with `filter=closed`

## Resources

- [Trello API Overview](https://developer.atlassian.com/cloud/trello/rest/api-group-actions/)
- [Boards](https://developer.atlassian.com/cloud/trello/rest/api-group-boards/)
- [Lists](https://developer.atlassian.com/cloud/trello/rest/api-group-lists/)
- [Cards](https://developer.atlassian.com/cloud/trello/rest/api-group-cards/)
- [Checklists](https://developer.atlassian.com/cloud/trello/rest/api-group-checklists/)
- [Labels](https://developer.atlassian.com/cloud/trello/rest/api-group-labels/)
- [Members](https://developer.atlassian.com/cloud/trello/rest/api-group-members/)
- [Search](https://developer.atlassian.com/cloud/trello/rest/api-group-search/)
