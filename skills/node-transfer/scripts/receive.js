#!/usr/bin/env node

/**
 * node-transfer receive.js v1.0.0
 * 
 * High-speed, memory-efficient file transfer receiver for OpenClaw.
 * Connects to sender and streams file directly to disk.
 * 
 * Usage: node receive.js <url> <token> <outputPath> [options]
 *        node receive.js --version
 *        node receive.js --help
 * 
 * Options:
 *   --timeout <n>  Connection timeout in seconds (default: 30)
 *   --no-progress  Don't output progress updates
 * 
 * Output: JSON with success, bytesReceived, duration, speedMBps
 * 
 * Exit codes:
 *   0 - Transfer completed successfully
 *   1 - Error (invalid args, connection failed, write error, timeout)
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const VERSION = '1.0.1';

// Parse arguments
function parseArgs() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        return { error: 'No arguments provided' };
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
        url: null,
        token: null,
        outputPath: null,
        timeoutSeconds: 30,
        showProgress: true
    };

    let positionalIndex = 0;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg === '--timeout') {
            result.timeoutSeconds = parseInt(args[++i], 10);
            if (isNaN(result.timeoutSeconds) || result.timeoutSeconds < 1) {
                return { error: `Invalid timeout: ${args[i]}` };
            }
        } else if (arg === '--no-progress') {
            result.showProgress = false;
        } else if (!arg.startsWith('-')) {
            // Positional arguments
            if (positionalIndex === 0) {
                result.url = arg;
            } else if (positionalIndex === 1) {
                result.token = arg;
            } else if (positionalIndex === 2) {
                result.outputPath = arg;
            } else {
                return { error: `Unexpected argument: ${arg}` };
            }
            positionalIndex++;
        } else {
            return { error: `Unknown option: ${arg}` };
        }
    }

    if (positionalIndex < 3) {
        return { error: 'Missing required arguments. Usage: receive.js <url> <token> <outputPath>' };
    }

    return result;
}

function showHelp() {
    console.log(`
node-transfer receive.js v${VERSION}

High-speed file transfer receiver for OpenClaw nodes.
Downloads a file from a send.js server via HTTP streaming.

Usage:
  node receive.js <url> <token> <outputPath> [options]

Arguments:
  url            URL from send.js output (required)
  token          Security token from send.js output (required)
  outputPath     Path to save the received file (required)

Options:
  --timeout <n>  Connection timeout in seconds (default: 30)
  --no-progress  Don't output progress updates
  -v, --version  Show version
  -h, --help     Show this help

Examples:
  node receive.js http://192.168.1.10:54321/transfer abc123... /path/to/save.zip
  node receive.js $URL $TOKEN ./download.bin --timeout 60

Output (JSON on success):
  {
    "success": true,
    "bytesReceived": 1073741824,
    "totalBytes": 1073741824,
    "duration": 8.42,
    "speedMBps": 121.5,
    "outputPath": "/path/to/save.zip"
  }

Exit codes:
  0  Success
  1  Error (check stderr for JSON error details)

Error output (JSON):
  {
    "error": "ERROR_CODE",
    "message": "Human-readable description"
  }
`);
}

function showVersion() {
    console.log(VERSION);
}

function logError(code, message) {
    console.error(JSON.stringify({ error: code, message }));
}

// Main
const args = parseArgs();

if (args.error) {
    logError('INVALID_ARGS', args.error);
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

// Validate URL
let parsedUrl;
try {
    parsedUrl = new URL(args.url);
} catch (err) {
    logError('INVALID_URL', `Invalid URL: ${args.url}`);
    process.exit(1);
}

// Ensure output directory exists
const outputDir = path.dirname(path.resolve(args.outputPath));
try {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
} catch (err) {
    logError('MKDIR_ERROR', `Cannot create output directory: ${err.message}`);
    process.exit(1);
}

// Check if output file already exists
if (fs.existsSync(args.outputPath)) {
    logError('FILE_EXISTS', `Output file already exists: ${args.outputPath}`);
    process.exit(1);
}

// Build full URL with token
const urlObj = new URL(args.url);
urlObj.searchParams.set('token', args.token);
const fullUrl = urlObj.toString();

// Choose http or https module
const client = parsedUrl.protocol === 'https:' ? https : http;

// Create write stream for output file
const writeStream = fs.createWriteStream(args.outputPath);
let receivedBytes = 0;
let totalBytes = 0;
let lastProgressBytes = 0;
const startTime = Date.now();
let lastProgressTime = startTime;

// Track state
let requestCompleted = false;

// Make request
const req = client.get(fullUrl, (res) => {
    // Check response status
    if (res.statusCode !== 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            logError('HTTP_ERROR', `HTTP ${res.statusCode}: ${data}`);
            cleanupAndExit(1);
        });
        return;
    }

    // Get total size from headers
    totalBytes = parseInt(res.headers['content-length'], 10) || 0;

    // Handle response data
    res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        
        // Progress updates (every ~1 second or 1MB)
        if (args.showProgress) {
            const now = Date.now();
            const elapsed = now - lastProgressTime;
            const bytesDelta = receivedBytes - lastProgressBytes;
            
            if (elapsed >= 1000 || bytesDelta >= 1024 * 1024) {
                const speed = bytesDelta / elapsed * 1000 / 1024 / 1024; // MB/s
                const percent = totalBytes > 0 ? Math.round(receivedBytes / totalBytes * 100) : 0;
                
                console.log(JSON.stringify({
                    progress: true,
                    receivedBytes,
                    totalBytes,
                    percent,
                    speedMBps: Math.round(speed * 100) / 100
                }));
                
                lastProgressTime = now;
                lastProgressBytes = receivedBytes;
            }
        }
    });

    // Handle errors
    res.on('error', (err) => {
        logError('RECEIVE_ERROR', err.message);
        cleanupAndExit(1);
    });

    // Handle response end
    res.on('end', () => {
        if (receivedBytes === 0) {
            logError('NO_DATA', 'No data received from server');
            cleanupAndExit(1);
        }
    });

    // Pipe response to file (memory-efficient streaming)
    res.pipe(writeStream);
});

// Handle write stream events
writeStream.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const speed = receivedBytes / duration / 1024 / 1024; // MB/s
    
    // Verify received bytes match expected
    if (totalBytes > 0 && receivedBytes !== totalBytes) {
        logError('SIZE_MISMATCH', `Received ${receivedBytes} bytes, expected ${totalBytes}`);
        cleanupAndExit(1);
        return;
    }
    
    const output = {
        success: true,
        bytesReceived: receivedBytes,
        totalBytes: totalBytes || receivedBytes,
        duration: Math.round(duration * 100) / 100,
        speedMBps: Math.round(speed * 100) / 100,
        outputPath: path.resolve(args.outputPath)
    };
    
    console.log(JSON.stringify(output));
    requestCompleted = true;
    process.exit(0);
});

writeStream.on('error', (err) => {
    logError('WRITE_ERROR', err.message);
    req.destroy();
    cleanupAndExit(1);
});

// Handle request errors
req.on('error', (err) => {
    logError('CONNECTION_ERROR', `Cannot connect to sender: ${err.message}`);
    cleanupAndExit(1);
});

// Timeout handling
req.setTimeout(args.timeoutSeconds * 1000, () => {
    logError('TIMEOUT', `Connection timeout after ${args.timeoutSeconds} seconds`);
    req.destroy();
    cleanupAndExit(1);
});

// Cleanup function
function cleanupAndExit(code) {
    if (requestCompleted) return;
    requestCompleted = true;
    
    writeStream.destroy();
    
    // Remove partial file
    try {
        if (fs.existsSync(args.outputPath)) {
            fs.unlinkSync(args.outputPath);
        }
    } catch (err) {
        // Ignore cleanup errors
    }
    
    process.exit(code);
}
