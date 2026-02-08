# node-transfer

High-speed, memory-efficient file transfer between OpenClaw nodes using native Node.js streams.

## 📋 Table of Contents

- [Problem Solved](#problem-solved)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## 🎯 Problem Solved

### The Original Problem

When transferring large files between OpenClaw nodes using the standard `nodes.invoke` mechanism, we encountered several critical issues:

| Issue | Impact |
|-------|--------|
| **Base64 Encoding Overhead** | 33% larger payload, slower transfers |
| **Memory Exhaustion (OOM)** | Loading multi-GB files into memory crashes the process |
| **Transfer Latency** | JSON serialization/deserialization adds significant delay |
| **9-Minute Deployments** | Re-deploying scripts on every transfer |

### The Solution

`node-transfer` uses **native HTTP streaming** with Node.js streams, providing:

- ✅ **Zero memory overhead** - Files stream directly from disk to network
- ✅ **No Base64 encoding** - Raw binary transfer
- ✅ **Speed** - Line-speed limited only by network bandwidth
- ✅ **Install Once, Run Many** - Scripts persist on nodes after first deployment

### Performance Comparison

| Metric | Base64 Transfer | node-transfer | Improvement |
|--------|----------------|---------------|-------------|
| 1GB file transfer time | ~15-30 min | ~8 sec | **~150x faster** |
| Memory usage | 1GB+ | <10MB | **99% reduction** |
| First transfer overhead | N/A | ~30 sec (one-time install) | - |
| Subsequent transfers | ~15-30 min | **<1 sec** check + ~8 sec transfer | **~200x faster** |

---

## 🏗️ Architecture

### How It Works

```
┌──────────────┐     HTTP Stream      ┌──────────────┐
│  send.js     │ ◄──────────────────► │ receive.js   │
│  (Source)    │   (Token-protected)  │ (Destination)│
└──────────────┘                      └──────────────┘
       │                                     │
       ▼                                     ▼
┌──────────────┐                      ┌──────────────┐
│  Read Stream │                      │ Write Stream │
│  (fs.create  │                      │ (fs.create   │
│   ReadStream)│                      │  WriteStream)│
└──────────────┘                      └──────────────┘
       │                                     │
       ▼                                     ▼
┌──────────────┐                      ┌──────────────┐
│  File on     │                      │  File on     │
│  Disk        │                      │  Disk        │
└──────────────┘                      └──────────────┘
```

### Security Model

1. **One-time Token**: 256-bit cryptographically random token (64 hex chars)
2. **Single Connection**: Only one download allowed per token
3. **Auto-shutdown**: Server closes after transfer completes or disconnects
4. **Token Validation**: Every request must include the correct token

### Data Flow

1. **Sender** (`send.js`):
   - Generates random port and security token
   - Starts HTTP server on ephemeral port
   - Streams file directly from disk to HTTP response
   - Auto-shutdown after transfer or timeout (5 min default)

2. **Receiver** (`receive.js`):
   - Connects to sender URL with token
   - Streams HTTP response directly to disk
   - Reports progress, speed, and completion status
   - Validates received bytes match expected size

---

## 📦 Requirements

- **Node.js**: 14.0.0 or higher
- **Network**: TCP connectivity between nodes (any port 1024-65535)
- **Firewall**: Must allow outbound connections and inbound on ephemeral ports
- **Disk Space**: Sufficient space on destination for received files

---

## 🚀 Installation

### The "Install Once" Pattern

Instead of deploying scripts on every transfer, we deploy them **once per node** and use a fast version check for subsequent transfers.

### Method 1: Using deploy.js (Recommended)

```bash
# Generate deployment script for a target node
node deploy.js E3V3

# This outputs a PowerShell script that you can execute via nodes.invoke()
```

### Method 2: Manual Deployment

On each target node, create the directory and copy files:

```powershell
# Create directory
mkdir C:/openclaw/skills/node-transfer/scripts -Force

# Copy these files (ensure UTF-8 without BOM encoding):
# - send.js
# - receive.js
# - ensure-installed.js
# - version.js
```

### Method 3: Via OpenClaw Agent

```javascript
// 1. Check if already installed (< 100ms)
const check = await nodes.invoke({
    node: 'E3V3',
    command: ['node', 'C:/openclaw/skills/node-transfer/scripts/ensure-installed.js', 
              'C:/openclaw/skills/node-transfer/scripts']
});

const checkResult = JSON.parse(check.output);

if (!checkResult.installed) {
    // 2. Deploy if needed (one-time, ~30 seconds)
    // Use the deploy.js output or manually copy files
    console.log('Deploying node-transfer to E3V3...');
    // ... deployment code ...
}
```

---

## 💡 Usage

### Basic Transfer Workflow

```javascript
const INSTALL_DIR = 'C:/openclaw/skills/node-transfer/scripts';
const SOURCE_NODE = 'E3V3';
const DEST_NODE = 'E3V3-Docker';

// Step 1: Check installation on both nodes (fast!)
const [sourceCheck, destCheck] = await Promise.all([
    nodes.invoke({
        node: SOURCE_NODE,
        command: ['node', `${INSTALL_DIR}/ensure-installed.js`, INSTALL_DIR]
    }),
    nodes.invoke({
        node: DEST_NODE,
        command: ['node', `${INSTALL_DIR}/ensure-installed.js`, INSTALL_DIR]
    })
]);

// Deploy if needed (usually only once per node ever)
// ... deployment code if not installed ...

// Step 2: Start sender on source node
const sendResult = await nodes.invoke({
    node: SOURCE_NODE,
    command: ['node', `${INSTALL_DIR}/send.js`, 'C:/data/large-file.zip']
});

const { url, token, fileSize, fileName } = JSON.parse(sendResult.output);

// Step 3: Start receiver on destination node
const receiveResult = await nodes.invoke({
    node: DEST_NODE,
    command: ['node', `${INSTALL_DIR}/receive.js`, url, token, '/incoming/file.zip']
});

const result = JSON.parse(receiveResult.output);
console.log(`Transferred ${result.bytesReceived} bytes in ${result.duration}s at ${result.speedMBps} MB/s`);
```

### Using the Command Line

#### Sender

```bash
node send.js /path/to/file.zip
```

Output:
```json
{
  "url": "http://192.168.1.10:54321/transfer",
  "token": "a1b2c3d4e5f6789...",
  "fileSize": 1073741824,
  "fileName": "file.zip",
  "sourceIp": "192.168.1.10",
  "port": 54321,
  "version": "1.0.0"
}
```

Options:
```bash
node send.js /path/to/file.zip --port 8080 --timeout 10
node send.js --help
node send.js --version
```

#### Receiver

```bash
node receive.js "http://192.168.1.10:54321/transfer" "token-here..." /path/to/save.zip
```

Output:
```json
{
  "success": true,
  "bytesReceived": 1073741824,
  "totalBytes": 1073741824,
  "duration": 8.42,
  "speedMBps": 121.5,
  "outputPath": "/path/to/save.zip"
}
```

Options:
```bash
node receive.js <url> <token> <output> --timeout 60 --no-progress
node receive.js --help
node receive.js --version
```

---

## 📚 API Reference

### send.js

Starts an HTTP server to stream a file.

**Usage:** `node send.js <filePath> [options]`

**Arguments:**
- `filePath` (required): Path to the file to send

**Options:**
- `--port <n>`: Use specific port (default: random ephemeral)
- `--timeout <n>`: Timeout in minutes (default: 5)

**Output (JSON):**
| Field | Type | Description |
|-------|------|-------------|
| `url` | string | HTTP URL for receiver to connect to |
| `token` | string | Security token (64 hex chars) |
| `fileSize` | number | File size in bytes |
| `fileName` | string | Original filename |
| `sourceIp` | string | IP address of sender |
| `port` | number | TCP port used |
| `version` | string | Version of send.js |

**Exit Codes:**
- `0`: Success (transfer completed or info displayed)
- `1`: Error (check stderr for JSON error details)

**Error Output (JSON):**
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description"
}
```

Error codes: `FILE_NOT_FOUND`, `NOT_A_FILE`, `SERVER_ERROR`, `TIMEOUT`, `READ_ERROR`, `RESPONSE_ERROR`

---

### receive.js

Connects to a sender and downloads a file.

**Usage:** `node receive.js <url> <token> <outputPath> [options]`

**Arguments:**
- `url` (required): URL from send.js output
- `token` (required): Security token from send.js output
- `outputPath` (required): Path to save the received file

**Options:**
- `--timeout <n>`: Connection timeout in seconds (default: 30)
- `--no-progress`: Suppress progress updates

**Output (JSON):**
| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always true on success |
| `bytesReceived` | number | Actual bytes received |
| `totalBytes` | number | Expected bytes (from Content-Length) |
| `duration` | number | Transfer time in seconds |
| `speedMBps` | number | Average speed in MB/s |
| `outputPath` | string | Absolute path to saved file |

**Progress Updates (when not using `--no-progress`):**
```json
{
  "progress": true,
  "receivedBytes": 536870912,
  "totalBytes": 1073741824,
  "percent": 50,
  "speedMBps": 125.4
}
```

**Exit Codes:**
- `0`: Success
- `1`: Error (check stderr for JSON error details)

Error codes: `INVALID_ARGS`, `INVALID_URL`, `CONNECTION_ERROR`, `HTTP_ERROR`, `TIMEOUT`, `WRITE_ERROR`, `SIZE_MISMATCH`, `FILE_EXISTS`, `NO_DATA`

---

### ensure-installed.js

Fast check if node-transfer is installed on a node.

**Usage:** `node ensure-installed.js <targetDir>`

**Arguments:**
- `targetDir` (required): Directory to check

**Output (JSON):**

Installed:
```json
{
  "installed": true,
  "version": "1.0.0",
  "message": "node-transfer is installed and up-to-date"
}
```

Needs installation:
```json
{
  "installed": false,
  "missing": ["send.js"],
  "mismatched": [],
  "currentVersion": null,
  "requiredVersion": "1.0.0",
  "action": "DEPLOY",
  "message": "Installation needed: 1 missing, 0 outdated"
}
```

**Exit Codes:**
- `0`: Already installed and up-to-date
- `1`: Needs installation/update
- `2`: Error (invalid directory, etc.)

---

### deploy.js

Generates deployment scripts for the main agent.

**Usage:** `node deploy.js <nodeId> [targetDir]`

**Output:** JSON with:
- `script`: PowerShell script to deploy files
- `escapedScript`: Escaped version for command-line use
- `usage`: Example code for JavaScript and CLI usage

---

## 🔧 Troubleshooting

### "Connection timeout"

**Cause:** Network connectivity issue or firewall blocking connection.

**Solutions:**
- Verify both nodes can reach each other
- Check firewall rules allow outbound connections
- Try specifying a specific port with `--port`
- Increase timeout with `--timeout`

### "403 Forbidden: Invalid or missing token"

**Cause:** Token mismatch or URL manipulation.

**Solutions:**
- Use the exact token from send.js output
- Don't modify the URL
- Ensure the token hasn't expired (sender times out after 5 minutes)

### "409 Conflict: Transfer already in progress"

**Cause:** Multiple connections attempted with same token.

**Solutions:**
- Each sender URL/token can only be used once
- Start a new sender if you need to retry

### "FILE_NOT_FOUND" or "NOT_A_FILE"

**Cause:** Invalid file path on sender.

**Solutions:**
- Use absolute paths
- Verify file exists
- Check file permissions

### "SIZE_MISMATCH"

**Cause:** Connection interrupted or network error.

**Solutions:**
- Retry the transfer
- Check network stability
- The partial file is automatically cleaned up

### "Hash mismatch" during ensure-installed

**Cause:** Files were modified or corrupted.

**Solutions:**
- Re-deploy scripts using deploy.js
- Ensure files are copied without modification
- Check encoding (must be UTF-8 without BOM)

### Slow transfers on subsequent runs

**Cause:** Not using `ensure-installed.js` check pattern.

**Solutions:**
- Always check installation first (< 100ms)
- Only deploy if `installed: false`
- Follow the "Install Once, Run Many" pattern

---

## 📄 Files

| File | Purpose |
|------|---------|
| `send.js` | HTTP server that streams files to receivers |
| `receive.js` | HTTP client that downloads files from senders |
| `ensure-installed.js` | Fast version/integrity check for deployment |
| `version.js` | Version manifest for update detection |
| `deploy.js` | Generates deployment scripts for agents |

---

## 🤝 Contributing

See [CONTRIBUTING_PROPOSAL.md](./CONTRIBUTING_PROPOSAL.md) for information on how this could be integrated into OpenClaw core.

---

*Built for OpenClaw - No Base64, No OOM, No Waiting.*
