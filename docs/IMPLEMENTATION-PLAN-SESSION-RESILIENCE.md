# Session Resilience & Anti-Stuck Implementation Plan

**Status:** Draft
**Created:** 2026-02-06
**Owner:** Engineering Team
**Priority:** P0 (Critical Infrastructure)

---

## Executive Summary

This document outlines a comprehensive plan to eliminate stuck sessions and improve system resilience in the moltbot gateway. The current architecture lacks timeout mechanisms, session size management, and isolation between processing lanes, leading to catastrophic failures where a single stuck session blocks all Discord message processing.

**Key Metrics:**
- **Current MTBF:** ~6-8 hours (based on recent incidents)
- **Target MTBF:** >7 days
- **Current Recovery:** Manual gateway restart
- **Target Recovery:** Automatic within 30 seconds

---

## Table of Contents

1. [Background & Root Causes](#background--root-causes)
2. [Incident Analysis](#incident-analysis)
3. [Proposed Solutions](#proposed-solutions)
4. [Implementation Phases](#implementation-phases)
5. [Technical Architecture](#technical-architecture)
6. [Migration Strategy](#migration-strategy)
7. [Monitoring & Alerting](#monitoring--alerting)
8. [Testing Strategy](#testing-strategy)
9. [Rollout Plan](#rollout-plan)

---

## Background & Root Causes

### Current Architecture Problems

#### 1. No Session Timeouts

**Problem:**
Sessions can run indefinitely without any timeout mechanism. When a session encounters an infinite loop, deadlock, or external API hang, it blocks the entire processing queue.

**Evidence from Incident 2026-02-06:**
```
stuck session: sessionId=unknown
  sessionKey=agent:main:discord:channel:1465740174339211266
  state=processing
  age=775s
  queueDepth=1
```

**Why This Happens:**
- No `AbortController` timeout on agent runs
- No watchdog monitoring session processing time
- No maximum execution time configured
- External API calls (Anthropic) can hang indefinitely
- Tool execution (bash, file operations) can run forever

**Impact:**
- 775 seconds (13 minutes) of blocked processing
- All Discord messages queued behind stuck session
- Gateway appears "dead" to users
- Requires manual intervention to recover

---

#### 2. Unbounded Session Growth

**Problem:**
Session files grow without limit, leading to exponential performance degradation as context size increases.

**Evidence from Atlas atlas-dm Investigation:**
```
File: ~/.clawdbot/agents/atlas/sessions/fd067a0f-3aef-4ba3-bd8d-57dcaca4b831.jsonl
Size: 16MB (megabytes)
Lines: 6,359 lines
Impact: 5-10 second delays, peaking at 95+ seconds per message
```

**Why This Happens:**
- No automatic session archiving
- No session size limits
- No automatic summarization
- Long-running channels accumulate infinite history
- Every message loads entire session context

**Growth Pattern:**
```
Day 1:   ~50 messages  →  100KB  →  <1s response time
Week 1:  ~500 messages  →  1MB   →  2-3s response time
Month 1: ~2000 messages →  5MB   →  10-15s response time
Month 3: ~6000 messages →  16MB  →  60-95s response time
```

**Compounding Effects:**
1. Larger context → Slower API calls
2. Slower API calls → Longer processing time
3. Longer processing → More timeout risk
4. More timeouts → User frustration
5. User frustration → More messages
6. More messages → Larger context (cycle repeats)

---

#### 3. Shared Message Queue

**Problem:**
All Discord channels share a single sequential processing queue. A stuck session in one channel blocks ALL other channels.

**Architecture:**
```
Current (Sequential):
┌─────────────────────────────────────┐
│   Single Message Queue              │
├─────────────────────────────────────┤
│ 1. atlas-dm message (STUCK 775s)   │  ← Blocks everything
│ 2. the-hub message (waiting...)     │
│ 3. parker-dm message (waiting...)   │
│ 4. rowan-dm message (waiting...)    │
└─────────────────────────────────────┘
        ↓
   Single Worker
```

**Why This Design Exists:**
- Originally designed for low message volume
- Simplifies ordering guarantees
- Easier to reason about synchronization
- No need for complex scheduling

**Why It Fails at Scale:**
- No isolation between channels
- No priority queues
- No backpressure handling
- Cascade failures (one channel kills all)

---

#### 4. No Circuit Breakers

**Problem:**
Failed sessions retry indefinitely with no failure tracking or temporary disabling.

**Current Behavior:**
```typescript
// Simplified current logic
async function processMessage(message) {
  try {
    await runAgent(message); // Can hang forever
  } catch (err) {
    // Log error and continue
    // No tracking of failure rate
    // No temporary disabling
    // No exponential backoff
  }
}
```

**Failure Scenarios:**
- Anthropic API outage → All sessions fail
- Database lock → All sessions timeout
- Network partition → All sessions hang
- Memory leak → Progressive slowdown

**Missing Protections:**
- No failure rate tracking
- No automatic degradation
- No load shedding
- No graceful degradation

---

#### 5. Limited Observability

**Problem:**
Difficult to diagnose stuck sessions without manual log analysis.

**Current State:**
- Logs scattered across multiple files
- No centralized metrics
- No real-time dashboards
- No alerting on session age
- No tracing across async boundaries

**What We Need to See:**
- Session processing time (p50, p95, p99)
- Active session count by state
- Queue depth per channel
- Failure rates by agent
- Memory usage per session
- API latency breakdown

---

## Incident Analysis

### Incident: Discord Gateway Unresponsive (2026-02-06)

**Timeline:**
```
13:37:17 - First "lane wait exceeded" warning (5s delay)
13:43:29 - Slow listener detected (95s processing time)
22:03:08 - Multiple Discord reconnect attempts
22:03:09 - Stuck session detected (775s age)
22:03:09 - Session aborted by diagnostic system
22:05:44 - Gateway restarted, service restored
```

**Root Cause Chain:**
1. Session started processing message in channel 1465740174339211266
2. Session encountered unknown hang (likely API or tool timeout)
3. No timeout mechanism aborted the stuck session
4. Stuck session held processing lane for 775 seconds
5. All subsequent Discord messages queued behind stuck session
6. Discord client detected unresponsiveness, attempted reconnect
7. Reconnect failed due to queue backup
8. Manual intervention required (kill process)

**Impact:**
- 13+ minutes of total Discord outage
- ~20+ messages queued/delayed
- Multiple agent DM channels affected
- User experience severely degraded

**Prevention Measures Needed:**
- Session timeout after 5 minutes maximum
- Per-channel queue isolation
- Circuit breaker on repeated failures
- Automatic stuck session detection & abort
- Health check endpoint for liveness

---

### Historical Pattern Analysis

**Similar Incidents:**
- 2026-01-31 16:38:28 - Config file corruption (separate issue)
- 2026-01-31 16:35:29 - Exec elevated command timeout
- 2026-01-31 16:37:01 - Multiple slow listener warnings

**Common Themes:**
- All involve long-running operations
- All lack timeout protections
- All cascade to full system failure
- All require manual restart

**Frequency:**
- Stuck sessions: 2-3 times per week
- Session bloat degradation: Continuous
- Manual restarts needed: Daily

---

## Proposed Solutions

### Solution 1: Session Timeout & Auto-Recovery

**Objective:** Prevent sessions from running longer than a configured maximum time.

#### Architecture

```typescript
/**
 * Session Watchdog - Monitors all active sessions and aborts stuck ones
 * Location: src/gateway/session-watchdog.ts (NEW FILE)
 */

interface WatchdogConfig {
  // Maximum time a session can be in 'processing' state
  maxProcessingTimeMs: number;        // Default: 300000 (5 minutes)

  // How often to check for stuck sessions
  checkIntervalMs: number;            // Default: 10000 (10 seconds)

  // Grace period for sessions to clean up after abort
  abortGracePeriodMs: number;         // Default: 5000 (5 seconds)

  // Whether to auto-restart stuck sessions
  autoRestart: boolean;               // Default: false
}

class SessionWatchdog {
  private config: WatchdogConfig;
  private timer: NodeJS.Timeout | null;
  private activeSessions: Map<string, SessionMonitor>;

  constructor(config: WatchdogConfig) {
    this.config = config;
    this.activeSessions = new Map();
  }

  /**
   * Start monitoring a session
   */
  startMonitoring(sessionId: string, abortController: AbortController): void {
    const monitor: SessionMonitor = {
      sessionId,
      startTime: Date.now(),
      abortController,
      state: 'running',
      checkCount: 0,
    };

    this.activeSessions.set(sessionId, monitor);
  }

  /**
   * Stop monitoring a completed session
   */
  stopMonitoring(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  /**
   * Main watchdog loop - checks all active sessions
   */
  private async checkSessions(): Promise<void> {
    const now = Date.now();

    for (const [sessionId, monitor] of this.activeSessions) {
      const age = now - monitor.startTime;

      // Check if session exceeded max processing time
      if (age > this.config.maxProcessingTimeMs) {
        await this.abortStuckSession(sessionId, monitor, age);
      }

      monitor.checkCount++;
    }
  }

  /**
   * Abort a stuck session and clean up
   */
  private async abortStuckSession(
    sessionId: string,
    monitor: SessionMonitor,
    age: number
  ): Promise<void> {
    logger.warn('Aborting stuck session', {
      sessionId,
      age,
      maxAllowed: this.config.maxProcessingTimeMs,
      checkCount: monitor.checkCount,
    });

    // Emit metric
    metrics.increment('session.timeout.abort', {
      sessionId,
      age: Math.floor(age / 1000),
    });

    try {
      // Abort the session using AbortController
      monitor.abortController.abort(
        new SessionTimeoutError(`Session exceeded ${this.config.maxProcessingTimeMs}ms`)
      );

      monitor.state = 'aborting';

      // Wait for graceful shutdown
      await sleep(this.config.abortGracePeriodMs);

      // Force cleanup if session didn't stop
      if (this.activeSessions.has(sessionId)) {
        logger.error('Session did not stop after abort signal', { sessionId });
        this.forcefulCleanup(sessionId);
      }

      // Emit event for monitoring
      this.emitEvent('session:aborted', {
        sessionId,
        reason: 'timeout',
        age,
      });

    } catch (err) {
      logger.error('Error aborting stuck session', { sessionId, err });
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  /**
   * Forcefully clean up a session that didn't respond to abort
   */
  private forcefulCleanup(sessionId: string): void {
    // Implementation depends on session storage mechanism
    // May involve:
    // - Force-closing database connections
    // - Killing subprocesses
    // - Clearing memory references
    // - Resetting queue state
  }

  /**
   * Start the watchdog timer
   */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(
      () => this.checkSessions(),
      this.config.checkIntervalMs
    );

    logger.info('Session watchdog started', {
      maxProcessingTime: this.config.maxProcessingTimeMs,
      checkInterval: this.config.checkIntervalMs,
    });
  }

  /**
   * Stop the watchdog timer
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    logger.info('Session watchdog stopped');
  }

  /**
   * Get current watchdog status
   */
  getStatus(): WatchdogStatus {
    return {
      active: this.timer !== null,
      monitoredSessions: this.activeSessions.size,
      sessions: Array.from(this.activeSessions.entries()).map(([id, m]) => ({
        sessionId: id,
        age: Date.now() - m.startTime,
        state: m.state,
        checkCount: m.checkCount,
      })),
    };
  }
}

/**
 * Session monitoring data
 */
interface SessionMonitor {
  sessionId: string;
  startTime: number;
  abortController: AbortController;
  state: 'running' | 'aborting' | 'aborted';
  checkCount: number;
}

/**
 * Custom error for session timeouts
 */
class SessionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTimeoutError';
  }
}
```

#### Integration Points

**1. Gateway Server Integration** (`src/gateway/server-chat.ts`)

```typescript
// Add watchdog instance
const watchdog = new SessionWatchdog({
  maxProcessingTimeMs: config.session.maxProcessingTimeMs || 300000,
  checkIntervalMs: 10000,
  abortGracePeriodMs: 5000,
  autoRestart: false,
});

// Start watchdog on gateway startup
watchdog.start();

// Modify session execution to use watchdog
async function executeAgentSession(sessionKey: string, message: Message) {
  const abortController = new AbortController();
  const sessionId = generateSessionId();

  try {
    // Register with watchdog
    watchdog.startMonitoring(sessionId, abortController);

    // Execute with abort signal
    const result = await runAgent({
      message,
      signal: abortController.signal,
      sessionKey,
    });

    return result;

  } catch (err) {
    if (err instanceof SessionTimeoutError) {
      logger.warn('Session timed out', { sessionId, sessionKey });

      // Handle timeout-specific logic
      await handleSessionTimeout(sessionKey, err);

      throw err;
    }
    throw err;

  } finally {
    // Always unregister from watchdog
    watchdog.stopMonitoring(sessionId);
  }
}
```

**2. Agent Runner Integration** (`src/agents/run.ts`)

```typescript
// Propagate abort signal through agent execution
async function runAgent(opts: {
  message: Message;
  signal: AbortSignal;
  sessionKey: string;
}): Promise<AgentResult> {
  const { message, signal, sessionKey } = opts;

  // Check if already aborted
  if (signal.aborted) {
    throw new SessionTimeoutError('Session aborted before execution');
  }

  // Listen for abort event
  signal.addEventListener('abort', () => {
    logger.info('Agent run aborted by watchdog', { sessionKey });
    // Clean up any in-progress work
    cleanup();
  });

  try {
    // Pass signal to Anthropic API call
    const response = await anthropic.messages.create(
      {
        model: 'claude-opus-4-5',
        messages: [message],
        max_tokens: 4096,
      },
      {
        signal, // AbortSignal passed to fetch
      }
    );

    // Process tools with abort checking
    if (response.stop_reason === 'tool_use') {
      for (const toolUse of response.content.filter(c => c.type === 'tool_use')) {
        // Check abort before each tool
        if (signal.aborted) {
          throw new SessionTimeoutError('Session aborted during tool execution');
        }

        await executeTool(toolUse, { signal });
      }
    }

    return response;

  } catch (err) {
    if (err.name === 'AbortError') {
      throw new SessionTimeoutError('Session aborted during API call');
    }
    throw err;
  }
}
```

**3. Tool Execution Integration** (`src/agents/tools/*.ts`)

```typescript
// Example: Bash tool with timeout
async function executeBashTool(
  command: string,
  opts: { signal?: AbortSignal; timeout?: number }
): Promise<ToolResult> {
  const { signal, timeout = 120000 } = opts;

  const childProcess = spawn('bash', ['-c', command]);

  // Handle abort signal
  signal?.addEventListener('abort', () => {
    childProcess.kill('SIGTERM');

    // Force kill after grace period
    setTimeout(() => {
      if (!childProcess.killed) {
        childProcess.kill('SIGKILL');
      }
    }, 5000);
  });

  // Also apply per-tool timeout
  const timeoutId = setTimeout(() => {
    logger.warn('Bash command timeout', { command, timeout });
    childProcess.kill('SIGTERM');
  }, timeout);

  try {
    const result = await waitForProcess(childProcess);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

#### Configuration

**Add to `moltbot.json` schema:**

```json
{
  "gateway": {
    "session": {
      "watchdog": {
        "enabled": true,
        "maxProcessingTimeMs": 300000,
        "checkIntervalMs": 10000,
        "abortGracePeriodMs": 5000,
        "autoRestart": false
      }
    }
  }
}
```

#### Metrics & Logging

**Metrics to emit:**
- `session.timeout.abort` - Counter of aborted sessions
- `session.processing_time` - Histogram of session execution time
- `session.age_at_abort` - Histogram of session age when aborted
- `watchdog.check_duration` - Histogram of watchdog check time
- `watchdog.active_sessions` - Gauge of monitored sessions

**Log events:**
- Session started monitoring
- Session timeout detected
- Session abort initiated
- Session abort completed
- Session failed to abort (needs forceful cleanup)

---

### Solution 2: Session Summarization

**Objective:** Prevent unbounded session growth by summarizing old messages.

#### Architecture

```typescript
/**
 * Session Summarizer - Automatically summarizes old session history
 * Location: src/gateway/session-summarizer.ts (NEW FILE)
 */

interface SummarizerConfig {
  // Maximum number of messages before summarization
  maxMessages: number;                // Default: 1000

  // Maximum session size in bytes before summarization
  maxSizeBytes: number;               // Default: 5 * 1024 * 1024 (5MB)

  // How many recent messages to keep unsummarized
  keepRecentMessages: number;         // Default: 200

  // Model to use for summarization
  summaryModel: string;               // Default: 'claude-haiku-3-5'

  // Whether summarization is enabled
  enabled: boolean;                   // Default: true
}

class SessionSummarizer {
  private config: SummarizerConfig;

  constructor(config: SummarizerConfig) {
    this.config = config;
  }

  /**
   * Check if session needs summarization
   */
  needsSummarization(session: Session): boolean {
    if (!this.config.enabled) return false;

    const messageCount = session.messages.length;
    const sessionSize = JSON.stringify(session.messages).length;

    return (
      messageCount > this.config.maxMessages ||
      sessionSize > this.config.maxSizeBytes
    );
  }

  /**
   * Summarize a session's old messages
   */
  async summarize(session: Session): Promise<Session> {
    const { messages } = session;
    const keepRecent = this.config.keepRecentMessages;

    // Split messages into old (to summarize) and recent (to keep)
    const oldMessages = messages.slice(0, -keepRecent);
    const recentMessages = messages.slice(-keepRecent);

    logger.info('Summarizing session', {
      sessionKey: session.key,
      totalMessages: messages.length,
      oldMessages: oldMessages.length,
      recentMessages: recentMessages.length,
    });

    // Generate summary of old messages
    const summary = await this.generateSummary(oldMessages, session);

    // Create new message array with summary + recent messages
    const newMessages: Message[] = [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: this.formatSummary(summary, oldMessages.length),
          }
        ],
      },
      ...recentMessages,
    ];

    // Calculate compression ratio
    const oldSize = JSON.stringify(oldMessages).length;
    const newSize = JSON.stringify(summary).length;
    const compressionRatio = ((oldSize - newSize) / oldSize * 100).toFixed(1);

    logger.info('Session summarization complete', {
      sessionKey: session.key,
      oldSize,
      newSize,
      compressionRatio: `${compressionRatio}%`,
      messageCount: {
        before: messages.length,
        after: newMessages.length,
      },
    });

    // Emit metrics
    metrics.histogram('session.summarization.compression_ratio',
      parseFloat(compressionRatio));
    metrics.histogram('session.summarization.old_size_mb',
      oldSize / (1024 * 1024));
    metrics.histogram('session.summarization.new_size_mb',
      newSize / (1024 * 1024));

    return {
      ...session,
      messages: newMessages,
      metadata: {
        ...session.metadata,
        lastSummarizedAt: Date.now(),
        summarizationCount: (session.metadata.summarizationCount || 0) + 1,
      },
    };
  }

  /**
   * Generate summary using LLM
   */
  private async generateSummary(
    messages: Message[],
    session: Session
  ): Promise<string> {
    const prompt = this.buildSummaryPrompt(messages, session);

    try {
      const response = await anthropic.messages.create({
        model: this.config.summaryModel,
        max_tokens: 2048,
        messages: [
          {
            role: 'user',
            content: prompt,
          }
        ],
      });

      const summary = response.content[0].text;
      return summary;

    } catch (err) {
      logger.error('Failed to generate summary', {
        sessionKey: session.key,
        messageCount: messages.length,
        error: err,
      });

      // Fallback: return basic summary
      return this.generateFallbackSummary(messages);
    }
  }

  /**
   * Build prompt for summarization
   */
  private buildSummaryPrompt(messages: Message[], session: Session): string {
    return `You are helping to summarize a long conversation history to reduce context size while preserving important information.

**Session Context:**
- Agent: ${session.agentId}
- Channel: ${session.channel}
- Message count: ${messages.length}
- Time range: ${this.getTimeRange(messages)}

**Your Task:**
Create a concise summary of the conversation history below. Focus on:
1. Key decisions and outcomes
2. Important context that future messages might reference
3. Ongoing tasks or unresolved items
4. Technical details that shouldn't be lost
5. User preferences or requirements mentioned

**Format:**
Provide a well-structured summary in 2-3 paragraphs. Start with "## Previous Conversation Summary" as a header.

**Conversation History:**
${this.formatMessagesForSummary(messages)}

**Summary:**`;
  }

  /**
   * Format messages for summary prompt
   */
  private formatMessagesForSummary(messages: Message[]): string {
    return messages.map((msg, idx) => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const content = this.extractTextContent(msg);
      const truncated = content.length > 500
        ? content.slice(0, 500) + '...'
        : content;

      return `[${idx + 1}] ${role}: ${truncated}`;
    }).join('\n\n');
  }

  /**
   * Extract text content from message
   */
  private extractTextContent(message: Message): string {
    if (typeof message.content === 'string') {
      return message.content;
    }

    return message.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }

  /**
   * Format summary for insertion into session
   */
  private formatSummary(summary: string, messageCount: number): string {
    return `${summary}

---
*This summary represents ${messageCount} previous messages in this conversation. Recent messages follow below.*`;
  }

  /**
   * Generate fallback summary if LLM fails
   */
  private generateFallbackSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user').length;
    const assistantMessages = messages.filter(m => m.role === 'assistant').length;

    return `## Previous Conversation Summary

This session contains ${messages.length} previous messages (${userMessages} from user, ${assistantMessages} from assistant) that have been archived. The conversation history has been preserved but compressed to reduce context size.

**Note:** This is an automatic summary. Some details from the previous conversation may not be included.`;
  }

  /**
   * Get time range of messages
   */
  private getTimeRange(messages: Message[]): string {
    // Implementation depends on message timestamp storage
    return 'N/A';
  }
}
```

#### Integration Points

**1. Session Load/Save Hooks** (`src/gateway/session-utils.ts`)

```typescript
// Check and summarize on session load
async function loadSession(sessionKey: string): Promise<Session> {
  const session = await readSessionFromDisk(sessionKey);

  // Check if summarization needed
  if (summarizer.needsSummarization(session)) {
    logger.info('Session needs summarization', { sessionKey });

    try {
      const summarized = await summarizer.summarize(session);

      // Save summarized version
      await saveSession(summarized);

      return summarized;
    } catch (err) {
      logger.error('Summarization failed, using original session', {
        sessionKey,
        error: err,
      });
      return session;
    }
  }

  return session;
}

// Check and summarize before save
async function saveSession(session: Session): Promise<void> {
  let sessionToSave = session;

  // Check if summarization needed
  if (summarizer.needsSummarization(session)) {
    try {
      sessionToSave = await summarizer.summarize(session);
    } catch (err) {
      logger.error('Pre-save summarization failed', {
        sessionKey: session.key,
        error: err,
      });
      // Continue with original session
    }
  }

  await writeSessionToDisk(sessionToSave);
}
```

**2. Background Summarization Job** (`src/gateway/session-maintenance.ts`)

```typescript
/**
 * Background job to proactively summarize large sessions
 */
class SessionMaintenanceJob {
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private summarizer: SessionSummarizer,
    private intervalMs: number = 3600000 // 1 hour
  ) {}

  start(): void {
    if (this.interval) return;

    this.interval = setInterval(
      () => this.runMaintenance(),
      this.intervalMs
    );

    logger.info('Session maintenance job started', {
      interval: this.intervalMs,
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async runMaintenance(): Promise<void> {
    logger.info('Running session maintenance');

    try {
      // Get all active sessions
      const sessions = await getAllSessions();

      let summarizedCount = 0;

      for (const session of sessions) {
        if (this.summarizer.needsSummarization(session)) {
          try {
            const summarized = await this.summarizer.summarize(session);
            await saveSession(summarized);
            summarizedCount++;
          } catch (err) {
            logger.error('Maintenance summarization failed', {
              sessionKey: session.key,
              error: err,
            });
          }
        }
      }

      logger.info('Session maintenance complete', {
        totalSessions: sessions.length,
        summarizedCount,
      });

      metrics.gauge('session.maintenance.summarized', summarizedCount);

    } catch (err) {
      logger.error('Session maintenance job failed', { error: err });
    }
  }
}
```

#### Configuration

**Add to `moltbot.json` schema:**

```json
{
  "gateway": {
    "session": {
      "summarization": {
        "enabled": true,
        "maxMessages": 1000,
        "maxSizeBytes": 5242880,
        "keepRecentMessages": 200,
        "summaryModel": "claude-haiku-3-5",
        "maintenanceInterval": 3600000
      }
    }
  }
}
```

#### Metrics & Logging

**Metrics:**
- `session.summarization.triggered` - Count of summarizations
- `session.summarization.compression_ratio` - % size reduction
- `session.summarization.old_size_mb` - Size before
- `session.summarization.new_size_mb` - Size after
- `session.summarization.duration_ms` - Time to summarize
- `session.summarization.failed` - Failed summarizations

---

### Solution 3: Per-Channel Queue Isolation

**Objective:** Prevent stuck sessions in one channel from blocking other channels.

#### Architecture

```typescript
/**
 * Channel Queue Manager - Isolates message processing by channel
 * Location: src/gateway/channel-queue-manager.ts (NEW FILE)
 */

interface ChannelQueueConfig {
  // Number of concurrent workers per channel
  workersPerChannel: number;          // Default: 1

  // Maximum queue depth before backpressure
  maxQueueDepth: number;              // Default: 100

  // Whether to enable priority queuing
  enablePriority: boolean;            // Default: false

  // Timeout for acquiring lane lock
  laneLockTimeoutMs: number;          // Default: 30000
}

/**
 * Manages isolated queues per channel
 */
class ChannelQueueManager {
  private queues: Map<string, ChannelQueue>;
  private config: ChannelQueueConfig;

  constructor(config: ChannelQueueConfig) {
    this.queues = new Map();
    this.config = config;
  }

  /**
   * Enqueue a message for processing
   */
  async enqueue(channelId: string, message: Message): Promise<void> {
    // Get or create queue for this channel
    let queue = this.queues.get(channelId);
    if (!queue) {
      queue = this.createQueue(channelId);
      this.queues.set(channelId, queue);
    }

    // Check backpressure
    if (queue.depth >= this.config.maxQueueDepth) {
      logger.warn('Channel queue at capacity', {
        channelId,
        depth: queue.depth,
        maxDepth: this.config.maxQueueDepth,
      });

      metrics.increment('channel.queue.backpressure', { channelId });

      throw new QueueFullError(
        `Channel ${channelId} queue is full (${queue.depth}/${this.config.maxQueueDepth})`
      );
    }

    // Add to queue
    await queue.enqueue(message);

    metrics.gauge('channel.queue.depth', queue.depth, { channelId });
  }

  /**
   * Create a new queue for a channel
   */
  private createQueue(channelId: string): ChannelQueue {
    const queue = new ChannelQueue(channelId, this.config);

    // Start workers for this queue
    for (let i = 0; i < this.config.workersPerChannel; i++) {
      this.startWorker(queue, i);
    }

    logger.info('Created channel queue', {
      channelId,
      workers: this.config.workersPerChannel,
    });

    return queue;
  }

  /**
   * Start a worker for a queue
   */
  private async startWorker(queue: ChannelQueue, workerId: number): Promise<void> {
    logger.info('Starting channel worker', {
      channelId: queue.channelId,
      workerId,
    });

    while (true) {
      try {
        // Wait for next message
        const message = await queue.dequeue();

        if (!message) {
          // Queue closed or empty, wait a bit
          await sleep(100);
          continue;
        }

        const startTime = Date.now();

        try {
          // Process message
          await this.processMessage(queue.channelId, message);

          const duration = Date.now() - startTime;

          metrics.histogram('channel.message.processing_time', duration, {
            channelId: queue.channelId,
            workerId: String(workerId),
          });

        } catch (err) {
          logger.error('Worker failed to process message', {
            channelId: queue.channelId,
            workerId,
            error: err,
          });

          metrics.increment('channel.message.processing_error', {
            channelId: queue.channelId,
          });

          // Handle error (retry, dead letter queue, etc.)
          await this.handleProcessingError(queue.channelId, message, err);
        }

      } catch (err) {
        logger.error('Worker crashed', {
          channelId: queue.channelId,
          workerId,
          error: err,
        });

        // Wait before restarting to avoid tight loop
        await sleep(1000);
      }
    }
  }

  /**
   * Process a single message
   */
  private async processMessage(channelId: string, message: Message): Promise<void> {
    // Implementation: call existing session execution logic
    await executeAgentSession(channelId, message);
  }

  /**
   * Handle processing errors
   */
  private async handleProcessingError(
    channelId: string,
    message: Message,
    error: Error
  ): Promise<void> {
    // Check if retriable
    const retriable = this.isRetriableError(error);

    if (retriable && message.retryCount < 3) {
      // Retry with exponential backoff
      const delay = Math.pow(2, message.retryCount) * 1000;
      await sleep(delay);

      message.retryCount++;
      await this.enqueue(channelId, message);

      logger.info('Message requeued for retry', {
        channelId,
        retryCount: message.retryCount,
        delay,
      });

    } else {
      // Move to dead letter queue
      await this.sendToDeadLetterQueue(channelId, message, error);

      logger.error('Message moved to dead letter queue', {
        channelId,
        messageId: message.id,
        error,
      });
    }
  }

  /**
   * Check if error is retriable
   */
  private isRetriableError(error: Error): boolean {
    // Temporary failures that should be retried
    const retriableErrors = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'NetworkError',
      'ServiceUnavailable',
    ];

    return retriableErrors.some(e => error.message.includes(e));
  }

  /**
   * Send failed message to dead letter queue
   */
  private async sendToDeadLetterQueue(
    channelId: string,
    message: Message,
    error: Error
  ): Promise<void> {
    const dlqPath = path.join(config.dataDir, 'dead-letter-queue.jsonl');

    const record = {
      timestamp: Date.now(),
      channelId,
      message,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    };

    await fs.promises.appendFile(
      dlqPath,
      JSON.stringify(record) + '\n'
    );
  }

  /**
   * Get status of all queues
   */
  getStatus(): ChannelQueueStatus[] {
    return Array.from(this.queues.entries()).map(([channelId, queue]) => ({
      channelId,
      depth: queue.depth,
      processing: queue.processing,
      workers: this.config.workersPerChannel,
      state: queue.state,
    }));
  }

  /**
   * Pause a specific channel queue
   */
  pauseChannel(channelId: string): void {
    const queue = this.queues.get(channelId);
    if (queue) {
      queue.pause();
      logger.info('Channel queue paused', { channelId });
    }
  }

  /**
   * Resume a specific channel queue
   */
  resumeChannel(channelId: string): void {
    const queue = this.queues.get(channelId);
    if (queue) {
      queue.resume();
      logger.info('Channel queue resumed', { channelId });
    }
  }
}

/**
 * Individual channel queue
 */
class ChannelQueue {
  public channelId: string;
  public depth: number = 0;
  public processing: number = 0;
  public state: 'running' | 'paused' | 'stopped' = 'running';

  private queue: Message[] = [];
  private waiters: Array<(msg: Message | null) => void> = [];

  constructor(
    channelId: string,
    private config: ChannelQueueConfig
  ) {
    this.channelId = channelId;
  }

  /**
   * Add message to queue
   */
  async enqueue(message: Message): Promise<void> {
    this.queue.push(message);
    this.depth = this.queue.length;

    // Notify waiting workers
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      const msg = this.queue.shift();
      if (waiter && msg) {
        waiter(msg);
        this.depth = this.queue.length;
      }
    }
  }

  /**
   * Get next message from queue
   */
  async dequeue(): Promise<Message | null> {
    if (this.state === 'paused') {
      return null;
    }

    if (this.state === 'stopped') {
      return null;
    }

    if (this.queue.length > 0) {
      const message = this.queue.shift();
      this.depth = this.queue.length;
      this.processing++;
      return message || null;
    }

    // Wait for next message
    return new Promise((resolve) => {
      this.waiters.push(resolve);

      // Timeout after 30 seconds
      setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
          resolve(null);
        }
      }, 30000);
    });
  }

  /**
   * Mark message processing complete
   */
  complete(): void {
    this.processing = Math.max(0, this.processing - 1);
  }

  /**
   * Pause queue
   */
  pause(): void {
    this.state = 'paused';
  }

  /**
   * Resume queue
   */
  resume(): void {
    this.state = 'running';
  }

  /**
   * Stop queue
   */
  stop(): void {
    this.state = 'stopped';

    // Resolve all waiters with null
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
  }
}

class QueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueFullError';
  }
}
```

#### Migration from Current Architecture

**Current (Sequential):**
```typescript
// All messages go to single lane
async function handleDiscordMessage(message: DiscordMessage) {
  await messageLane.acquire();
  try {
    await processMessage(message);
  } finally {
    messageLane.release();
  }
}
```

**New (Per-Channel):**
```typescript
// Messages routed to channel-specific queues
async function handleDiscordMessage(message: DiscordMessage) {
  const channelId = message.channel_id;
  await channelQueueManager.enqueue(channelId, message);
  // Worker handles processing asynchronously
}
```

**Backwards Compatibility:**
```typescript
// Can run both systems in parallel during migration
const useChannelQueues = config.gateway.channelQueues?.enabled ?? false;

