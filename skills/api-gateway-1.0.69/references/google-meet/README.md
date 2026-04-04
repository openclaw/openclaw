# Google Meet Routing Reference

**App name:** `google-meet`
**Base URL proxied:** `meet.googleapis.com`

## API Path Pattern

```
/google-meet/v2/{resource}
```

## Common Endpoints

### Create Space

```bash
POST /google-meet/v2/spaces
Content-Type: application/json

{}
```

Response:

```json
{
  "name": "spaces/abc123",
  "meetingUri": "https://meet.google.com/abc-defg-hij",
  "meetingCode": "abc-defg-hij",
  "config": {
    "accessType": "OPEN",
    "entryPointAccess": "ALL"
  }
}
```

### Get Space

```bash
GET /google-meet/v2/spaces/{spaceId}
```

### Update Space

```bash
PATCH /google-meet/v2/spaces/{spaceId}
Content-Type: application/json

{
  "config": {
    "accessType": "TRUSTED"
  }
}
```

### End Active Call

```bash
POST /google-meet/v2/spaces/{spaceId}:endActiveConference
```

### List Conference Records

```bash
GET /google-meet/v2/conferenceRecords
```

With filter:

```bash
GET /google-meet/v2/conferenceRecords?filter=space.name="spaces/abc123"
```

### Get Conference Record

```bash
GET /google-meet/v2/conferenceRecords/{conferenceRecordId}
```

### List Participants

```bash
GET /google-meet/v2/conferenceRecords/{conferenceRecordId}/participants
```

### Get Participant

```bash
GET /google-meet/v2/conferenceRecords/{conferenceRecordId}/participants/{participantId}
```

### List Recordings

```bash
GET /google-meet/v2/conferenceRecords/{conferenceRecordId}/recordings
```

### Get Recording

```bash
GET /google-meet/v2/conferenceRecords/{conferenceRecordId}/recordings/{recordingId}
```

### List Transcripts

```bash
GET /google-meet/v2/conferenceRecords/{conferenceRecordId}/transcripts
```

### Get Transcript

```bash
GET /google-meet/v2/conferenceRecords/{conferenceRecordId}/transcripts/{transcriptId}
```

### List Transcript Entries

```bash
GET /google-meet/v2/conferenceRecords/{conferenceRecordId}/transcripts/{transcriptId}/entries
```

## Notes

- Spaces are persistent meeting rooms that can be reused
- Conference records are created when a meeting starts and track meeting history
- Access types: `OPEN` (anyone with link), `TRUSTED` (organization members only), `RESTRICTED` (invited only)
- Recordings and transcripts require Google Workspace with recording enabled

## Resources

- [Google Meet API Overview](https://developers.google.com/meet/api/reference/rest)
- [Spaces](https://developers.google.com/meet/api/reference/rest/v2/spaces)
- [Conference Records](https://developers.google.com/meet/api/reference/rest/v2/conferenceRecords)
- [Participants](https://developers.google.com/meet/api/reference/rest/v2/conferenceRecords.participants)
- [Recordings](https://developers.google.com/meet/api/reference/rest/v2/conferenceRecords.recordings)
- [Transcripts](https://developers.google.com/meet/api/reference/rest/v2/conferenceRecords.transcripts)
