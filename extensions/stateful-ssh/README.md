# Stateful SSH Plugin for OpenClaw

OpenClaw plugin that enables stateful SSH session management for AI agents. Allows the agent to maintain persistent SSH connections with session state (working directory, environment variables) preserved across multiple commands.

## Features

- **Persistent SSH Sessions**: Open SSH connections that remain active across multiple tool calls
- **State Preservation**: Working directory and environment variables persist between commands
- **Multiple Authentication Methods**: Supports both password and private key authentication
- **Session Management**: Track, list, and manage multiple concurrent sessions
- **Auto-Cleanup**: Automatic cleanup of idle sessions and graceful shutdown
- **Security**: Session limits, timeouts, and sandbox protection

## Installation

From the OpenClaw root directory:

```bash
pnpm install
```

The plugin will be automatically discovered and loaded by OpenClaw.

## Configuration

Configure the plugin via OpenClaw's plugin configuration:

```json
{
  "stateful-ssh": {
    "maxSessions": 5, // Maximum concurrent sessions (default: 5)
    "sessionTimeoutMs": 600000, // Idle timeout in ms (default: 10 minutes)
    "commandTimeoutMs": 300000 // Command timeout in ms (default: 5 minutes)
  }
}
```

## Available Tools

### 1. `open_ssh_session`

Opens a persistent SSH connection to a remote server.

**Parameters:**

- `host` (required): Hostname or IP address
- `port` (optional): SSH port (default: 22)
- `username` (required): SSH username
- `password` (optional): Password for authentication
- `privateKey` (optional): Private key in PEM format
- `passphrase` (optional): Passphrase for encrypted private key

**Returns:**

- `session_id`: Unique identifier for the session

**Example:**

```json
{
  "host": "example.com",
  "username": "user",
  "password": "secret"
}
```

### 2. `execute_ssh_command`

Executes a command in an existing SSH session.

**Parameters:**

- `session_id` (required): Session ID from `open_ssh_session`
- `command` (required): Command to execute
- `timeout_ms` (optional): Override the default command timeout in milliseconds

**Returns:**

- Command output

**Example:**

```json
{
  "session_id": "a1b2c3d4",
  "command": "pwd"
}
```

### 3. `close_ssh_session`

Closes an SSH session and frees resources.

**Parameters:**

- `session_id` (required): Session ID to close

**Example:**

```json
{
  "session_id": "a1b2c3d4"
}
```

### 4. `list_ssh_sessions`

Lists all currently active SSH sessions.

**Parameters:** None

**Returns:**

- List of active sessions with IDs, hosts, and activity times

## Usage Example

```typescript
// 1. Open a session
const result1 = await open_ssh_session({
  host: "192.168.1.100",
  username: "admin",
  password: "password123",
});
// Result: { session_id: "a1b2c3d4" }

// 2. Execute commands in the session
await execute_ssh_command({
  session_id: "a1b2c3d4",
  command: "cd /var/log",
});

await execute_ssh_command({
  session_id: "a1b2c3d4",
  command: "ls -la",
});
// The working directory is preserved!

// 3. Close the session when done
await close_ssh_session({
  session_id: "a1b2c3d4",
});
```

## AI Agent Guidelines

When instructing an AI agent to use this plugin, include the following guidance:

> When you need to work on a remote server:
>
> 1. Use `open_ssh_session` to establish a connection and **remember the session_id**
> 2. Use `execute_ssh_command` with the session_id for all commands
> 3. **Always** call `close_ssh_session` when finished to free resources
>
> The session maintains state - you can use `cd` and environment variables will persist between commands.

## Technical Details

- **SSH Library**: `ssh2` (Node.js)
- **Prompt Detection**: Uses regex `/[\$#>]\s*$/` to detect command completion
- **Session IDs**: 8-character UUID prefixes
- **Safety**: Disabled in sandboxed contexts

## Architecture

```
SSHSessionManager
├── Maintains Map<session_id, SSHSession>
├── Handles connection lifecycle
├── Implements timeout and cleanup
└── Provides session operations

Tools (ssh-tools.ts)
├── open_ssh_session
├── execute_ssh_command
├── close_ssh_session
└── list_ssh_sessions

Plugin Registration (index.ts)
└── Registers tools with OpenClaw
```

## Limitations

- Shell prompt detection is based on common patterns ($, #, >)
- Custom prompts may require adjustment of `promptPattern`
- Binary/interactive commands (vim, nano) are not supported
- No automatic reconnection on connection loss

## Future Improvements

- [ ] Unit and integration tests
- [ ] Custom prompt pattern per session
- [ ] Command blacklist for dangerous operations
- [ ] Automatic reconnection on connection loss
- [ ] Support for SSH agent forwarding
- [ ] File transfer capabilities (SCP/SFTP)

## License

Same as OpenClaw

## Contributing

See [StatefulSSHPlugin.md](./StatefulSSHPlugin.md) for detailed architecture documentation.
