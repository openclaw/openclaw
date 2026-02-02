# OpenClaw Process System

> Understanding how OpenClaw manages shell command execution through the "Process" abstraction.

## What is a "Process" in OpenClaw?

In OpenClaw, a **Process** (also called a **ProcessSession**) is a managed abstraction around a shell command execution. When the AI agent runs a bash command, OpenClaw wraps it in a `ProcessSession` object that tracks:

- The command being executed
- Standard output/error streams
- Exit codes and signals
- Timing information
- Background/foreground state

## Key Data Structures

### ProcessSession (Running Process)

Defined in `src/agents/bash-process-registry.ts`:

```typescript
interface ProcessSession {
  id: string;                    // Human-readable slug (e.g., "nova-gulf")
  command: string;               // The shell command being executed
  scopeKey?: string;             // Scope for isolation (agent/session)
  sessionKey?: string;           // Parent conversation session

  // Process handle
  child?: ChildProcessWithoutNullStreams;  // Node.js child process
  stdin?: SessionStdin;          // Write interface for input
  pid?: number;                  // OS process ID

  // Timing
  startedAt: number;             // Unix timestamp (ms)

  // Output management
  maxOutputChars: number;        // Output cap (default: 200,000)
  totalOutputChars: number;      // Total chars received
  pendingStdout: string[];       // Buffered stdout chunks
  pendingStderr: string[];       // Buffered stderr chunks
  aggregated: string;            // Combined output (capped)
  tail: string;                  // Last 2000 chars for quick preview
  truncated: boolean;            // Was output truncated?

  // State
  exited: boolean;               // Has process exited?
  exitCode?: number | null;      // Exit code (0 = success)
  exitSignal?: NodeJS.Signals;   // Kill signal if any
  backgrounded: boolean;         // Is this a background process?
  notifyOnExit?: boolean;        // Notify agent when done?
}
```

### FinishedSession (Completed Process)

When a process exits, it becomes a `FinishedSession`:

```typescript
interface FinishedSession {
  id: string;
  command: string;
  scopeKey?: string;
  startedAt: number;
  endedAt: number;               // When it finished
  cwd?: string;                  // Working directory
  status: ProcessStatus;         // "completed" | "failed" | "killed"
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals;
  aggregated: string;            // Full output (capped)
  tail: string;                  // Last 2000 chars
  truncated: boolean;
  totalOutputChars: number;
}
```

### ProcessStatus

```typescript
type ProcessStatus = "running" | "completed" | "failed" | "killed";
```

## Process Lifecycle

### 1. Instantiation

When the agent calls the `exec` tool:

```
Agent calls exec("npm install")
       │
       ▼
┌─────────────────────────────────────┐
│  createSessionSlug()                │
│  → Generates "nova-gulf"            │
└─────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  Spawn child process                │
│  - PTY (interactive) or             │
│  - Regular child_process            │
│  - Docker exec (if sandbox enabled) │
└─────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  Create ProcessSession object       │
│  {                                  │
│    id: "nova-gulf",                 │
│    command: "npm install",          │
│    pid: 12345,                      │
│    startedAt: 1706812800000,        │
│    ...                              │
│  }                                  │
└─────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  addSession(session)                │
│  → Adds to runningSessions Map      │
└─────────────────────────────────────┘
```

### 2. Output Collection

As the process runs:

```typescript
// stdout/stderr handlers continuously append output
appendOutput(session, "stdout", chunk);
appendOutput(session, "stderr", chunk);

// Output is:
// - Added to pendingStdout/pendingStderr buffers
// - Aggregated into session.aggregated (capped at maxOutputChars)
// - Tail updated (last 2000 chars for quick preview)
```

### 3. Polling (Background Processes)

When verbose mode shows `Process: poll nova-gulf`:

```typescript
// Agent calls process tool with action="poll"
case "poll": {
  // Drain pending output buffers
  const { stdout, stderr } = drainSession(session);

  // Check if exited
  if (session.exited) {
    markExited(session, exitCode, exitSignal, status);
    // Move to finishedSessions
  }

  // Return current output to agent
  return { content: [...], details: { status, output } };
}
```

### 4. Completion

When process exits:

```typescript
markExited(session, exitCode, exitSignal, status);
// → Sets session.exited = true
// → Records exit code/signal
// → Moves from runningSessions to finishedSessions
// → Optionally notifies agent via system event
```

## Session ID Generation

The human-readable slugs like "nova-gulf" are generated in `src/agents/session-slug.ts`:

