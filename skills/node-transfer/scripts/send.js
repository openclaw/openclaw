#!/usr/bin/env node

/**
 * node-transfer send.js v1.0.0
 * 
 * High-speed, memory-efficient file transfer sender for OpenClaw.
 * Starts a lightweight HTTP server on an ephemeral port to stream a file.
 * 
 * Usage: node send.js <filePath> [options]
 *        node send.js --version
 *        node send.js --help
 * 
 * Options:
 *   --port <n>     Use specific port (default: random ephemeral)
 *   --timeout <n>  Timeout in minutes (default: 5)
 * 
 * Output: JSON with url, token, fileSize, fileName, sourceIp, port
 * 
 * Exit codes:
 *   0 - Transfer completed successfully or info displayed
 *   1 - Error (invalid args, file not found, server error, timeout)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const VERSION = '1.0.1';

// Parse arguments
function parseArgs() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        return { error: 'No file path provided' };
    }

    // Help flag
    if (args.includes('--help') || args.includes('-h')) {
        return { help: true };
    }

    // Version flag
    if (args.includes('--version') || args.includes('-v')) {
        return { version: true };
    }

    const result = {
        filePath: null,
        port: 0,
        timeoutMinutes: 5
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--port') {
            result.port = parseInt(args[++i], 10);
            if (isNaN(result.port) || result.port < 1 || result.port > 65535) {
                return { error: `Invalid port: ${args[i]}` };
            }
        } else if (arg === '--timeout') {
            result.timeoutMinutes = parseInt(args[++i], 10);
            if (isNaN(result.timeoutMinutes) || result.timeoutMinutes < 1) {
                return { error: `Invalid timeout: ${args[i]}` };
            }
        } else if (!arg.startsWith('-')) {
            if (!result.filePath) {
                result.filePath = arg;
            } else {
                return { error: `Unexpected argument: ${arg}` };
            }
        } else {
            return { error: `Unknown option: ${arg}` };
        }
    }

    if (!result.filePath) {
        return { error: 'No file path provided' };
    }

    return result;
}

function showHelp() {
    console.log(`
node-transfer send.js v${VERSION}

High-speed file transfer sender for OpenClaw nodes.
Starts an HTTP server to stream a file to a receiver.

Usage:
  node send.js <filePath> [options]

Arguments:
  filePath       Path to the file to send (required)

Options:
  --port <n>     Use specific port (default: random ephemeral port)
  --timeout <n>  Timeout in minutes (default: 5)
  -v, --version  Show version
  -h, --help     Show this help

Examples:
  node send.js /path/to/file.zip
  node send.js C:\\data\\large.bin --timeout 10
  node send.js ./image.png --port 8080

Output (JSON):
  {
    "url": "http://192.168.1.10:54321/transfer",
    "token": "a1b2c3d4...",
    "fileSize": 1073741824,
    "fileName": "file.zip",
    "sourceIp": "192.168.1.10",
    "port": 54321
  }

Security:
  - Each transfer uses a unique 256-bit random token
  - Only one connection allowed per token
  - Server auto-shutdown after transfer or timeout
`);
}

function showVersion() {
    console.log(VERSION);
}

// Main
const args = parseArgs();

if (args.error) {
    console.error(`Error: ${args.error}`);
    console.error('Use --help for usage information');
    process.exit(1);
}

if (args.help) {
    showHelp();
    process.exit(0);
}

if (args.version) {
    showVersion();
    process.exit(0);
}

// Resolve and validate file path
const resolvedPath = path.resolve(args.filePath);
if (!fs.existsSync(resolvedPath)) {
    console.error(JSON.stringify({ error: 'FILE_NOT_FOUND', message: `File not found: ${args.filePath}` }));
    process.exit(1);
}

const fileStat = fs.statSync(resolvedPath);
if (!fileStat.isFile()) {
    console.error(JSON.stringify({ error: 'NOT_A_FILE', message: `Path is not a file: ${args.filePath}` }));
    process.exit(1);
}

// Get file stats
const fileSize = fileStat.size;
const fileName = path.basename(resolvedPath);

// Generate one-time security token (256-bit)
const token = crypto.randomBytes(32).toString('hex');

// Track transfer state
let transferCompleted = false;
let activeConnection = false;
let transferStartTime = null;

// Create HTTP server
const server = http.createServer((req, res) => {
    // Parse URL and extract token
    let reqUrl;
    try {
        reqUrl = new URL(req.url, `http://${req.headers.host}`);
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: Invalid URL');
        return;
    }

    const reqToken = reqUrl.searchParams.get('token');

    // Validate token
    if (reqToken !== token) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: Invalid or missing token');
        return;
    }

    // Only allow single connection
    if (activeConnection) {
        res.writeHead(409, { 'Content-Type': 'text/plain' });
        res.end('Conflict: Transfer already in progress');
        return;
    }

    activeConnection = true;
    transferStartTime = Date.now();

    // Sanitize filename for header safety (remove newlines and quotes)
    const safeFileName = fileName.replace(/[\"\\n\\r]/g, '_');

    // Set headers for file download
    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize,
        'Content-Disposition': `attachment; filename="${safeFileName}"`,
        'X-Transfer-Token': token,
        'X-Transfer-Version': VERSION
    });

    // Create read stream and pipe to response
    const readStream = fs.createReadStream(resolvedPath);
    
    readStream.on('error', (err) => {
        console.error(JSON.stringify({ 
            error: 'READ_ERROR', 
            message: err.message 
        }));
        if (!res.writableEnded) {
            res.destroy();
        }
        activeConnection = false;
    });

    readStream.on('end', () => {
        transferCompleted = true;
        activeConnection = false;
        const duration = (Date.now() - transferStartTime) / 1000;
        
        // Close server after successful transfer
        setTimeout(() => {
            server.close(() => {
                process.exit(0);
            });
        }, 100);
    });

    res.on('error', (err) => {
        console.error(JSON.stringify({ 
            error: 'RESPONSE_ERROR', 
            message: err.message 
        }));
        readStream.destroy();
        activeConnection = false;
    });

    res.on('close', () => {
        if (!transferCompleted) {
            console.error(JSON.stringify({ 
                warning: 'CONNECTION_CLOSED', 
                message: 'Connection closed before transfer completed' 
            }));
        }
        readStream.destroy();
        activeConnection = false;
        
        // Close server on disconnect
        setTimeout(() => {
            server.close(() => {
                process.exit(transferCompleted ? 0 : 1);
            });
        }, 100);
    });

    // Pipe file to response (memory-efficient streaming)
    readStream.pipe(res);
});

// Find available port and start server
server.listen(args.port, '0.0.0.0', () => {
    const address = server.address();
    const port = address.port;
    
    // Get network interfaces
    const interfaces = os.networkInterfaces();
    let ip = '127.0.0.1';
    
    // Find first non-internal IPv4 address
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ip = iface.address;
                break;
            }
        }
        if (ip !== '127.0.0.1') break;
    }

    const url = `http://${ip}:${port}/transfer`;

    // Output JSON with transfer info (for main agent to parse)
    const output = {
        url: url,
        token: token,
        fileSize: fileSize,
        fileName: fileName,
        sourceIp: ip,
        port: port,
        version: VERSION
    };

    console.log(JSON.stringify(output));
});

// Handle server errors
server.on('error', (err) => {
    console.error(JSON.stringify({ 
        error: 'SERVER_ERROR', 
        message: err.message 
    }));
    process.exit(1);
});

// Timeout after specified minutes (in case transfer never happens)
setTimeout(() => {
    console.error(JSON.stringify({ 
        error: 'TIMEOUT', 
        message: `No connection received within ${args.timeoutMinutes} minutes` 
    }));
    server.close(() => {
        process.exit(1);
    });
}, args.timeoutMinutes * 60 * 1000);