async function handleDiscordMessage(message: DiscordMessage) {
  if (useChannelQueues) {
    await channelQueueManager.enqueue(message.channel_id, message);
  } else {
    // Old sequential path
    await messageLane.acquire();
    try {
      await processMessage(message);
    } finally {
      messageLane.release();
    }
  }
}
```

#### Configuration

```json
{
  "gateway": {
    "channelQueues": {
      "enabled": true,
      "workersPerChannel": 1,
      "maxQueueDepth": 100,
      "enablePriority": false,
      "laneLockTimeoutMs": 30000
    }
  }
}
```

---

### Solution 4: Circuit Breaker Pattern

**Objective:** Prevent cascade failures by temporarily disabling failing components.

#### Architecture

```typescript
/**
 * Circuit Breaker - Prevents cascade failures
 * Location: src/gateway/circuit-breaker.ts (NEW FILE)
 */

interface CircuitBreakerConfig {
  // Number of failures before opening circuit
  failureThreshold: number;           // Default: 5

  // Time window for counting failures (ms)
  windowMs: number;                   // Default: 60000 (1 minute)

  // How long to keep circuit open before trying again
  resetTimeoutMs: number;             // Default: 60000 (1 minute)

  // How many requests to allow in half-open state
  halfOpenRequests: number;           // Default: 3
}

