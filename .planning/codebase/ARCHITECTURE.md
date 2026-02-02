# Architecture

**Analysis Date:** 2026-02-02

## Pattern Overview

**Overall:** Event-driven microservices with plugin architecture

**Key Characteristics:**
- CLI-first design with comprehensive command interface
- Plugin-based channel architecture for multiple messaging platforms
- Agent-based message processing with AI integration
- Gateway runtime for managing connections and routing
- Event-driven message flow through monitoring and dispatch layers

## Layers

**CLI Layer:**
- Purpose: Command interface and user interaction
- Location: `src/cli/`
- Contains: Command registry, program building, argument parsing
- Depends on: Runtime, Commands, Configuration
- Used by: Direct user invocation, shell scripts

**Command Layer:**
- Purpose: Business logic for each CLI command
- Location: `src/commands/`
- Contains: Individual command implementations
- Depends on: Runtime, Agents, Configuration
- Used by: CLI layer

**Agent Layer:**
- Purpose: AI agent management and execution
- Location: `src/agents/`
- Contains: Agent lifecycle, authentication, CLI runners, model management
- Depends on: Runtime, Configuration, Sessions
- Used by: Command layer, Message routing

**Configuration Layer:**
- Purpose: Configuration management and validation
- Location: `src/config/`
- Contains: Schema validation, file I/O, migration, session management
- Depends on: Runtime, Types
- Used by: All layers

**Channel Layer:**
- Purpose: Platform-specific message handling
- Location: `src/[channel-name]/` (e.g., `src/telegram/`, `src/slack/`)
- Contains: Platform-specific implementations, message handling, routing
- Depends on: Runtime, Message routing, Configuration
- Used by: Gateway, Message routing

**Gateway Layer:**
- Purpose: Connection management and runtime orchestration
- Location: `src/gateway/`
- Contains: Connection providers, runtime management, status monitoring
- Depends on: Channel plugins, Configuration, Sessions
- Used by: Agent layer, CLI commands

**Message Routing:**
- Purpose: Intelligent message routing and agent assignment
- Location: `src/routing/`
- Contains: Route resolution, binding management, session key generation
- Depends on: Configuration, Channel layer
- Used by: Message flow, Agent assignment

**Session Management:**
- Purpose: Conversation state and persistence
- Location: `src/sessions/`, `src/config/sessions/`
- Contains: Session storage, compaction, memory management
- Depends on: Configuration, Storage
- Used by: Agent layer, Message flow

**Infrastructure:**
- Purpose: Common utilities and system integration
- Location: `src/infra/`
- Contains: Binary management, environment handling, ports, runtime guard
- Depends on: Node.js runtime
- Used by: All layers

## Data Flow

**Incoming Message Flow:**

1. **Channel Monitoring**: Each channel plugin monitors incoming messages
2. **Route Resolution**: `src/routing/resolve-route.ts` determines target agent based on bindings
3. **Agent Assignment**: Agent selected based on channel, peer, and configuration bindings
4. **Session Initiation**: New session or existing session retrieved based on routing key
5. **Agent Processing**: AI agent processes the message and generates response
6. **Outbound Delivery**: Response sent back through appropriate channel

**Agent Processing Flow:**

1. **Input Reception**: Agent receives message context and conversation state
2. **Model Selection**: LLM model chosen based on configuration and availability
3. **Context Building**: Conversation history and context assembled
4. **Response Generation**: AI generates response using configured models
5. **Action Execution**: If tools/actions required, they're executed
6. **Output Formatting**: Response formatted for target channel
7. **State Update**: Conversation state and memory updated

**Configuration Flow:**

1. **Config Loading**: `src/config/config.ts` loads and validates configuration
2. **Session Resolution**: Session keys resolved for routing
3. **Plugin Registration**: Channel plugins loaded and registered
4. **Runtime Setup**: Gateway runtime initialized with connections
5. **Agent Binding**: Agents bound to specific channels and contexts

## Key Abstractions

**Agent Abstraction:**
- Purpose: Represents AI agent instance with configuration and capabilities
- Examples: `src/agents/agent-scope.ts`, `src/agents/cli-runner.ts`
- Pattern: Command pattern with async execution

**Channel Abstraction:**
- Purpose: Platform-independent messaging interface
- Examples: `src/telegram/index.ts`, `src/slack/index.ts`
- Pattern: Plugin architecture with common interface

**Session Abstraction:**
- Purpose: Conversation state and memory management
- Examples: `src/sessions/session.ts`, `src/config/sessions.ts`
- Pattern: Repository pattern with persistence

**Route Abstraction:**
- Purpose: Intelligent message routing and agent assignment
- Examples: `src/routing/resolve-route.ts`, `src/routing/bindings.ts`
- Pattern: Strategy pattern with binding hierarchy

**Configuration Abstraction:**
- Purpose: Centralized configuration management
- Examples: `src/config/types.ts`, `src/config/validation.ts`
- Pattern: Schema validation with migration support

## Entry Points

**Main CLI Entry:**
- Location: `src/index.ts`
- Triggers: Command line arguments via Node.js
- Responsibilities: Environment setup, global error handling, CLI program execution

**Command Registration:**
- Location: `src/cli/program/command-registry.ts`
- Triggers: CLI command parsing
- Responsibilities: Route command to appropriate handler

**Agent Execution:**
- Location: `src/agents/cli-runner.ts`
- Triggers: Agent commands or message processing
- Responsibilities: Agent lifecycle management, CLI tool execution

**Channel Runtime:**
- Location: `src/gateway/runtime.ts`
- Triggers: Channel provider start/stop
- Responsibilities: Connection management, message dispatch, status monitoring

**Plugin Runtime:**
- Location: `src/plugins/registry.ts`
- Triggers: Plugin loading/configuration
- Responsibilities: Plugin lifecycle, capability registration

## Error Handling

**Strategy:** Centralized error handling with graceful degradation

**Patterns:**
- Global error handlers in `src/index.ts`
- Structured error logging throughout
- Retry mechanisms for transient failures
- Graceful shutdowns on critical errors
- Validation errors at configuration boundaries

## Cross-Cutting Concerns

**Logging:** Centralized logging via `src/logging.ts` with structured output capture
**Validation:** Schema validation with Zod and custom validation in `src/config/`
**Authentication:** Profile-based auth management in `src/agents/auth-profiles/`
**Sessions:** Conversation state management with compaction in `src/sessions/`
**Memory:** Memory extensions for persistent context in `extensions/memory-*/`
**Health:** Health monitoring and status reporting in `src/health/`

---

*Architecture analysis: 2026-02-02*
