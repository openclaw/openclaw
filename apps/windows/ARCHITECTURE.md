# OpenClaw-Windows Architecture Guide

## Overview

OpenClaw-Windows is a modular desktop application built with:
- **Backend**: Rust with Tauri 2
- **Frontend**: React 19 + TypeScript
- **UI**: Fluent UI Components
- **State Management**: XState for setup flow, React hooks for UI state

## Project Structure

```
OpenClaw-Windows/
├── src-tauri/                    # Backend (Rust + Tauri)
│   ├── src/
│   │   ├── error.rs             # Error types and recovery utilities
│   │   ├── lib.rs               # Entry point and service initialization
│   │   ├── main.rs              # Binary entry point
│   │   ├── gateway/             # Gateway authentication and protocol
│   │   │   ├── auth.rs          # ED25519 signing and credential handling
│   │   │   ├── client.rs        # WebSocket client implementation
│   │   │   ├── config.rs        # Gateway configuration
│   │   │   ├── discovery.rs     # Gateway discovery (mDNS)
│   │   │   ├── openclaw_config.rs
│   │   │   └── mod.rs
│   │   ├── models/              # Data structures
│   │   │   ├── config.rs        # Application configuration schema
│   │   │   ├── exec_approvals.rs # Execution approval models
│   │   │   └── mod.rs
│   │   ├── providers/           # Hardware/OS abstraction layer
│   │   │   ├── audio.rs         # Audio device management
│   │   │   ├── config.rs        # Configuration file I/O
│   │   │   ├── media.rs         # Camera and screen recording
│   │   │   ├── speech.rs        # Windows Speech Recognition API
│   │   │   ├── system.rs        # PTY and command execution
│   │   │   ├── wsl.rs           # WSL command integration
│   │   │   └── mod.rs
│   │   ├── screens/             # Event handlers for UI screens
│   │   │   ├── dashboard.rs
│   │   │   ├── notification.rs
│   │   │   ├── settings.rs
│   │   │   ├── setup.rs
│   │   │   └── mod.rs
│   │   └── services/            # Business logic and coordination
│   │       ├── config.rs        # Configuration loading/saving with caching
│   │       ├── cron.rs          # Scheduled task management
│   │       ├── discovery.rs     # Gateway discovery service
│   │       ├── events.rs        # Event dispatcher for IPC
│   │       ├── exec_approvals.rs # Execution approval UI and validation
│   │       ├── gateway.rs       # Gateway connection management
│   │       ├── gateway_watcher.rs # Gateway status monitoring
│   │       ├── install.rs       # WSL installation orchestration
│   │       ├── install_handlers.rs # Installation event handlers
│   │       ├── instances.rs     # Instance/machine management
│   │       ├── invoke.rs        # Command invocation from gateway
│   │       ├── media.rs         # Media capture coordination
│   │       ├── permissions.rs   # Permission validation
│   │       ├── runtime.rs       # Background service lifecycle
│   │       ├── sessions.rs      # User session management
│   │       ├── settings.rs      # Settings UI handlers
│   │       ├── skills.rs        # Skill management
│   │       ├── system.rs        # System information and terminals
│   │       ├── talk.rs          # Audio conversation handling
│   │       ├── tray_menu.rs     # System tray menu logic
│   │       ├── voice_wake.rs    # Voice wake and PTT handling
│   │       └── mod.rs
│   ├── Cargo.toml               # Rust dependencies
│   └── tauri.conf.json          # Tauri app configuration
├── src/                         # Frontend (React + TypeScript)
│   ├── main.tsx                 # App entry point with theme setup
│   ├── router.tsx               # Route definitions and lazy loading
│   ├── global.css               # Global styles
│   ├── components/              # Reusable UI components
│   │   ├── ErrorBoundary.tsx    # React error boundary
│   │   └── hydrate-fallback.tsx # Loading fallback
│   ├── gateway/                 # Gateway service singleton
│   ├── hooks/                   # Custom React hooks
│   │   ├── use-accent-color.ts  # System accent color
│   │   ├── use-systemtheme.ts   # Dark/light theme detection
│   │   ├── use-static-debounce.ts # Debounce helper
│   │   └── useVoiceWake.ts      # Voice wake settings IPC
│   ├── screens/                 # Feature pages
│   │   ├── exec-approval/       # Command approval UI
│   │   ├── notification/        # Toast notifications
│   │   ├── settings/            # Settings tabbed interface
│   │   ├── setup/               # Setup wizard (XState-based)
│   │   ├── tray-menu/           # System tray menu
│   │   └── voice-overlay/       # Voice wake overlay
│   ├── types/                   # TypeScript type definitions
│   │   ├── gateway.ts           # Gateway types
│   │   └── installer.ts         # Installer types
│   └── utils/                   # Utility functions
│       ├── error.ts             # Error formatting
│       ├── voiceChime.ts        # Audio playback helpers
│       └── wsl.ts               # WSL utility functions
├── package.json                 # Node.js dependencies
├── tsconfig.json                # TypeScript configuration
├── eslint.config.mjs            # ESLint rules
└── vite.config.ts               # Vite build configuration
```