/**
 * Circuit breaker states
 */
type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker implementation
 */
class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private nextRetryTime: number = 0;
  private halfOpenAttempts: number = 0;

  constructor(
    private name: string,
    private config: CircuitBreakerConfig
  ) {}

  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check circuit state
    this.updateState();

    if (this.state === 'open') {
      metrics.increment('circuit_breaker.rejected', { name: this.name });

      throw new CircuitOpenError(
        `Circuit breaker '${this.name}' is open (too many failures)`
      );
    }

    try {
      const result = await fn();

      // Success
      this.onSuccess();

      return result;

    } catch (err) {
      // Failure
      this.onFailure();

      throw err;
    }
  }

  /**
   * Update circuit state based on time and counts
   */
  private updateState(): void {
    const now = Date.now();

    switch (this.state) {
      case 'open':
        // Check if we should transition to half-open
        if (now >= this.nextRetryTime) {
          this.state = 'half-open';
          this.halfOpenAttempts = 0;

          logger.info('Circuit breaker half-open', {
            name: this.name,
            failureCount: this.failureCount,
          });

          metrics.increment('circuit_breaker.half_open', { name: this.name });
        }
        break;

      case 'half-open':
        // Already handled in onSuccess/onFailure
        break;

      case 'closed':
        // Reset failure count if outside window
        if (now - this.lastFailureTime > this.config.windowMs) {
          this.failureCount = 0;
        }
        break;
    }
  }

  /**
   * Handle successful execution
   */
  private onSuccess(): void {
    this.successCount++;

    metrics.increment('circuit_breaker.success', { name: this.name });

    if (this.state === 'half-open') {
      this.halfOpenAttempts++;

      // If enough successes in half-open, close circuit
      if (this.halfOpenAttempts >= this.config.halfOpenRequests) {
        this.state = 'closed';
        this.failureCount = 0;
        this.successCount = 0;

        logger.info('Circuit breaker closed', {
          name: this.name,
          halfOpenAttempts: this.halfOpenAttempts,
        });

        metrics.increment('circuit_breaker.closed', { name: this.name });
      }
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    metrics.increment('circuit_breaker.failure', { name: this.name });

    if (this.state === 'half-open') {
      // Failure in half-open → back to open
      this.state = 'open';
      this.nextRetryTime = Date.now() + this.config.resetTimeoutMs;

      logger.warn('Circuit breaker re-opened', {
        name: this.name,
        failureCount: this.failureCount,
      });

      metrics.increment('circuit_breaker.reopened', { name: this.name });

    } else if (this.state === 'closed') {
      // Check if should open
      if (this.failureCount >= this.config.failureThreshold) {
        this.state = 'open';
        this.nextRetryTime = Date.now() + this.config.resetTimeoutMs;

        logger.error('Circuit breaker opened', {
          name: this.name,
          failureCount: this.failureCount,
          threshold: this.config.failureThreshold,
        });

        metrics.increment('circuit_breaker.opened', { name: this.name });

        // Emit alert
        this.emitAlert();
      }
    }
  }

  /**
   * Get current circuit state
   */
  getState(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    nextRetryTime: number;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      nextRetryTime: this.nextRetryTime,
    };
  }

  /**
   * Manually reset circuit breaker
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenAttempts = 0;

    logger.info('Circuit breaker manually reset', { name: this.name });
  }

  /**
   * Emit alert when circuit opens
   */
  private emitAlert(): void {
    // Integration with alerting system
    // Could send to Slack, PagerDuty, email, etc.
  }
}

