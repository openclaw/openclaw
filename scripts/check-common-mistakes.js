#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

// Colors
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const BOLD = "\x1b[1m";

function log(msg) { console.log(msg); }
function error(msg) { console.log(`${RED}✖ ${msg}${RESET}`); }
function warning(msg) { console.log(`${YELLOW}⚠ ${msg}${RESET}`); }
function success(msg) { console.log(`${GREEN}✔ ${msg}${RESET}`); }
function info(msg) { console.log(`${BLUE}ℹ ${msg}${RESET}`); }

// 1. Find Config
function findConfig() {
  // Check if path provided as argument
  if (process.argv[2]) {
    const argPath = path.resolve(process.argv[2]);
    if (fs.existsSync(argPath)) {
      return argPath;
    }
    error(`Provided config file not found: ${argPath}`);
    process.exit(1);
  }

  const homeDir = os.homedir();
  const configPath = path.join(homeDir, '.openclaw', 'openclaw.json');
  
  if (!fs.existsSync(configPath)) {
    error(`Configuration file not found at ${configPath}`);
    info(`To create one, run: openclaw onboard`);
    process.exit(1);
  }
  return configPath;
}

// 2. Load Config
function loadConfig(configPath) {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    // Basic check for missing env vars in the raw string before parsing
    const missingVars = [];
    const envVarRegex = /\$\{([A-Z0-9_]+)\}/g;
    let match;
    while ((match = envVarRegex.exec(content)) !== null) {
      if (!process.env[match[1]]) {
        missingVars.push(match[1]);
      }
    }
    
    return {
      data: JSON.parse(content),
      missingVars: [...new Set(missingVars)]
    };
  } catch (e) {
    error(`Failed to parse configuration file: ${e.message}`);
    process.exit(1);
  }
}

// Checks
function runChecks(config, missingVars) {
  let issues = 0;

  log(`\n${BOLD}Running Configuration Checks...${RESET}\n`);

  // Check 1: Insecure Passwords
  if (config.gateway?.auth?.password) {
    const pwd = config.gateway.auth.password;
    const weakPasswords = ['password', 'admin', '123456', 'change-me', 'change-me-please'];
    if (weakPasswords.includes(pwd)) {
      warning(`Weak password detected: "${pwd}". Please change it.`);
      issues++;
    } else if (pwd.length < 8 && !pwd.startsWith('${')) {
      warning(`Password is short (${pwd.length} chars). Recommend 8+ characters.`);
      issues++;
    } else {
      success('Password looks seemingly okay.');
    }
  } else {
    // If auth mode is password but no password set?
    if (config.gateway?.auth?.mode === 'password' && !config.gateway.auth.password) {
      error('Auth mode is "password" but no password provided!');
      issues++;
    }
  }

  // Check 2: Overly Permissive allowFrom
  const channels = config.channels || {};
  for (const [name, conf] of Object.entries(channels)) {
    if (!conf.enabled) continue;
    
    if (!conf.allowFrom || conf.allowFrom.length === 0) {
      warning(`Channel "${name}" has no 'allowFrom' set. Default might be deny-all.`);
      issues++;
    } else if (conf.allowFrom.includes('*')) {
      warning(`Channel "${name}" allows EVERYONE ('*'). Highly insecure for production.`);
      issues++;
    } else {
      success(`Channel "${name}" has restricted access.`);
    }
  }

  // Check 3: Exposed Gateway
  if (config.gateway?.bind === '0.0.0.0' || config.gateway?.bind === 'lan') {
    warning(`Gateway is bound to '${config.gateway.bind}' (exposed to network). Ensure firewall is active.`);
    issues++;
  } else {
    success(`Gateway bound to ${config.gateway?.bind || 'localhost'}.`);
  }

  // Check 4: Expensive Models
  const model = config.agent?.model || '';
  if (model.includes('opus') || model.includes('gpt-4')) {
    info(`Using high-end model: ${model}. Monitor your costs.`);
  } else {
    success(`Model selection seems cost-effective: ${model}`);
  }
  
  if (config.agent?.maxTokens && config.agent.maxTokens > 8192) {
      warning(`maxTokens set to ${config.agent.maxTokens}. High values can be expensive.`);
      issues++;
  }

  // Check 5: Unsafe Exec Config
  const execTool = config.tools?.exec || {};
  if (execTool.enabled) {
    if (execTool.approvals === 'off') {
      error(`Exec tool enabled with approvals='off'. EXTREMELY DANGEROUS.`);
      issues++;
    } else {
      success('Exec tool requires approvals.');
    }
  }

  // Check 6: Missing Environment Variables
  if (missingVars.length > 0) {
    warning(`Missing environment variables referenced in config: ${missingVars.join(', ')}`);
    issues++;
  } else {
    success('All referenced environment variables are set.');
  }

  // Check 7: DM Policy Issues
  ['discord', 'slack', 'telegram'].forEach(ch => {
    if (channels[ch]?.enabled && channels[ch]?.dmPolicy === 'open' && channels[ch]?.allowFrom?.includes('*')) {
       warning(`Channel "${ch}" has dmPolicy='open' AND allowFrom='*'. Anyone can message your bot!`);
       issues++;
    }
  });

  return issues;
}

// Main
function main() {
  log(`${BOLD}🦞 OpenClaw Configuration Checker${RESET}`);
  
  const configPath = findConfig();
  log(`Reading config from: ${configPath}`);
  
  const { data, missingVars } = loadConfig(configPath);
  
  const issues = runChecks(data, missingVars);
  
  log('\n---------------------------------------------------');
  if (issues === 0) {
    log(`${GREEN}${BOLD}SUCCESS! No obvious configuration issues found.${RESET}`);
    process.exit(0);
  } else {
    log(`${YELLOW}${BOLD}Found ${issues} potential issue(s). Please review above.${RESET}`);
    process.exit(1);
  }
}

main();
