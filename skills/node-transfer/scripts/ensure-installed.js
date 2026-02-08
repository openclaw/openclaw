#!/usr/bin/env node

/**
 * node-transfer ensure-installed.js v1.0.0
 * 
 * Fast installation check for node-transfer scripts.
 * Used to verify if scripts are installed and up-to-date.
 * 
 * Usage: node ensure-installed.js <targetDir>
 *        node ensure-installed.js --version
 *        node ensure-installed.js --help
 * 
 * Exit codes:
 *   0 - Already installed and up-to-date
 *   1 - Needs installation/update
 *   2 - Error (invalid directory, permission denied, etc.)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '1.0.1';

// Expected file hashes (SHA-256 prefix)
const EXPECTED_FILES = {
    'send.js': null,     // Will be computed at runtime or use version from version.js
    'receive.js': null,
    'ensure-installed.js': null
};

// Parse arguments
function parseArgs() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h')) {
        return { help: true };
    }

    if (args.includes('--version') || args.includes('-v')) {
        return { version: true };
    }

    if (args.length === 0) {
        return { error: 'No target directory provided' };
    }

    return { targetDir: args[0] };
}

function showHelp() {
    console.log(`
node-transfer ensure-installed.js v${VERSION}

Fast installation check for node-transfer scripts.

Usage:
  node ensure-installed.js <targetDir>
  node ensure-installed.js --version
  node ensure-installed.js --help

Arguments:
  targetDir      Directory to check for installed scripts

Exit codes:
  0  Installed and up-to-date
  1  Needs installation or update
  2  Error (invalid directory, etc.)

Output (JSON):
  Installed:
    {
      "installed": true,
      "version": "1.0.0",
      "message": "node-transfer is installed and up-to-date"
    }
  
  Needs install:
    {
      "installed": false,
      "missing": ["send.js", "receive.js"],
      "mismatched": [],
      "currentVersion": null,
      "requiredVersion": "1.0.0",
      "action": "DEPLOY",
      "message": "Installation needed: 2 missing, 0 outdated"
    }

Examples:
  node ensure-installed.js C:/openclaw/skills/node-transfer/scripts
  node ensure-installed.js ./scripts
`);
}

function showVersion() {
    console.log(VERSION);
}

function hashFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return crypto.createHash('sha256').update(content).digest('hex').substring(0, 12);
    } catch {
        return null;
    }
}

function loadVersionInfo(targetDir) {
    const versionPath = path.join(targetDir, 'version.js');
    if (!fs.existsSync(versionPath)) {
        return null;
    }
    
    try {
        // Clear require cache to get fresh version
        delete require.cache[require.resolve(versionPath)];
        return require(versionPath);
    } catch {
        return null;
    }
}

function checkInstalled(targetDir) {
    const results = {
        installed: true,
        missing: [],
        mismatched: [],
        version: null,
        requiredVersion: VERSION
    };

    // Check version file first
    const versionInfo = loadVersionInfo(targetDir);
    
    if (!versionInfo) {
        results.installed = false;
        results.missing.push('version.js');
    } else {
        results.version = versionInfo.version;
        if (versionInfo.version !== VERSION) {
            results.installed = false;
            results.mismatched.push(`version: ${versionInfo.version} → ${VERSION}`);
        }
        
        // Check files based on version.js manifest
        if (versionInfo.files) {
            for (const [file, expectedHash] of Object.entries(versionInfo.files)) {
                const filePath = path.join(targetDir, file);
                if (!fs.existsSync(filePath)) {
                    results.installed = false;
                    results.missing.push(file);
                } else {
                    const actualHash = hashFile(filePath);
                    if (actualHash !== expectedHash) {
                        results.installed = false;
                        results.mismatched.push(`${file}: hash mismatch`);
                    }
                }
            }
        }
    }

    // Also check that ensure-installed.js itself exists
    const selfPath = path.join(targetDir, 'ensure-installed.js');
    if (!fs.existsSync(selfPath)) {
        results.installed = false;
        results.missing.push('ensure-installed.js');
    }

    return results;
}

// Main
const args = parseArgs();

if (args.error) {
    console.error(JSON.stringify({ error: 'INVALID_ARGS', message: args.error }));
    process.exit(2);
}

if (args.help) {
    showHelp();
    process.exit(0);
}

if (args.version) {
    showVersion();
    process.exit(0);
}

const targetDir = path.resolve(args.targetDir);

// Check if directory exists
if (!fs.existsSync(targetDir)) {
    console.log(JSON.stringify({
        installed: false,
        error: 'DIRECTORY_NOT_FOUND',
        message: `Directory does not exist: ${targetDir}`,
        action: 'CREATE_DIR'
    }));
    process.exit(2);
}

const stat = fs.statSync(targetDir);
if (!stat.isDirectory()) {
    console.log(JSON.stringify({
        installed: false,
        error: 'NOT_A_DIRECTORY',
        message: `Path is not a directory: ${targetDir}`,
        action: 'CHECK_PATH'
    }));
    process.exit(2);
}

// Check installation
const results = checkInstalled(targetDir);

if (results.installed) {
    console.log(JSON.stringify({
        installed: true,
        version: results.version,
        message: 'node-transfer is installed and up-to-date'
    }));
    process.exit(0);
} else {
    console.log(JSON.stringify({
        installed: false,
        missing: results.missing,
        mismatched: results.mismatched,
        currentVersion: results.version,
        requiredVersion: results.requiredVersion,
        action: 'DEPLOY',
        message: `Installation needed: ${results.missing.length} missing, ${results.mismatched.length} outdated`
    }));
    process.exit(1);
}