class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Circuit Breaker Manager - Manages multiple circuit breakers
 */
class CircuitBreakerManager {
  private breakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Get or create circuit breaker
   */
  getBreaker(name: string, config?: CircuitBreakerConfig): CircuitBreaker {
    let breaker = this.breakers.get(name);

    if (!breaker) {
      breaker = new CircuitBreaker(name, config || this.getDefaultConfig());
      this.breakers.set(name, breaker);
    }

    return breaker;
  }

  /**
   * Get default config
   */
  private getDefaultConfig(): CircuitBreakerConfig {
    return {
      failureThreshold: 5,
      windowMs: 60000,
      resetTimeoutMs: 60000,
      halfOpenRequests: 3,
    };
  }

  /**
   * Get status of all breakers
   */
  getAllStatus(): Array<{ name: string; state: ReturnType<CircuitBreaker['getState']> }> {
    return Array.from(this.breakers.entries()).map(([name, breaker]) => ({
      name,
      state: breaker.getState(),
    }));
  }
}
```

#### Integration Points

**1. Anthropic API Calls**

```typescript
const anthropicCircuit = circuitBreakerManager.getBreaker('anthropic-api', {
  failureThreshold: 3,
  windowMs: 30000,
  resetTimeoutMs: 60000,
  halfOpenRequests: 2,
});