## Architecture Patterns

### 1. Service-Oriented Backend

The backend is organized around **services** that handle specific domains:

```
┌─────────────────────────────────────────┐
│         RuntimeManager                  │
│    (Lifecycle Management)               │
└──────────────┬──────────────────────────┘
               │
        ┌──────┴──────┐
        │             │
    ┌───▼─────┐   ┌──▼───────┐
    │ Gateway │   │ Voice Wake│
    │ Service │   │ Service   │
    │         │   │           │
    │ WebSocket   │ PTT+Wake  │
    │ Connection  │ Dictation │
    └───┬─────┘   └──┬───────┘
        │            │
   ┌────▼────────────▼─────┐
   │  Event Dispatcher     │
   │  (Tauri emit/listen)  │
   └──────────┬────────────┘
              │
        ┌─────▼──────┐
        │  Frontend  │
        │  (React)   │
        └────────────┘
```

Each service:
- Manages a specific domain (config, gateway, voice, etc.)
- Implements `BackgroundService` trait for lifecycle
- Uses async/await with proper error handling
- Communicates via `EventDispatcher` (IPC)

### 2. Provider Pattern for OS Abstraction

Providers abstract hardware and OS-specific operations:

```
├── ConfigProvider        (File I/O)
├── SystemProvider        (PTY, commands)
├── WslProvider          (WSL integration)
├── AudioProvider        (Audio devices)
├── MediaProvider        (Camera, screen)
├── SpeechProvider       (Windows Speech API)
└── ... more
```

All providers implement traits with `Arc<dyn Trait>` injection for dependency management.

### 3. Error Handling Model

```rust
// All operations return Result<T>
pub type Result<T> = std::result::Result<T, OpenClawError>;

// Error enum with serializable variants
pub enum OpenClawError {
    Io(#[from] std::io::Error),
    Internal(String),
    Network(String),
}

// JSON serialization for IPC
impl Serialize for OpenClawError { ... }
```

**Key principles**:
- No `unwrap()` or `panic!()` in production code
- All `unwrap_or()` etc. have safe defaults
- Mutex poisoning handled with `recover_mutex_poison()` helper

### 4. React Hook Pattern for IPC

Frontend wraps Tauri invokes in custom hooks:

```typescript
export function useVoiceWake(): UseVoiceWakeReturn {
  const [enabled, setEnabledState] = useState(false);
  
  const setEnabled = useCallback(
    async (v: boolean) => {
      try {
        await invoke("set_voice_wake_enabled", { enabled: v });
        setEnabledState(v);
      } catch (e) {
        showError(`Failed: ${formatError(e)}`);
      }
    },
    [showError]
  );
  
  return { enabled, setEnabled, ... };
}
```

**Benefits**:
- Centralized command definitions
- Consistent error handling
- Type-safe parameters and returns
- Loading/error state management

### 5. Security Model

#### Environment Variable Sanitization
```
Command Args → Whitelist Filter → Execute
                    ↓
             Only: HOME, TEMP, LANG, etc.
             Blocked: PATH, LD_*, PYTHONHOME
             Validated: Alphanumeric + underscore names
```

#### Execution Approval Chain
```
Gateway Request
    ↓
validate_command() [exec_approvals_service]
    ├─ Check allowlist
    ├─ Check agent settings
    └─ Prompt user if needed
    ↓
SystemService::run_command()
    ↓
sanitize_env() → spawn_command()
```

#### SSH Key Validation
```
SSH Key Path → Path Exists? → Is File? → Canonicalize
              ├─ NO? → Error
              ├─ NO? → Error
              └─ Symlink safe path
```

## Data Flow

### Command Execution Flow
```
Gateway → node.invoke.request
          ↓
      invoke::handle_request()
          ↓
      validate_command() [security gate]
          ├─ Denied → emit exec.denied
          └─ Approved
              ↓
          system::run_command()
              ↓
          subprocess execution
              ↓
          emit exec.finished/exec.failed
          ↓
Gateway Response (via node.invoke.result)
```

