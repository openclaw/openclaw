# Urbit HTTP API Reference

Quick reference for the Urbit HTTP API used by this skill.

## Authentication

```typescript
import { Urbit } from "@urbit/http-api";

const api = await Urbit.authenticate({
  ship: "sampel-palnet",  // without ~
  url: "https://myship.tlon.network",
  code: "lidlut-tabwed-...",
  verbose: false,
});
```

## Core Operations

### Scry (Read)
```typescript
const result = await api.scry<T>({ app: "app-name", path: "/path" });
```

### Poke (Write)
```typescript
await api.poke({ app: "app-name", mark: "mark-name", json: { ... } });
```

### Subscribe (Real-time)
```typescript
await api.subscribe({
  app: "app-name",
  path: "/path",
  event: (data) => { ... },
  quit: () => { ... },
});
```

## Contacts Agent

### Scry Paths
- `/all` - All peers with merged profile data (ContactRolodex)
- `/v1/book` - All contacts with user overrides (ContactBookScryResult)

### Poke Marks
- `contact-action` - Legacy profile edits
  - `{ edit: [{ nickname: "name" }, { bio: "..." }] }`
- `contact-action-1` - New contact operations
  - `{ meet: ["~ship1", "~ship2"] }` - Sync profiles
  - `{ page: { kip: "~ship", contact: {} } }` - Add contact
  - `{ wipe: ["~ship"] }` - Remove contact
  - `{ edit: { kip: "~ship", contact: { nickname: {...} } } }` - Edit contact

### Profile Fields
```typescript
interface ContactBookProfile {
  nickname?: { type: "text", value: string };
  bio?: { type: "text", value: string };
  status?: { type: "text", value: string };
  avatar?: { type: "look", value: string };  // URL
  cover?: { type: "look", value: string };   // URL
  color?: { type: "tint", value: string };   // Hex without #
}
```

## Chat Agent

### Scry Paths
- `/dm` - List of DM ship names (string[])
- `/clubs` - Group DMs (Clubs)
- `/blocked` - Blocked ships
- `/v3/dm/~ship/writs/newest/{count}/light` - DM message history (light = no replies)
- `/v3/dm/~ship/writs/newest/{count}/heavy` - DM message history (heavy = with replies)
- `/v3/club/{clubId}/writs/newest/{count}/light` - Group DM message history
- `/v2/dm/~ship/writs/writ/id/{author}/{postId}` - Single DM post with replies

### Poke Marks
- `chat-dm-action-1` - Send DM
- `chat-club-action-1` - Group DM operations
- `chat-remark-action` - Mark read

## Groups Agent

### Scry Paths
- `/groups/v2` - All subscribed groups
- `/groups/v2/~host/group-name` - Specific group

## Channels Agent

### Scry Paths
- `/v1/hooks/preview/{nest}` - Channel preview
- `/{nest}/search/...` - Search messages

### Poke Marks
- `channel-action` - Legacy channel operations
- `channel-action-1` - New channel operations

## Common Types

### Flag (Group ID)
Format: `~host/group-name`

### Nest (Channel ID)
Format: `{kind}/~host/channel-name`
Kinds: `chat`, `diary`, `heap`

## Tips

1. Ship names in pokes/responses include `~` prefix
2. Use `formatUd(unixToDa(timestamp))` for message IDs
3. Profile changes sync automatically to peers
4. Scries are synchronous reads; pokes are async writes