async function callAnthropicAPI(request: MessageRequest): Promise<MessageResponse> {
  return await anthropicCircuit.execute(async () => {
    return await anthropic.messages.create(request);
  });
}
```

**2. Database Operations**

```typescript
const dbCircuit = circuitBreakerManager.getBreaker('database', {
  failureThreshold: 5,
  windowMs: 60000,
  resetTimeoutMs: 30000,
  halfOpenRequests: 3,
});

async function queryDatabase(query: string): Promise<any> {
  return await dbCircuit.execute(async () => {
    return await db.query(query);
  });
}
```

**3. Channel Processing**

```typescript
async function processChannelMessage(channelId: string, message: Message) {
  const channelCircuit = circuitBreakerManager.getBreaker(`channel:${channelId}`);

  return await channelCircuit.execute(async () => {
    return await executeAgentSession(channelId, message);
  });
}
```

#### Metrics & Monitoring

**Metrics:**
- `circuit_breaker.state` - Gauge (0=closed, 1=half-open, 2=open)
- `circuit_breaker.failure` - Counter of failures
- `circuit_breaker.success` - Counter of successes
- `circuit_breaker.opened` - Counter of circuit opens
- `circuit_breaker.closed` - Counter of circuit closes
- `circuit_breaker.rejected` - Counter of rejected requests

**Dashboard Queries:**
```promql
# Circuit breaker state
circuit_breaker_state{name="anthropic-api"}

# Failure rate
rate(circuit_breaker_failure[5m])

# Rejection rate
rate(circuit_breaker_rejected[5m])
```

---

### Solution 5: Observability & Monitoring

**Objective:** Provide visibility into system health and session state.

#### Metrics Architecture

```typescript
/**
 * Metrics Collector - Centralized metrics collection
 * Location: src/monitoring/metrics.ts (NEW FILE)
 */

interface MetricsCollector {
  // Counters
  increment(name: string, tags?: Record<string, string>): void;

  // Gauges
  gauge(name: string, value: number, tags?: Record<string, string>): void;

  // Histograms
  histogram(name: string, value: number, tags?: Record<string, string>): void;

  // Timers
  timing(name: string, durationMs: number, tags?: Record<string, string>): void;
}

/**
 * Session Metrics - Track session-specific metrics
 */
class SessionMetrics {
  constructor(private metrics: MetricsCollector) {}

  /**
   * Track session start
   */
  sessionStarted(sessionKey: string): void {
    this.metrics.increment('session.started', {
      sessionKey: this.sanitizeKey(sessionKey),
    });
  }

  /**
   * Track session completion
   */
  sessionCompleted(sessionKey: string, durationMs: number): void {
    this.metrics.increment('session.completed', {
      sessionKey: this.sanitizeKey(sessionKey),
    });

    this.metrics.histogram('session.duration', durationMs, {
      sessionKey: this.sanitizeKey(sessionKey),
    });
  }

  /**
   * Track session timeout
   */
  sessionTimedOut(sessionKey: string, age: number): void {
    this.metrics.increment('session.timeout', {
      sessionKey: this.sanitizeKey(sessionKey),
    });

    this.metrics.histogram('session.timeout.age', age, {
      sessionKey: this.sanitizeKey(sessionKey),
    });
  }

  /**
   * Track session size
   */
  sessionSize(sessionKey: string, messageCount: number, sizeBytes: number): void {
    this.metrics.gauge('session.message_count', messageCount, {
      sessionKey: this.sanitizeKey(sessionKey),
    });

    this.metrics.gauge('session.size_bytes', sizeBytes, {
      sessionKey: this.sanitizeKey(sessionKey),
    });
  }

  /**
   * Track active sessions
   */
  activeSessions(count: number): void {
    this.metrics.gauge('session.active', count);
  }

  /**
   * Sanitize session key for metrics
   */
  private sanitizeKey(sessionKey: string): string {
    // Remove sensitive info, keep structure
    return sessionKey.split(':').slice(0, 3).join(':');
  }
}

/**
 * Queue Metrics - Track queue performance
 */
class QueueMetrics {
  constructor(private metrics: MetricsCollector) {}

  /**
   * Track queue depth
   */
  queueDepth(channelId: string, depth: number): void {
    this.metrics.gauge('queue.depth', depth, { channelId });
  }

  /**
   * Track queue processing time
   */
  queueProcessingTime(channelId: string, durationMs: number): void {
    this.metrics.histogram('queue.processing_time', durationMs, { channelId });
  }

  /**
   * Track queue backpressure events
   */
  queueBackpressure(channelId: string): void {
    this.metrics.increment('queue.backpressure', { channelId });
  }

  /**
   * Track message retry
   */
  messageRetry(channelId: string, retryCount: number): void {
    this.metrics.increment('queue.message.retry', {
      channelId,
      retryCount: String(retryCount),
    });
  }
}

/**
 * API Metrics - Track external API calls
 */
class APIMetrics {
  constructor(private metrics: MetricsCollector) {}

  /**
   * Track API call
   */
  apiCall(service: string, method: string, status: number, durationMs: number): void {
    this.metrics.increment('api.call', {
      service,
      method,
      status: String(status),
    });

    this.metrics.histogram('api.duration', durationMs, {
      service,
      method,
    });
  }

  /**
   * Track API error
   */
  apiError(service: string, errorType: string): void {
    this.metrics.increment('api.error', {
      service,
      errorType,
    });
  }

  /**
   * Track API rate limit
   */
  apiRateLimit(service: string): void {
    this.metrics.increment('api.rate_limit', { service });
  }
}
```

#### Health Check Endpoints

```typescript
/**
 * Health Check Handler
 * Location: src/gateway/health.ts (NEW FILE)
 */

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  uptime: number;
  checks: HealthCheck[];
}

interface HealthCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message?: string;
  details?: any;
}

class HealthCheckService {
  private startTime: number = Date.now();

  /**
   * Get overall health status
   */
  async getHealth(): Promise<HealthStatus> {
    const checks: HealthCheck[] = [];

    // Check database connection
    checks.push(await this.checkDatabase());

    // Check Anthropic API
    checks.push(await this.checkAnthropicAPI());

    // Check session health
    checks.push(await this.checkSessions());

    // Check queue health
    checks.push(await this.checkQueues());

    // Check circuit breakers
    checks.push(await this.checkCircuitBreakers());

    // Determine overall status
    const hasFailed = checks.some(c => c.status === 'fail');
    const hasWarning = checks.some(c => c.status === 'warn');

    const status = hasFailed ? 'unhealthy'
                 : hasWarning ? 'degraded'
                 : 'healthy';

    return {
      status,
      timestamp: Date.now(),
      uptime: Date.now() - this.startTime,
      checks,
    };
  }

  /**
   * Check database health
   */
  private async checkDatabase(): Promise<HealthCheck> {
    try {
      await db.query('SELECT 1');
      return {
        name: 'database',
        status: 'pass',
      };
    } catch (err) {
      return {
        name: 'database',
        status: 'fail',
        message: err.message,
      };
    }
  }

