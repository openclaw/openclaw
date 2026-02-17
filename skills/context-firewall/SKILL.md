# Context Firewall Skill 🛡️

## Description

**The Problem:** In multi-user environments (Group chats + DMs), AI agents suffer from "Shadow Context"—accidentally using private information from a DM to answer a question in a public group.
**The Solution:** This skill acts as a middleware for memory retrieval. It tags every memory with an `ownerId` and `scope` (private/group/public) and enforces strict access control at retrieval time.

It ensures:

- Private memories are ONLY accessible to their owner in DMs.
- Group memories are ONLY accessible within that specific group.
- Public memories are accessible to everyone.

## Tools

### context_store

Store a piece of information with explicit access scope.

- `text`: The information to store (e.g., "My API key is X").
- `scope`: "private" (DM only), "group" (specific group), or "public" (everyone).
- `ownerId`: The user ID of the owner (if private).
- `groupId`: The group ID (if group scope).

Run: `node skills/context-firewall/src/index.js store --text <text> --scope <scope> --owner <ownerId> --group <groupId>`

### context_retrieve

Retrieve context relevant to the current conversation, filtering out unauthorized memories.

- `query`: The search query.
- `currentUserId`: The ID of the user currently speaking.
- `currentGroupId`: The ID of the current group (optional).

Run: `node skills/context-firewall/src/index.js retrieve --query <query> --user <currentUserId> --group <currentGroupId>`

## Why this is critical

Standard memory systems are flat. If User A tells the bot a secret, and User B asks "What does User A know?", a standard RAG system might retrieve the secret. This skill prevents that data leak at the architectural level.
