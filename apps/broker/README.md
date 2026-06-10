# broker

PTY-WebSocket broker that runs inside the per-tenant
`rockielab-runtime-multitenant` container. It bridges a tenant's
`claude` / `codex` / `bash` PTY to a WebSocket so the platform-context
proxy can pipe an xterm.js session through to the user's browser.

## Endpoints

- `GET /healthz`
  Returns `200 {"status":"ok"}`. Used by Fly's health check and by the
  platform-context status endpoint.

- `GET /ws?token=<tenant-token>&binary=<claude|codex|bash>&cwd=<path>`
  Upgrades to a WebSocket, validates the token (constant-time compare),
  and spawns the requested binary in a PTY. Dispatch is driven only by
  the explicit `binary` query parameter: `claude`, `codex`, and `bash`
  are accepted as-is; omitted values fall back to `claude`; unknown
  values are rejected. The broker does not infer mode from env vars such
  as `MODE` or `BINARY`. Frames use the binary framing scheme below.

- `POST /spawn`
  Headless one-shot. Body:
  ```json
  { "binary": "claude", "args": ["/login"], "cwd": "/home/runtime",
    "timeout_sec": 60 }
  ```
  Auth: same broker token, supplied either as `?token=` or as
  `Authorization: Bearer <token>`. Returns:
  ```json
  { "exit_code": 0, "stdout": "...", "stderr": "...", "timed_out": false }
  ```

- `GET /fs/tree?path=<path>`
  Read-only directory listing for the tenant runtime filesystem. Auth:
  same broker token, supplied either as `?token=` or as
  `Authorization: Bearer <token>`. `path` may be absolute under the
  runtime root or relative to it; an omitted `path` defaults to
  `<runtime-root>/work`. The runtime root is `ROCKIELAB_RUNTIME_FS_ROOT`,
  then `HOME`, then `/home/runtime`. The broker resolves symlinks and
  rejects traversal or symlink escapes outside that root. Returns:
  ```json
  {
    "root": "/home/runtime",
    "path": "/home/runtime/work",
    "entries": [
      {
        "name": "README.md",
        "path": "/home/runtime/work/README.md",
        "type": "file",
        "size": 1234,
        "mtime": "2026-06-10T12:00:00Z"
      }
    ]
  }
  ```
  Entry `type` is `directory`, `file`, `symlink`, or `other`. `size` is
  included only for regular files. Directories are sorted first, then
  names are sorted case-insensitively.

- `GET /fs/file?path=<path>`
  Read-only UTF-8 file read for the tenant runtime filesystem. Auth and
  `path` containment rules match `/fs/tree`: paths may be absolute under
  the runtime root or relative to it, and traversal/symlink escapes are
  rejected. Callers should provide a file path; omitting `path` resolves
  to `<runtime-root>/work`, which normally returns `not_file` because it
  is a directory. The broker only returns valid UTF-8 files up to 1 MiB;
  larger files return `file_too_large`, and non-UTF-8 files return
  `unsupported_file`.
  Returns:
  ```json
  {
    "path": "/home/runtime/work/README.md",
    "type": "file",
    "size": 1234,
    "content": "...",
    "encoding": "utf-8",
    "truncated": false
  }
  ```

## Auth

The broker reads its expected token from the env var
`BROKER_TENANT_TOKEN`, injected at machine boot via a Fly secret. All
token comparisons use `crypto/subtle.ConstantTimeCompare`. Non-WebSocket
HTTP endpoints accept `Authorization: Bearer <token>` and `?token=`;
prefer Bearer auth for HTTP clients because query-string tokens can
appear in intermediary logs, browser history, or telemetry. `/ws` uses
the query-string token because browser WebSocket clients cannot set
custom authorization headers. Broker application logs redact explicit
token fields.

## Framing scheme

All bridged messages are WebSocket binary frames whose first byte is
the type tag.

### Client → server

| Tag    | Payload                                  | Meaning                       |
| ------ | ---------------------------------------- | ----------------------------- |
| `0x01` | `<bytes…>`                               | stdin write                   |
| `0x02` | `<rows: uint16 BE><cols: uint16 BE>`     | TTY resize                    |

### Server → client

| Tag    | Payload                       | Meaning                |
| ------ | ----------------------------- | ---------------------- |
| `0x01` | `<bytes…>`                    | stdout/stderr (combined) |
| `0x03` | `<code: int32 BE>`            | child process exit code |

Unknown frame types are silently ignored to keep things forward-
compatible. Text frames are not used.

## Errors

Structured JSON envelope, matching the rest of the Phase 2 API:

```json
{ "error": { "code": "invalid_token", "message": "missing or invalid token" } }
```

## Example xterm.js client snippet

```js
const term = new Terminal();
term.open(document.getElementById('term'));

const ws = new WebSocket(
  // platform-context proxies to broker:
  `wss://api.rockielab.com/api/tenants/${tenantId}/terminal?binary=claude`
);
ws.binaryType = 'arraybuffer';

ws.onmessage = (ev) => {
  const data = new Uint8Array(ev.data);
  switch (data[0]) {
    case 0x01:
      term.write(new TextDecoder().decode(data.slice(1)));
      break;
    case 0x03: {
      const code = new DataView(data.buffer, 1, 4).getInt32(0, false);
      term.writeln(`\r\n[exit ${code}]`);
      break;
    }
  }
};

term.onData((s) => {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(1 + bytes.length);
  out[0] = 0x01;
  out.set(bytes, 1);
  ws.send(out);
});

term.onResize(({ rows, cols }) => {
  const out = new Uint8Array(5);
  out[0] = 0x02;
  new DataView(out.buffer).setUint16(1, rows, false);
  new DataView(out.buffer).setUint16(3, cols, false);
  ws.send(out);
});
```

## Local dev

```sh
go run .                 # listens on :7681
curl http://localhost:7681/healthz
```

Set `BROKER_TENANT_TOKEN=dev-token` in your shell first or `/ws` and
`/spawn` will return `broker_token_unset`. The port can be overridden
with `BROKER_PORT`.

## Build for the runtime image

The Dockerfile.multitenant build stage compiles this package to a
static binary at `/usr/local/bin/broker`. See `apps/broker/main.go`
imports for the exact dependency versions.