  /**
   * Check Anthropic API health
   */
  private async checkAnthropicAPI(): Promise<HealthCheck> {
    const breaker = circuitBreakerManager.getBreaker('anthropic-api');
    const state = breaker.getState();

    if (state.state === 'open') {
      return {
        name: 'anthropic-api',
        status: 'fail',
        message: 'Circuit breaker is open',
        details: state,
      };
    }

    if (state.state === 'half-open') {
      return {
        name: 'anthropic-api',
        status: 'warn',
        message: 'Circuit breaker is half-open',
        details: state,
      };
    }

    return {
      name: 'anthropic-api',
      status: 'pass',
    };
  }

  /**
   * Check session health
   */
  private async checkSessions(): Promise<HealthCheck> {
    const watchdog = sessionWatchdog.getStatus();

    // Check for stuck sessions
    const stuck = watchdog.sessions.filter(s => s.age > 300000); // 5 minutes

    if (stuck.length > 0) {
      return {
        name: 'sessions',
        status: 'fail',
        message: `${stuck.length} stuck sessions detected`,
        details: { stuck },
      };
    }

    // Check for high session count
    if (watchdog.monitoredSessions > 100) {
      return {
        name: 'sessions',
        status: 'warn',
        message: `High session count: ${watchdog.monitoredSessions}`,
        details: { count: watchdog.monitoredSessions },
      };
    }

    return {
      name: 'sessions',
      status: 'pass',
      details: { active: watchdog.monitoredSessions },
    };
  }

  /**
   * Check queue health
   */
  private async checkQueues(): Promise<HealthCheck> {
    const queues = channelQueueManager.getStatus();

    // Check for backed up queues
    const backedUp = queues.filter(q => q.depth > 50);

    if (backedUp.length > 0) {
      return {
        name: 'queues',
        status: 'warn',
        message: `${backedUp.length} queues backed up`,
        details: { backedUp },
      };
    }

    return {
      name: 'queues',
      status: 'pass',
      details: { totalQueues: queues.length },
    };
  }

  /**
   * Check circuit breaker health
   */
  private async checkCircuitBreakers(): Promise<HealthCheck> {
    const breakers = circuitBreakerManager.getAllStatus();

    const open = breakers.filter(b => b.state.state === 'open');

    if (open.length > 0) {
      return {
        name: 'circuit-breakers',
        status: 'warn',
        message: `${open.length} circuit breakers open`,
        details: { open },
      };
    }

    return {
      name: 'circuit-breakers',
      status: 'pass',
      details: { total: breakers.length },
    };
  }
}

/**
 * HTTP endpoint for health checks
 */
app.get('/health', async (req, res) => {
  const health = await healthCheckService.getHealth();

  const statusCode = health.status === 'healthy' ? 200
                    : health.status === 'degraded' ? 200
                    : 503;

  res.status(statusCode).json(health);
});

/**
 * Liveness probe (for k8s)
 */
app.get('/health/live', async (req, res) => {
  // Just check if process is alive
  res.status(200).json({ status: 'alive' });
});

/**
 * Readiness probe (for k8s)
 */
app.get('/health/ready', async (req, res) => {
  const health = await healthCheckService.getHealth();

  const ready = health.status !== 'unhealthy';

  res.status(ready ? 200 : 503).json({
    ready,
    status: health.status,
  });
});
```

#### Metrics Dashboard

**Grafana Dashboard JSON** (`monitoring/dashboards/session-health.json`)

```json
{
  "dashboard": {
    "title": "Session Health Dashboard",
    "panels": [
      {
        "title": "Active Sessions",
        "targets": [
          {
            "expr": "session_active"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Session Processing Time (p95)",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, session_duration)"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Session Timeouts",
        "targets": [
          {
            "expr": "rate(session_timeout[5m])"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Queue Depth by Channel",
        "targets": [
          {
            "expr": "queue_depth"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Circuit Breaker State",
        "targets": [
          {
            "expr": "circuit_breaker_state"
          }
        ],
        "type": "stat"
      },
      {
        "title": "API Error Rate",
        "targets": [
          {
            "expr": "rate(api_error[5m])"
          }
        ],
        "type": "graph"
      }
    ]
  }
}
```

---

## Implementation Phases

### Phase 1: Immediate Stabilization (Week 1-2)

**Goal:** Stop the bleeding - prevent stuck sessions from taking down the gateway.

**Deliverables:**
1. Session Watchdog implementation
2. Basic timeout enforcement (5 minutes)
3. AbortController integration in agent runs
4. Monitoring dashboard for session age

**Success Criteria:**
- No stuck sessions > 5 minutes
- Gateway restarts reduced from daily to < 1 per week
- Session timeout metrics visible in dashboard

**Effort:** 3-5 days
**Risk:** Low
**Priority:** P0

---

### Phase 2: Queue Isolation (Week 3-4)

**Goal:** Prevent one channel from blocking others.

**Deliverables:**
1. Channel Queue Manager implementation
2. Per-channel worker pools
3. Migration from sequential to parallel processing
4. Queue depth monitoring

**Success Criteria:**
- Stuck session in one channel doesn't block others
- Queue backpressure metrics available
- Graceful degradation under load

**Effort:** 5-7 days
**Risk:** Medium (architecture change)
**Priority:** P0

---

### Phase 3: Circuit Breakers (Week 5-6)

**Goal:** Prevent cascade failures from external services.

**Deliverables:**
1. Circuit Breaker implementation
2. Integration with Anthropic API calls
3. Integration with database calls
4. Circuit state monitoring

**Success Criteria:**
- Anthropic outages don't crash gateway
- Circuit state visible in monitoring
- Automatic recovery from transient failures

**Effort:** 3-5 days
**Risk:** Low
**Priority:** P1

---

### Phase 4: Session Summarization (Week 7-10)

**Goal:** Prevent unbounded session growth.

**Deliverables:**
1. Session Summarizer implementation
2. Background maintenance job
3. Summarization metrics
4. Configuration for thresholds

**Success Criteria:**
- No sessions > 5MB
- Session size metrics trending down
- Atlas atlas-dm performance restored

**Effort:** 7-10 days
**Risk:** Medium (LLM quality dependency)
**Priority:** P1

---

### Phase 5: Advanced Monitoring (Week 11-12)

**Goal:** Full observability into system health.

**Deliverables:**
1. Complete metrics collection
2. Health check endpoints
3. Grafana dashboards
4. Alerting rules

**Success Criteria:**
- All key metrics visible
- Alerts firing before user impact
- Dashboard used in incident response

**Effort:** 5-7 days
**Risk:** Low
**Priority:** P2

---

## Migration Strategy

### Backwards Compatibility

**Feature Flags:**
```json
{
  "gateway": {
    "features": {
      "sessionWatchdog": true,
      "channelQueues": false,  // Gradual rollout
      "circuitBreakers": true,
      "sessionSummarization": true
    }
  }
}
```

**Gradual Rollout:**
```typescript
// Week 1: Watchdog only (monitoring mode)
config.gateway.session.watchdog.enabled = true;
config.gateway.session.watchdog.monitorOnly = true; // Don't abort yet

// Week 2: Watchdog enforcement
config.gateway.session.watchdog.monitorOnly = false;

// Week 3: Enable channel queues for test channels
config.gateway.channelQueues.enabled = true;
config.gateway.channelQueues.allowlist = ['test-channel-id'];

// Week 4: Enable for all channels
config.gateway.channelQueues.allowlist = null; // All channels
```

### Data Migration

**Session File Format:**
```typescript
// Old format (unchanged)
interface LegacySession {
  messages: Message[];
}

// New format (with metadata)
interface Session {
  messages: Message[];
  metadata: {
    createdAt: number;
    lastSummarizedAt?: number;
    summarizationCount?: number;
    version: number;
  };
}

// Transparent migration
function loadSession(path: string): Session {
  const data = JSON.parse(fs.readFileSync(path, 'utf-8'));

  // Migrate legacy format
  if (!data.metadata) {
    return {
      messages: data.messages || data,
      metadata: {
        createdAt: fs.statSync(path).birthtime.getTime(),
        version: 1,
      },
    };
  }

  return data;
}
```

### Rollback Plan

**Quick Rollback:**
```bash
# Disable all new features
moltbot config patch --raw '{
  "gateway": {
    "features": {
      "sessionWatchdog": false,
      "channelQueues": false,
      "circuitBreakers": false,
      "sessionSummarization": false
    }
  }
}'

# Restart gateway
moltbot gateway restart
```

**Data Rollback:**
- Session summaries are additive (old messages preserved in archive)
- Queue state persisted to disk (can replay on restart)
- Circuit breaker state is in-memory (resets on restart)

---

## Testing Strategy

### Unit Tests

**Watchdog Tests:**
```typescript
describe('SessionWatchdog', () => {
  it('should abort session after timeout', async () => {
    const watchdog = new SessionWatchdog({
      maxProcessingTimeMs: 1000,
      checkIntervalMs: 100,
    });

    const abortController = new AbortController();
    watchdog.startMonitoring('test-session', abortController);

    await sleep(1500);

    expect(abortController.signal.aborted).toBe(true);
  });

  it('should not abort session before timeout', async () => {
    const watchdog = new SessionWatchdog({
      maxProcessingTimeMs: 5000,
      checkIntervalMs: 100,
    });

    const abortController = new AbortController();
    watchdog.startMonitoring('test-session', abortController);

    await sleep(1000);

    expect(abortController.signal.aborted).toBe(false);

    watchdog.stopMonitoring('test-session');
  });
});
```

**Circuit Breaker Tests:**
```typescript
describe('CircuitBreaker', () => {
  it('should open after threshold failures', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      windowMs: 60000,
      resetTimeoutMs: 60000,
    });

    // Fail 3 times
    for (let i = 0; i < 3; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error('Simulated failure');
        });
      } catch (err) {
        // Expected
      }
    }

    expect(breaker.getState().state).toBe('open');
  });

  it('should transition to half-open after timeout', async () => {
    const breaker = new CircuitBreaker('test', {
      failureThreshold: 2,
      windowMs: 60000,
      resetTimeoutMs: 1000, // 1 second
    });

    // Open circuit
    for (let i = 0; i < 2; i++) {
      try {
        await breaker.execute(async () => {
          throw new Error('Fail');
        });
      } catch (err) {}
    }

    expect(breaker.getState().state).toBe('open');

    // Wait for reset timeout
    await sleep(1500);

    expect(breaker.getState().state).toBe('half-open');
  });
});
```

### Integration Tests

**End-to-End Timeout Test:**
```typescript
describe('Session Timeout Integration', () => {
  it('should abort long-running session', async () => {
    // Configure watchdog with short timeout
    const config = {
      session: {
        watchdog: {
          maxProcessingTimeMs: 2000,
          checkIntervalMs: 500,
        },
      },
    };

    // Start gateway with config
    const gateway = await startGateway(config);

    // Send message that will hang
    const result = await gateway.sendMessage({
      channel: 'test-channel',
      content: 'Run infinite loop',
    });

    // Should timeout and return error
    expect(result.error).toContain('timeout');
    expect(result.duration).toBeLessThan(3000);

    await gateway.stop();
  });
});
```

**Queue Isolation Test:**
```typescript
describe('Channel Queue Isolation', () => {
  it('should not block other channels when one is stuck', async () => {
    const queueManager = new ChannelQueueManager({
      workersPerChannel: 1,
      maxQueueDepth: 100,
    });

    // Block channel A with stuck message
    const channelA = 'stuck-channel';
    const channelB = 'working-channel';

    queueManager.enqueue(channelA, {
      id: '1',
      content: 'Hang forever',
      handler: async () => {
        await sleep(999999);
      },
    });

    // Message to channel B should still process
    const startTime = Date.now();

    await queueManager.enqueue(channelB, {
      id: '2',
      content: 'Normal message',
      handler: async () => {
        return 'Success';
      },
    });

    const duration = Date.now() - startTime;

    // Should complete quickly despite channel A being stuck
    expect(duration).toBeLessThan(1000);
  });
});
```

### Load Tests

**Stress Test:**
```typescript
describe('Load Test', () => {
  it('should handle 1000 concurrent messages', async () => {
    const gateway = await startGateway();

    const messages = Array.from({ length: 1000 }, (_, i) => ({
      channel: `channel-${i % 10}`,
      content: `Message ${i}`,
    }));

    const startTime = Date.now();

    const results = await Promise.all(
      messages.map(msg => gateway.sendMessage(msg))
    );

    const duration = Date.now() - startTime;

    const successful = results.filter(r => !r.error).length;

    expect(successful).toBeGreaterThan(950); // 95% success rate
    expect(duration).toBeLessThan(60000); // Complete in 1 minute

    await gateway.stop();
  });
});
```

---

## Monitoring & Alerting

### Key Metrics

**Session Health:**
```
session.active                          # Active session count
session.duration                        # Processing time distribution
session.timeout                         # Timeout count
session.timeout.age                     # Age at timeout
session.message_count                   # Messages per session
session.size_bytes                      # Session size
```

**Queue Health:**
```
queue.depth{channelId}                  # Messages waiting
queue.processing_time                   # Time to process
queue.backpressure                      # Backpressure events
queue.message.retry                     # Retry count
```

**Circuit Breaker:**
```
circuit_breaker.state                   # 0=closed, 1=half-open, 2=open
circuit_breaker.failure                 # Failure count
circuit_breaker.success                 # Success count
circuit_breaker.rejected                # Rejected requests
```

**API Health:**
```
api.call{service,method,status}         # API call count
api.duration{service,method}            # API latency
api.error{service,errorType}            # Error count
api.rate_limit{service}                 # Rate limit hits
```

### Alert Rules

**Critical Alerts:**

```yaml
# Session stuck for > 3 minutes
- alert: SessionStuckCritical
  expr: max(session_age_seconds) > 180
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "Session stuck for >3 minutes"
    description: "Session {{ $labels.sessionKey }} has been processing for {{ $value }}s"

