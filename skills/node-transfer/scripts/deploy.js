#!/usr/bin/env node

/**
 * deploy.js - Agent deployment script for node-transfer
 * 
 * This script is run BY THE MAIN AGENT to deploy node-transfer scripts TO A TARGET NODE.
 * It reads local files, base64 encodes them, and uses nodes.invoke to write them remotely.
 * 
 * Usage: node deploy.js <nodeId> [targetDir]
 * 
 * Example:
 *   node deploy.js E3V3
 *   node deploy.js E3V3 C:/custom/path/node-transfer
 * 
 * The target directory structure will be:
 *   <targetDir>/
 *     ├── send.js
 *     ├── receive.js
 *     ├── ensure-installed.js
 *     └── version.js
 */

const fs = require('fs');
const path = require('path');

const FILES_TO_DEPLOY = ['send.js', 'receive.js', 'ensure-installed.js', 'version.js'];
const VERSION = '1.0.1';

function showHelp() {
    console.log(`
node-transfer deploy.js v${VERSION}

Deploys node-transfer scripts to a remote OpenClaw node.
This script is run by the main agent, not on the target node.

Usage:
  node deploy.js <nodeId> [targetDir]

Arguments:
  nodeId         Target node ID (required)
  targetDir      Installation directory on target (default: C:/openclaw/skills/node-transfer/scripts)

Environment Variables:
  TRANSFER_TARGET_DIR  Override default target directory

Examples:
  node deploy.js E3V3
  node deploy.js E3V3 C:/custom/path
  TRANSFER_TARGET_DIR=D:/tools node deploy.js MyNode

What this script does:
  1. Reads local script files
  2. Base64 encodes them (avoids PowerShell escaping issues)
  3. Generates a PowerShell command to:
     - Create target directory
     - Decode and write each file
     - Verify installation
  4. Outputs the command for nodes.invoke()

Note: This outputs a script. Run it via:
  nodes.invoke({
    node: '<nodeId>',
    command: ['powershell', '-Command', '<generated_script>']
  })
`);
}

function showVersion() {
    console.log(VERSION);
}

function encodeFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return Buffer.from(content, 'utf8').toString('base64');
}

function generateDeployCommand(nodeId, targetDir) {
    const scriptsDir = targetDir;
    
    // Build PowerShell script
    let psScript = `
# node-transfer deployment script
# Target: ${nodeId}
# Directory: ${scriptsDir}

$ErrorActionPreference = "Stop"

# Create directory
New-Item -ItemType Directory -Force -Path "${scriptsDir.replace(/\//g, '\\')}" | Out-Null

`.trim();

    // Add file writes
    for (const file of FILES_TO_DEPLOY) {
        const filePath = path.join(__dirname, file);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Source file not found: ${filePath}`);
        }
        
        const encoded = encodeFile(filePath);
        const targetPath = path.join(scriptsDir, file).replace(/\//g, '\\');
        
        psScript += `\n\n`;
        psScript += `# Deploy ${file}\n`;
        psScript += `$b64 = "${encoded}"\n`;
        psScript += `[System.IO.File]::WriteAllBytes("${targetPath}", [System.Convert]::FromBase64String($b64))`;
    }

    // Add verification
    psScript += `\n\n`;
    psScript += `# Verify installation\n`;
    psScript += `node "${path.join(scriptsDir, 'ensure-installed.js').replace(/\//g, '\\')}" "${scriptsDir.replace(/\//g, '\\')}"`;

    return psScript;
}

// Main
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
    showVersion();
    process.exit(0);
}

const nodeId = args[0];
const targetDir = args[1] || process.env.TRANSFER_TARGET_DIR || 'C:/openclaw/skills/node-transfer/scripts';

if (!nodeId) {
    console.error('Error: No node ID provided');
    console.error('Usage: node deploy.js <nodeId> [targetDir]');
    process.exit(1);
}

// Validate local files exist
for (const file of FILES_TO_DEPLOY) {
    const filePath = path.join(__dirname, file);
    if (!fs.existsSync(filePath)) {
        console.error(`Error: Source file not found: ${file}`);
        process.exit(1);
    }
}

try {
    const psScript = generateDeployCommand(nodeId, targetDir);
    
    // Output structured result
    const output = {
        action: "DEPLOY",
        node: nodeId,
        targetDir: targetDir,
        files: FILES_TO_DEPLOY,
        commandType: "powershell",
        script: psScript,
        // Pre-escaped version for direct use
        escapedScript: psScript.replace(/"/g, '\\"').replace(/\n/g, '; '),
        usage: {
            javascript: `// Example: Deploy to node
const script = ${JSON.stringify(psScript)};
await nodes.invoke({
    node: '${nodeId}',
    command: ['powershell', '-Command', script]
});`,
            cli: `# Save to file and execute:
# Write the 'script' field to deploy-${nodeId}.ps1
# Then run: powershell -File deploy-${nodeId}.ps1`
        }
    };

    console.log(JSON.stringify(output, null, 2));

    // Also write to file for manual execution
    const outputPath = path.join(__dirname, `deploy-${nodeId}.ps1`);
    fs.writeFileSync(outputPath, psScript, 'utf8');
    console.error(`\n# Deployment script written to: ${outputPath}`);
    console.error(`# Or use via nodes.invoke() with the 'script' field above`);

} catch (err) {
    console.error(JSON.stringify({ error: 'DEPLOY_FAILED', message: err.message }));
    process.exit(1);
}