### Voice Wake Flow
```
Microphone Audio
        ↓
Windows Speech API
        ↓
SpeechProvider (async stream)
        ↓
VoiceWakeService
    ├─ Detect trigger phrase
    ├─ Record post-trigger audio
    └─ Send to gateway via WebSocket
        ↓
Gateway performs action
        ↓
Response emitted to voice overlay
```

### Settings Persistence Flow
```
UI Change
    ↓
Hook calls update_* command
    ↓
Service handler (e.g., save_general_settings)
    ↓
ConfigService::update()
    ├─ Load current config
    ├─ Apply mutations
    ├─ Save to disk
    └─ Update in-memory cache
    ↓
Emit settings_changed event
    ↓
UI re-fetches config
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Whitelist env vars** | More secure than blocklist; explicit about permissions |
| **Arc<Mutex> over tokio::Mutex** | Can use in spawn_blocking; matches spawn_blocking needs |
| **Provider pattern** | Easy to mock for testing; OS agnostic |
| **Event dispatcher IPC** | Decoupled services; flexible subscriptions |
| **Fluent UI tokens** | Consistent with Windows design language |
| **React hooks for IPC** | Standard React pattern; familiar to team |
| **XState for setup** | Type-safe state machines; complex flow management |
| **Lazy-loaded routes** | Smaller initial bundle; faster startup |

## Communication Protocols

### IPC (Frontend ↔ Backend)
- **Type**: Tauri `invoke` + `listen`
- **Format**: JSON serialization
- **Security**: CSP strict; no script eval

### Gateway (Backend ↔ OpenClaw Gateway)
- **Type**: WebSocket over TLS
- **Auth**: ED25519 signatures
- **Protocol**: Custom JSON RPC-like format
- **Encryption**: TLS 1.3+

### System Tray
- Single primary window with menu
- Tray icon click toggles visibility
- Context menu for quick actions

## Testing Strategy

### Unit Tests (src-tauri/src)
- `invoke::tests` - env sanitization
- `voice_wake::tests` - trigger/locale validation
- Implicit tests via module organization

### Integration Tests (Potential)
- Gateway connection lifecycle
- Config persistence
- WSL command execution
- Permission validation

### Frontend Tests (Potential)
- Hook functionality with mock invoke
- Router navigation
- Component rendering

## Performance Considerations

1. **Config Caching**: 5-second TTL to avoid disk thrashing
2. **Event Debouncing**: Generic debounce hook for rapid UI updates
3. **Lazy Loading**: Routes loaded on-demand in React
4. **Async Operations**: All long-running ops async with progress indicators
5. **Memory**: Arc for shared state; no unnecessary clones

## Security Checklist

- [x] All commands validated before execution
- [x] Environment variables whitelisted
- [x] SSH keys canonicalized (no symlink traversal)
- [x] No panics in production code
- [x] Error messages sanitized (no credential leaks)
- [x] CSP hardened (no eval, http-only https)
- [x] Command output truncated (20KB max)
- [x] Null bytes blocked in env vars
- [x] User prompting for sensitive commands
- [x] Session keys validated

## Development Workflow

### Backend Changes
1. Modify service/provider
2. Update Tauri command if needed
3. Add error handling
4. Add tests
5. Verify with `cargo check` && `cargo test`

### Frontend Changes
1. Modify component/hook
2. Update TypeScript types
3. Test with hot reload
4. Verify types with `tsc --noEmit`
5. Run eslint/prettier

### Adding New Feature
1. **Service side**: Add to services/ with proper error handling
2. **Provider side**: Abstract OS-specific code if applicable
3. **IPC side**: Add Tauri command and event emitter
4. **Frontend side**: Create hook wrapper + component
5. **Testing**: Add unit tests for critical logic

## Debugging

### Backend Logs
```bash
# View logs (stdout + stderr)
cargo run

# View log files
~/.config/openclaw-windows/logs/openclaw.log

# Filter by module
RUST_LOG=debug,openclaw_windows_lib::services::voice_wake=trace cargo run
```

### Frontend Console
- Chrome DevTools via F12
- Inspect via inspect-tauri tool

### Gateway Communication
- Check [services/gateway_watcher.rs] for connection status
- Gateway events emitted via event dispatcher
- WebSocket frames logged at debug level

## Future Improvements

1. **Test Expansion**: Integration tests for critical services
2. **ARCHITECTURE.md**: This document (✓ done)
3. **Documentation**: Service-by-service API docs
4. **Monitoring**: Error tracking (Sentry) and metrics
5. **Performance**: Profiling and optimization
6. **Type Safety**: Stricter typing on gateway responses

---

*Last Updated: March 1, 2026*