# Circuit breaker open
- alert: CircuitBreakerOpen
  expr: circuit_breaker_state == 2
  for: 2m
  labels:
    severity: critical
  annotations:
    summary: "Circuit breaker {{ $labels.name }} is open"
    description: "Service {{ $labels.name }} is experiencing failures"

# Queue backed up
- alert: QueueBackedUp
  expr: queue_depth > 50
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Queue {{ $labels.channelId }} backed up"
    description: "Queue depth is {{ $value }}"
```

**Warning Alerts:**

```yaml
# High session count
- alert: HighSessionCount
  expr: session_active > 100
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "High active session count"
    description: "{{ $value }} active sessions"

# Slow API calls
- alert: SlowAPIResponse
  expr: histogram_quantile(0.95, api_duration) > 10000
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Slow {{ $labels.service }} API responses"
    description: "p95 latency is {{ $value }}ms"
```

---

## Rollout Plan

### Week 1-2: Phase 1 (Watchdog)

**Monday-Tuesday:**
- Implement SessionWatchdog class
- Add AbortController integration
- Write unit tests

**Wednesday-Thursday:**
- Integration testing
- Monitoring dashboard setup
- Documentation

**Friday:**
- Deploy to staging
- Enable monitoring mode (no enforcement)
- Collect baseline metrics

**Weekend:**
- Monitor staging behavior
- Review metrics

**Monday Week 2:**
- Enable enforcement in staging
- Test timeout behavior

**Wednesday Week 2:**
- Production deployment (monitoring mode)
- Gradual rollout to 10% traffic

**Friday Week 2:**
- Enable enforcement in production
- Monitor for issues

### Week 3-4: Phase 2 (Queue Isolation)

**Monday-Wednesday:**
- Implement ChannelQueueManager
- Add per-channel workers
- Write unit tests

**Thursday-Friday:**
- Integration testing
- Load testing
- Performance validation

**Monday Week 4:**
- Deploy to staging
- Enable for test channels

**Wednesday Week 4:**
- Production deployment
- Enable for 25% of channels

**Friday Week 4:**
- Increase to 100% of channels
- Monitor performance

### Week 5-6: Phase 3 (Circuit Breakers)

**Similar pattern to Phase 2**

### Week 7-10: Phase 4 (Summarization)

**Extended timeline for LLM quality validation**

---

## Success Criteria

### Quantitative Goals

**Availability:**
- Gateway uptime: >99.9%
- Mean time between failures: >7 days
- Mean time to recovery: <30 seconds (automatic)

**Performance:**
- Session processing time p95: <5 seconds
- Queue depth per channel: <10 messages
- No sessions >5 minutes processing time

**Reliability:**
- Circuit breaker activations: <5 per day
- Session timeout rate: <1% of total sessions
- Message retry rate: <0.1%

### Qualitative Goals

- Incidents requiring manual intervention reduced by 90%
- On-call pages for stuck sessions: 0
- User-reported "bot is down" issues: <1 per week
- Development velocity unblocked (no daily restarts)

---

## Risk Assessment

### High-Risk Items

**1. Session Timeout False Positives**
- **Risk:** Legitimate long-running operations get killed
- **Mitigation:** Start with generous timeout (5 min), tune down gradually
- **Rollback:** Disable watchdog enforcement

**2. Queue Migration Breaking Ordering**
- **Risk:** Message ordering guarantees broken in migration
- **Mitigation:** Gradual rollout, extensive testing, fallback to sequential
- **Rollback:** Feature flag to disable channel queues

**3. Summarization Quality**
- **Risk:** Important context lost in summarization
- **Mitigation:** Extensive testing, user feedback, manual review
- **Rollback:** Disable summarization, restore from archives

### Medium-Risk Items

**1. Circuit Breaker Tuning**
- **Risk:** Too sensitive = unnecessary failures, too loose = no protection
- **Mitigation:** Start conservative, tune based on metrics
- **Rollback:** Disable circuit breakers

**2. Performance Overhead**
- **Risk:** Additional monitoring/processing slows system
- **Mitigation:** Performance testing, optimization
- **Rollback:** Disable expensive features

---

## File Organization

### New Files

```
src/
├── gateway/
│   ├── session-watchdog.ts          # Session timeout monitoring
│   ├── session-summarizer.ts        # Session summarization
│   ├── channel-queue-manager.ts     # Per-channel queues
│   ├── circuit-breaker.ts           # Circuit breaker pattern
│   ├── session-maintenance.ts       # Background jobs
│   └── health.ts                    # Health check endpoints
│
├── monitoring/
│   ├── metrics.ts                   # Metrics collection
│   ├── session-metrics.ts           # Session-specific metrics
│   ├── queue-metrics.ts             # Queue-specific metrics
│   └── api-metrics.ts               # API metrics
│
└── types/
    └── session.ts                   # Updated session types

