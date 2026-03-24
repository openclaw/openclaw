# Software Debugging Reference

Detailed command reference for NeuralDebug software debugging across all 8 supported languages.

## Debug Session Commands

All languages share the same command interface via TCP/JSON.

### Session Control

| Command | Alias | Description |
|---------|-------|-------------|
| `start` | `s` | Begin execution (run to first breakpoint or end) |
| `quit` | `q` | End the debug session |

> **Note:** Target selection and process attach happen at server startup
> (`serve <target>` or `serve --attach_pid <pid>`), not as runtime commands.

### Breakpoints

| Command | Alias | Description |
|---------|-------|-------------|
| `set_breakpoint <location>` | `b` | Set breakpoint (line number, function name, or file:line) |
| `remove_breakpoint <id>` | `rb` | Remove a breakpoint by ID |
| `breakpoints` | `bl` | Show all breakpoints |

### Execution Control

| Command | Alias | Description |
|---------|-------|-------------|
| `continue` | `c` | Resume execution until next breakpoint |
| `step_over` | `n` | Execute current line, skip function calls |
| `step_in` | `si` | Step into function calls |
| `step_out` | `so` | Run until current function returns |

### Inspection

| Command | Alias | Description |
|---------|-------|-------------|
| `inspect` | `i` | Show all local variables at current frame |
| `evaluate <expr>` | `e` | Evaluate an expression in current context |
| `backtrace` | `bt` | Show call stack |
| `list` | `l` | Show source code around current line |
| `threads` | | List all threads |
| `switch_thread <id>` | | Switch to a different thread |

### Memory & Low-Level (C/C++ only)

| Command | Alias | Description |
|---------|-------|-------------|
| `read_memory <addr> <len>` | `mem` | Read raw memory bytes |
| `disassemble [addr]` | `dis` | Disassemble instructions |
| `registers` | `regs` | Show CPU register values |
| `write_memory <addr> <bytes>` | | Patch memory |

## Language-Specific Notes

### Python
- Backend: `bdb` (stdlib) — no installation needed
- Breakpoints: line numbers or function names
- Auto-detects virtualenvs

### C/C++
- Backends: GDB (Linux/Windows), LLDB (macOS), CDB (Windows)
- Auto-detects available debugger
- Requires debug symbols (`-g` for GCC/Clang, `/Zi` for MSVC)
- Supports crash dump analysis (`.dmp`, core files)

### C#
- Backend: netcoredbg (MI mode)
- Works with .NET Core / .NET 5+ projects
- Set breakpoints with `file.cs:line` syntax

### Rust
- Backends: rust-gdb, rust-lldb, GDB, LLDB (tried in order)
- Auto-compiles with `cargo build` if needed
- Pretty-prints Rust types (Vec, HashMap, String, etc.)

### Java
- Backend: JDB (bundled with JDK)
- Supports `.java` files, class names, and `.jar` files
- Auto-compiles with `javac` if needed

### Go
- Backend: Delve (`dlv`)
- Install: `go install github.com/go-delve/delve/cmd/dlv@latest`
- Supports goroutine inspection

### Node.js / TypeScript
- Backend: Node.js built-in inspector
- Supports `.js`, `.mjs`, `.ts` files
- TypeScript compiled on-the-fly if `ts-node` available

### Ruby
- Backend: rdbg (`debug` gem)
- Requires Ruby 3.2+ or `gem install debug`
- Supports Rack/Rails applications

## One-Shot Mode

For quick captures without a persistent session:

```bash
# Python
python src/neuraldebug/python_debugger.py debug script.py -b 42 -o result.json

# C/C++
python src/neuraldebug/cpp_debugger.py debug ./myapp -b main.c:25 -o result.json

# With arguments
python src/neuraldebug/python_debugger.py debug script.py -b 42 --args "input.txt --verbose"

# Multiple breakpoints
python src/neuraldebug/python_debugger.py debug script.py -b 42 -b 87 -o result.json

# Conditional breakpoint
python src/neuraldebug/python_debugger.py debug script.py -b 42 --condition "x > 10"
```

## Response Format

Every command returns JSON:

```json
{
  "status": "paused",
  "command": "step_over",
  "message": "Paused at line 42",
  "current_location": {
    "file": "server.py",
    "line": 42,
    "function": "handle_request"
  },
  "local_variables": {
    "request": "<Request POST /api/users>",
    "user_id": 12345
  },
  "call_stack": [
    {"file": "server.py", "line": 42, "function": "handle_request"},
    {"file": "app.py", "line": 15, "function": "dispatch"}
  ]
}
```