```typescript
const SLUG_ADJECTIVES = [
  "amber", "briny", "brisk", "calm", "clear", "cool", "crisp",
  "dawn", "delta", "ember", "faint", "fast", "fresh", "gentle",
  "glow", "good", "grand", "keen", "kind", "lucky", "marine",
  "mellow", "mild", "neat", "nimble", "nova", "oceanic", "plaid",
  "quick", "quiet", "rapid", "salty", "sharp", "swift", "tender",
  "tidal", "tidy", "tide", "vivid", "warm", "wild", "young"
];

const SLUG_NOUNS = [
  "atlas", "basil", "bison", "bloom", "breeze", "canyon", "cedar",
  "claw", "cloud", "comet", "coral", "cove", "crest", "crustacean",
  "daisy", "dune", "ember", "falcon", "fjord", "forest", "glade",
  "gulf", "harbor", "haven", "kelp", "lagoon", "lobster", "meadow",
  "mist", "nudibranch", "nexus", "ocean", "orbit", "otter", "pine",
  "prairie", "reef", "ridge", "river", "rook", "sable", "sage",
  "seaslug", "shell", "shoal", "shore", "slug", "summit", "tidepool",
  "trail", "valley", "wharf", "willow", "zephyr"
];

function createSessionSlug(): string {
  // Combines random adjective + noun
  // e.g., "nova" + "gulf" = "nova-gulf"
  // Ensures uniqueness across running + finished sessions
}
```

## Process Registry

Two in-memory Maps track all processes:

```typescript
// Currently running processes
const runningSessions = new Map<string, ProcessSession>();

// Recently finished processes (kept for TTL period)
const finishedSessions = new Map<string, FinishedSession>();
```

### TTL and Cleanup

Finished sessions are automatically pruned after a TTL (default: 30 minutes):

```typescript
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;  // 30 minutes
const MIN_JOB_TTL_MS = 60 * 1000;           // 1 minute
const MAX_JOB_TTL_MS = 3 * 60 * 60 * 1000;  // 3 hours

// Sweeper runs periodically to clean up old finished sessions
function pruneFinishedSessions() {
  const cutoff = Date.now() - jobTtlMs;
  for (const [id, session] of finishedSessions.entries()) {
    if (session.endedAt < cutoff) {
      finishedSessions.delete(id);
    }
  }
}
```

## Process Tool Actions

The `process` tool (`src/agents/bash-tools.process.ts`) provides these actions:

| Action | Description |
|--------|-------------|
| `list` | List all running/finished background processes |
| `poll` | Get new output from a background process |
| `log` | Get full aggregated output history |
| `write` | Write text to process stdin |
| `send-keys` | Send special keys (Ctrl+C, etc.) |
| `submit` | Write text + press Enter |
| `paste` | Paste text (for PTY processes) |
| `kill` | Terminate a running process |

## Execution Hosts

Processes can run in different environments:

| Host | Description |
|------|-------------|
| `gateway` | Direct execution on the gateway host **(default)** |
| `sandbox` | Docker container with isolation (opt-in via config) |
| `node` | Remote execution on a paired device |

**Note:** By default (`sandbox.mode: "off"`), all commands execute directly on the gateway host machine—no Docker container is involved. Docker sandboxing is only enabled when explicitly configured in `openclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "docker"
      }
    }
  }
}
```

When sandbox mode is `"docker"`, commands run inside an isolated container with:
- Read-only root filesystem
- No network access by default
- Dropped capabilities (`ALL`)
- Resource limits (memory, CPU, PIDs)

## Key Files

| File | Purpose |
|------|---------|
| `src/agents/bash-process-registry.ts` | ProcessSession type, registry Maps, output management |
| `src/agents/bash-tools.exec.ts` | `exec` tool - spawns processes |
| `src/agents/bash-tools.process.ts` | `process` tool - poll/list/kill/write |
| `src/agents/session-slug.ts` | Human-readable ID generation |
| `src/agents/bash-tools.shared.ts` | Shared utilities (kill, sandbox args) |

## Example: What Happens When You See "Process: poll nova-gulf"

1. Agent previously ran a command that was **backgrounded** (e.g., `npm install &` or a long-running task)
2. The command was assigned the ID `nova-gulf`
3. Agent is now calling `process({ action: "poll", sessionId: "nova-gulf" })`
4. This drains any new output that accumulated since last poll
5. Returns the output + current status (running/completed/failed) to the agent
6. Agent uses this to decide if it needs to wait longer or can proceed

## Configuration

Environment variables that affect process behavior:

| Variable | Default | Description |
|----------|---------|-------------|
| `PI_BASH_MAX_OUTPUT_CHARS` | 200,000 | Max output chars to keep |
| `PI_BASH_JOB_TTL_MS` | 1,800,000 | How long to keep finished sessions |
| `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS` | 200,000 | Max pending buffer size |

---

*This document explains the Process abstraction in OpenClaw as of version 2026.1.29*