monitoring/
├── dashboards/
│   ├── session-health.json          # Grafana dashboard
│   └── circuit-breakers.json        # Circuit breaker dashboard
│
└── alerts/
    └── session-alerts.yml           # Alert rules

tests/
├── unit/
│   ├── session-watchdog.test.ts
│   ├── circuit-breaker.test.ts
│   └── session-summarizer.test.ts
│
└── integration/
    ├── timeout-integration.test.ts
    ├── queue-isolation.test.ts
    └── load-test.test.ts

docs/
└── IMPLEMENTATION-PLAN-SESSION-RESILIENCE.md  # This file
```

### Modified Files

```
src/gateway/
├── server-chat.ts                   # Add watchdog integration
└── session-utils.ts                 # Add summarization hooks

src/agents/
└── run.ts                           # Add AbortSignal support

src/agents/tools/
└── *.ts                             # Add timeout support

moltbot.json                         # Add new config sections
```

---

## Appendix: Configuration Reference

### Complete Configuration Schema

```typescript
interface GatewayConfig {
  session: {
    // Session Watchdog
    watchdog: {
      enabled: boolean;                      // Default: true
      maxProcessingTimeMs: number;           // Default: 300000 (5 min)
      checkIntervalMs: number;               // Default: 10000
      abortGracePeriodMs: number;            // Default: 5000
      autoRestart: boolean;                  // Default: false
      monitorOnly: boolean;                  // Default: false (for testing)
    };

    // Session Summarization
    summarization: {
      enabled: boolean;                      // Default: true
      maxMessages: number;                   // Default: 1000
      maxSizeBytes: number;                  // Default: 5MB
      keepRecentMessages: number;            // Default: 200
      summaryModel: string;                  // Default: 'claude-haiku-3-5'
      maintenanceInterval: number;           // Default: 3600000 (1 hour)
    };
  };

  // Channel Queues
  channelQueues: {
    enabled: boolean;                        // Default: false (gradual rollout)
    workersPerChannel: number;               // Default: 1
    maxQueueDepth: number;                   // Default: 100
    enablePriority: boolean;                 // Default: false
    laneLockTimeoutMs: number;               // Default: 30000
    allowlist: string[] | null;              // Default: null (all channels)
  };

  // Circuit Breakers
  circuitBreakers: {
    enabled: boolean;                        // Default: true

    // Per-service configs
    anthropic: {
      failureThreshold: number;              // Default: 3
      windowMs: number;                      // Default: 30000
      resetTimeoutMs: number;                // Default: 60000
      halfOpenRequests: number;              // Default: 2
    };

    database: {
      failureThreshold: number;              // Default: 5
      windowMs: number;                      // Default: 60000
      resetTimeoutMs: number;                // Default: 30000
      halfOpenRequests: number;              // Default: 3
    };
  };

  // Monitoring
  monitoring: {
    enabled: boolean;                        // Default: true
    metricsPort: number;                     // Default: 9090
    healthCheckPort: number;                 // Default: 8080
  };
}
```

---

## Conclusion

This implementation plan provides a comprehensive roadmap to eliminate stuck sessions and improve system resilience. The phased approach allows for gradual rollout with minimal risk, while the extensive testing and monitoring ensure we can detect and respond to issues quickly.

**Key Success Factors:**
1. Incremental deployment with feature flags
2. Extensive monitoring and metrics
3. Quick rollback capabilities
4. Thorough testing at each phase
5. Clear success criteria and measurement

**Timeline Summary:**
- Phase 1 (Watchdog): Weeks 1-2
- Phase 2 (Queue Isolation): Weeks 3-4
- Phase 3 (Circuit Breakers): Weeks 5-6
- Phase 4 (Summarization): Weeks 7-10
- Phase 5 (Monitoring): Weeks 11-12

**Total Duration:** ~12 weeks for complete implementation

**Expected Outcome:**
- 99.9%+ uptime
- Zero manual interventions for stuck sessions
- Automatic recovery from failures
- Full observability into system health

---

## Belvedere Commentary & Recommended Adjustments

**Date:** 2026-02-06  
**Reviewer:** Belvedere (Personal Assistant Agent)

### Overall Assessment

This is **excellent production-grade engineering** with correct root cause analysis and comprehensive solutions. The 5-solution approach is sound. However, for a small team experiencing daily operational pain, the 12-week timeline presents a risk/reward tradeoff worth examining.

### What's Critical (Do First)

**Phase 1 (Session Watchdog) is THE priority:**
- Solves the "775-second stuck session kills entire gateway" problem
- Production-ready code examples provided
- Low risk, high impact
- **Recommendation: Execute exactly as specified, Week 1-2**

### What Can Be Simplified

#### Problem 1: Unbounded Session Growth (Atlas 16MB session)

**Current Plan (Phase 4):** LLM-based summarization with Claude Haiku, background maintenance jobs, 7-10 day implementation.

**Alternative (Simpler):** Session archiving without LLM
```typescript
// Check session size on save
if (sessionSize > 5MB || messageCount > 1000) {
  // Archive current session
  await archiveSession(sessionKey);
  
  // Start fresh with brief context note
  newSession.messages = [
    {
      role: 'system',
      content: `Previous session archived (${messageCount} messages, ${sizeFormatted}). 
                Recent context available in Discord history.`
    }
  ];
}
```

**Tradeoffs:**
- **Pro:** 1-2 day implementation vs. 7-10 days
- **Pro:** No API cost, no LLM quality risk
- **Pro:** Simple rollback (just disable archiving)
- **Con:** Agents lose deep history (but Discord history remains)
- **Con:** Less "intelligent" than LLM summarization

**Recommendation:** 
- Start with simple archiving in Phase 4a (Week 7-8)
- If agents need smarter context preservation, add LLM summarization in Phase 4b (Week 9-10)
- Measure first, then optimize

#### Problem 2: Shared Queue Blocking

**Current Plan (Phase 2):** Per-channel queue isolation with worker pools, dead letter queues, retry logic.

**Question:** Do we have evidence this is needed after Phase 1?

**Data to collect (post-Phase 1):**
- How often do multiple channels have messages waiting simultaneously?
- Does one stuck channel still block others after watchdog enforcement?
- What's our actual concurrency pattern?

**Recommendation:**
- Deploy Phase 1 (watchdog)
- Instrument queue behavior for 1-2 weeks
- **Only implement Phase 2 if data shows it's needed**
- May discover watchdog alone solves 95% of pain

### Proposed Adjusted Timeline

#### Immediate (Week 1-2): Critical Fix
- **Phase 1 (Watchdog)** — Full implementation as specified
- **Session Size Alerts** — Simple metric tracking (no action yet)
- **Deploy to production** with feature flags

#### Short-term (Week 3-4): Measure & Stabilize
- **Monitor Phase 1 effectiveness**
- **Collect queue behavior data**
- **Simple session archiving** (if size issues persist)
- **Decide on Phase 2 necessity** based on real data

#### Medium-term (Week 5-8): Hardening (if needed)
- **Phase 2 (Queue Isolation)** — Only if data justifies
- **Phase 3 (Circuit Breakers)** — If external API failures are frequent
- **Phase 4a (Session Archiving)** — Simple version

#### Long-term (Week 9-12): Polish (if needed)
- **Phase 4b (LLM Summarization)** — If archiving proves insufficient
- **Phase 5 (Advanced Monitoring)** — When breathing room exists

### Risk Analysis: Minimal vs. Comprehensive

**12-Week Comprehensive Plan:**
- ✅ Production-grade from day one
- ✅ Handles all edge cases
- ❌ 3 months of daily operational pain
- ❌ Over-engineering risk (solving problems we don't have)

**Aggressive 2-4 Week Plan:**
- ✅ Stops the bleeding immediately
- ✅ Lets data drive further decisions
- ❌ May need Phase 2/3 later if Phase 1 insufficient
- ❌ Less "complete" architecture

### Questions for Claude Code

1. **Session archiving vs. summarization:** Can Phase 4 be split into 4a (simple archiving) and 4b (LLM summarization)?
2. **Queue isolation necessity:** Do we have data showing per-channel queues are required, or is this proactive architecture?
3. **Phased deployment risk:** What breaks if we do Phase 1 only and it turns out to be sufficient?
4. **Rollback complexity:** How hard is it to back out Phase 2 (queue isolation) if it causes issues?

### Recommendation to Gigi

**Week 1-2:** Phase 1 only. Stop sessions from hanging forever.

**Week 3:** Assess:
- Did Phase 1 solve 90%+ of problems?
- What failure modes remain?
- Is queue isolation actually needed?

**Week 4+:** Data-driven decision on Phases 2-5.

**Rationale:** 
- We're living with daily instability now
- Phase 1 targets the root cause (no timeouts)
- Phases 2-5 are valuable but possibly overkill
- Better to fix critical + measure than commit to 12 weeks sight unseen

### What I Love About This Plan

1. **Production-ready code** — Can copy-paste and ship
2. **Feature flags everywhere** — Safe rollout
3. **Testing strategy** — Unit, integration, load tests
4. **Metrics & monitoring** — Real observability
5. **Honest timelines** — No hand-waving

This is serious engineering. My feedback is purely about **sequencing risk vs. reward** for a team experiencing daily pain.

---

**Status:** Ready for review. Pin this for when we have bandwidth to execute.

