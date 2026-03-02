#!/usr/bin/env node
/**
 * Kimi ACP Agent Adapter for OpenClaw
 * 
 * This script makes Kimi CLI work as a first-class ACP agent by:
 * 1. Intercepting acpx-style commands
 * 2. Translating them to Kimi CLI equivalents
 * 3. Returning acpx-compatible JSON responses
 * 
 * Usage: node kimi-adapter.js <command> [args...]
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const SESSION_DIR = path.join(os.homedir(), '.acpx-kimi', 'sessions');

// Ensure session directory exists
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function generateSessionId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function readSession(name) {
  const file = path.join(SESSION_DIR, `${name}.json`);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

function writeSession(name, data) {
  const file = path.join(SESSION_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function deleteSession(name) {
  const file = path.join(SESSION_DIR, `${name}.json`);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

function listSessions() {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs.readdirSync(SESSION_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

function outputJson(data) {
  console.log(JSON.stringify(data));
}

function runKimiAcp(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['acp'];
    
    if (options.approveAll) args.push('--approve-all');
    if (options.cwd) args.push('--cwd', options.cwd);
    if (options.timeout) args.push('--timeout', String(options.timeout));
    
    const child = spawn(KIMI_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      // Pass through stdout
      process.stdout.write(data);
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      // Pass through stderr
      process.stderr.write(data);
    });
    
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Kimi exited with code ${code}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
    
    child.on('error', reject);
    
    // Send prompt to stdin
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  if (!command) {
    console.error('Usage: kimi-adapter.js <command> [args...]');
    process.exit(1);
  }
  
  switch (command) {
    case 'sessions': {
      const subcommand = args[1];
      
      if (subcommand === 'new' || subcommand === 'ensure') {
        let name = 'kimi-session';
        let i = 2;
        while (i < args.length) {
          if (args[i] === '--name' && i + 1 < args.length) {
            name = args[i + 1];
            i += 2;
          } else {
            i++;
          }
        }
        
        const sessionId = generateSessionId();
        writeSession(name, {
          name,
          id: sessionId,
          created: Date.now(),
          agent: 'kimi'
        });
        
        outputJson({
          acpxSessionId: sessionId,
          agentSessionId: sessionId,
          acpxRecordId: sessionId
        });
      } else if (subcommand === 'close') {
        const name = args[2];
        if (name) deleteSession(name);
        process.exit(0);
      } else {
        // List sessions
        const sessions = listSessions();
        sessions.forEach(s => console.log(s));
      }
      break;
    }
    
    case 'status': {
      outputJson({
        status: 'ready',
        pid: process.pid
      });
      break;
    }
    
    case 'set-mode':
    case 'set': {
      // Kimi doesn't support these, just acknowledge
      process.exit(0);
      break;
    }
    
    case 'prompt': {
      let sessionName = '';
      let useStdin = false;
      let promptText = '';
      
      let i = 1;
      while (i < args.length) {
        if (args[i] === '--session' && i + 1 < args.length) {
          sessionName = args[i + 1];
          i += 2;
        } else if (args[i] === '--file' && i + 1 < args.length) {
          if (args[i + 1] === '-') {
            useStdin = true;
          }
          i += 2;
        } else {
          promptText += args[i] + ' ';
          i++;
        }
      }
      
      if (useStdin) {
        // Read from stdin
        let stdinData = '';
        process.stdin.on('data', (data) => {
          stdinData += data.toString();
        });
        process.stdin.on('end', async () => {
          try {
            await runKimiAcp(stdinData, { approveAll: true });
          } catch (err) {
            console.error('Error:', err.message);
            process.exit(1);
          }
        });
      } else {
        try {
          await runKimiAcp(promptText.trim(), { approveAll: true });
        } catch (err) {
          console.error('Error:', err.message);
          process.exit(1);
        }
      }
      break;
    }
    
    case 'exec': {
      const promptText = args.slice(1).join(' ');
      try {
        await runKimiAcp(promptText, { approveAll: true });
      } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
      }
      break;
    }
    
    default: {
      // Unknown command, try to pass to kimi directly
      const child = spawn(KIMI_BIN, [command, ...args.slice(1)], {
        stdio: 'inherit'
      });
      child.on('close', (code) => process.exit(code || 0));
      break;
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});