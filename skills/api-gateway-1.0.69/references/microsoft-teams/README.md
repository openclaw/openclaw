# Microsoft Teams Routing Reference

**App name:** `microsoft-teams`
**Base URL proxied:** `graph.microsoft.com`

## API Path Pattern

```
/microsoft-teams/v1.0/{resource}
```

## Common Endpoints

### Teams

#### List Joined Teams

```bash
GET /microsoft-teams/v1.0/me/joinedTeams
```

#### Get Team

```bash
GET /microsoft-teams/v1.0/teams/{team-id}
```

### Channels

#### List Channels

```bash
GET /microsoft-teams/v1.0/teams/{team-id}/channels
```

#### List Private Channels

```bash
GET /microsoft-teams/v1.0/teams/{team-id}/channels?$filter=membershipType eq 'private'
```

#### Get Channel

```bash
GET /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}
```

#### Create Channel

```bash
POST /microsoft-teams/v1.0/teams/{team-id}/channels
Content-Type: application/json

{
  "displayName": "Channel Name",
  "description": "Description",
  "membershipType": "standard"
}
```

#### Update Channel

```bash
PATCH /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}
Content-Type: application/json

{
  "description": "Updated description"
}
```

#### Delete Channel

```bash
DELETE /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}
```

### Channel Members

#### List Channel Members

```bash
GET /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}/members
```

### Messages

#### List Channel Messages

```bash
GET /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}/messages
```

#### Send Message

```bash
POST /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}/messages
Content-Type: application/json

{
  "body": {
    "content": "Hello World"
  }
}
```

#### Send HTML Message

```bash
POST /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}/messages
Content-Type: application/json

{
  "body": {
    "contentType": "html",
    "content": "<p>Formatted message</p>"
  }
}
```

#### Reply to Message

```bash
POST /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}/messages/{message-id}/replies
Content-Type: application/json

{
  "body": {
    "content": "Reply content"
  }
}
```

#### List Message Replies

```bash
GET /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}/messages/{message-id}/replies
```

#### Edit Message

```bash
PATCH /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}/messages/{message-id}
Content-Type: application/json

{
  "body": {
    "content": "Updated message content"
  }
}
```

### Team Members

#### List Members

```bash
GET /microsoft-teams/v1.0/teams/{team-id}/members
```

### Presence

#### Get User Presence

```bash
GET /microsoft-teams/v1.0/me/presence
```

#### Get User Presence by ID

```bash
GET /microsoft-teams/v1.0/users/{user-id}/presence
```

### Tabs

#### List Channel Tabs

```bash
GET /microsoft-teams/v1.0/teams/{team-id}/channels/{channel-id}/tabs
```

### Apps

#### List Installed Apps

```bash
GET /microsoft-teams/v1.0/teams/{team-id}/installedApps
```

### Online Meetings

#### Create Meeting

```bash
POST /microsoft-teams/v1.0/me/onlineMeetings
Content-Type: application/json

{
  "subject": "Team Sync",
  "startDateTime": "2026-02-18T10:00:00Z",
  "endDateTime": "2026-02-18T11:00:00Z"
}
```

#### Create Meeting with Attendees

```bash
POST /microsoft-teams/v1.0/me/onlineMeetings
Content-Type: application/json

{
  "subject": "Project Review",
  "startDateTime": "2026-02-18T14:00:00Z",
  "endDateTime": "2026-02-18T15:00:00Z",
  "participants": {
    "attendees": [
      {
        "upn": "attendee@example.com",
        "role": "attendee"
      }
    ]
  }
}
```

#### Get Meeting

```bash
GET /microsoft-teams/v1.0/me/onlineMeetings/{meeting-id}
```

#### Find Meeting by Join URL

```bash
GET /microsoft-teams/v1.0/me/onlineMeetings?$filter=JoinWebUrl eq '{encoded-join-url}'
```

#### Delete Meeting

```bash
DELETE /microsoft-teams/v1.0/me/onlineMeetings/{meeting-id}
```

#### List Calendar Events

```bash
GET /microsoft-teams/v1.0/me/calendar/events?$top=10
```

#### List Meeting Recordings

```bash
GET /microsoft-teams/v1.0/me/onlineMeetings/{meeting-id}/recordings
```

#### Get Meeting Recording

```bash
GET /microsoft-teams/v1.0/me/onlineMeetings/{meeting-id}/recordings/{recording-id}
```

#### List Meeting Transcripts

```bash
GET /microsoft-teams/v1.0/me/onlineMeetings/{meeting-id}/transcripts
```

#### Get Meeting Transcript

```bash
GET /microsoft-teams/v1.0/me/onlineMeetings/{meeting-id}/transcripts/{transcript-id}
```

#### List Attendance Reports

```bash
GET /microsoft-teams/v1.0/me/onlineMeetings/{meeting-id}/attendanceReports
```

#### Get Attendance Report

```bash
GET /microsoft-teams/v1.0/me/onlineMeetings/{meeting-id}/attendanceReports/{report-id}
```

### Chats

#### List Chats

```bash
GET /microsoft-teams/v1.0/me/chats
```

#### Get Chat

```bash
GET /microsoft-teams/v1.0/chats/{chat-id}
```

#### List Chat Messages

```bash
GET /microsoft-teams/v1.0/chats/{chat-id}/messages
```

#### Send Chat Message

```bash
POST /microsoft-teams/v1.0/chats/{chat-id}/messages
Content-Type: application/json

{
  "body": {
    "content": "Hello"
  }
}
```

## OData Query Parameters

- `$top=10` - Limit results
- `$skip=20` - Skip results
- `$select=id,displayName` - Select specific fields
- `$filter=membershipType eq 'private'` - Filter results
- `$orderby=displayName` - Sort results

## Notes

- Uses Microsoft Graph API (`graph.microsoft.com`)
- Channel IDs include thread suffix: `19:xxx@thread.tacv2`
- Message body content types: `text` or `html`
- Channel membership types: `standard`, `private`, `shared`
- Supports OData query parameters for filtering and pagination
- Meeting recordings/transcripts available after meeting ends

## Resources

- [Microsoft Teams API Overview](https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview)
- [Microsoft Graph API Reference](https://learn.microsoft.com/en-us/graph/api/overview)
- [Channel Resource](https://learn.microsoft.com/en-us/graph/api/resources/channel)
- [ChatMessage Resource](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage)
