#!/usr/bin/env node

/**
 * Verification and Validation Module
 * Performs post-installation checks and validation
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Check if OpenClaw is installed
 */
function checkOpenClawInstalled() {
  try {
    const openclawDir = path.join(os.homedir(), '.openclaw');
    const stats = fs.statSync(openclawDir);
    return {
      installed: true,
      path: openclawDir
    };
  } catch (error) {
    return {
      installed: false,
      path: null
    };
  }
}

/**
 * Check OpenClaw version
 */
function checkOpenClawVersion() {
  try {
    const version = execSync('openclaw --version', { encoding: 'utf8' });
    return {
      available: true,
      version: version.trim()
    };
  } catch (error) {
    return {
      available: false,
      version: null
    };
  }
}

/**
 * Check if config file exists
 */
function checkConfigFile() {
  const configPath = path.join(os.homedir(), '.openclaw', 'config.json');
  
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    
    return {
      exists: true,
      path: configPath,
      valid: true,
      config
    };
  } catch (error) {
    return {
      exists: false,
      path: configPath,
      valid: false,
      config: null
    };
  }
}

/**
 * Check gateway service status
 */
function checkGatewayService() {
  try {
    const output = execSync('systemctl is-active openclaw-gateway', {
      encoding: 'utf8'
    });
    
    const isActive = output.trim() === 'active';
    
    return {
      installed: true,
      active: isActive,
      status: isActive ? 'running' : 'stopped'
    };
  } catch (error) {
    return {
      installed: false,
      active: false,
      status: 'not installed'
    };
  }
}

/**
 * Check if gateway port is accessible
 */
function checkGatewayPort() {
  const configPath = path.join(os.homedir(), '.openclaw', 'config.json');
  
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    const port = config.gateway?.port || 18789;
    
    // Try to connect
    execSync(`curl -s http://localhost:${port} > /dev/null`, {
      stdio: 'ignore',
      timeout: 2000
    });
    
    return {
      accessible: true,
      port
    };
  } catch (error) {
    return {
      accessible: false,
      port: null
    };
  }
}

/**
 * Check directory permissions
 */
function checkPermissions() {
  const openclawDir = path.join(os.homedir(), '.openclaw');
  
  try {
    const stats = fs.statSync(openclawDir);
    const mode = stats.mode & 0o777;
    
    // Check if permissions are 700 (rwx------
    const correct = mode === 0o700;
    
    return {
      correct,
      mode: mode.toString(8),
      path: openclawDir
    };
  } catch (error) {
    return {
      correct: false,
      mode: 'unknown',
      path: openclawDir
    };
  }
}

/**
 * Test API key validity
 */
async function testApiKey(config) {
  if (!config || !config.model) {
    return { tested: false, valid: false };
  }
  
  const { provider, apiKey, defaultModel } = config.model;
  
  try {
    // Simple test based on provider
    if (provider === 'zhipu') {
      execSync(`curl -s -X POST https://open.bigmodel.cn/api/paas/v4/chat/completions \\
        -H "Content-Type: application/json" \\
        -H "Authorization: Bearer ${apiKey}" \\
        -d '{"model":"${defaultModel}","messages":[{"role":"user","content":"hi"}]}' \\
        --max-time 10`, { stdio: 'ignore' });
    } else if (provider === 'openai') {
      execSync(`curl -s -X POST https://api.openai.com/v1/chat/completions \\
        -H "Content-Type: application/json" \\
        -H "Authorization: Bearer ${apiKey}" \\
        -d '{"model":"${defaultModel}","messages":[{"role":"user","content":"hi"}]}' \\
        --max-time 10`, { stdio: 'ignore' });
    }
    
    return { tested: true, valid: true };
  } catch (error) {
    return { tested: true, valid: false };
  }
}

/**
 * Run comprehensive verification
 */
async function runVerification() {
  console.log('');
  console.log('═════════════════════════════════════════');
  console.log('🔍 Running Verification Checks');
  console.log('═════════════════════════════════════════');
  console.log('');
  
  const checks = {};
  const issues = [];
  
  // Check 1: OpenClaw installed
  console.log('Checking OpenClaw installation...');
  checks.installation = checkOpenClawInstalled();
  if (checks.installation.installed) {
    console.log('  ✅ OpenClaw installed');
  } else {
    console.log('  ❌ OpenClaw not found');
    issues.push('OpenClaw not installed');
  }
  
  // Check 2: OpenClaw version
  console.log('Checking OpenClaw version...');
  checks.version = checkOpenClawVersion();
  if (checks.version.available) {
    console.log(`  ✅ ${checks.version.version}`);
  } else {
    console.log('  ❌ Cannot determine version');
    issues.push('OpenClaw version unknown');
  }
  
  // Check 3: Config file
  console.log('Checking configuration...');
  checks.config = checkConfigFile();
  if (checks.config.exists && checks.config.valid) {
    console.log(`  ✅ Config found at ${checks.config.path}`);
  } else {
    console.log('  ❌ Config missing or invalid');
    issues.push('Configuration not found');
  }
  
  // Check 4: Permissions
  console.log('Checking directory permissions...');
  checks.permissions = checkPermissions();
  if (checks.permissions.correct) {
    console.log(`  ✅ Permissions correct (${checks.permissions.mode})`);
  } else {
    console.log(`  ⚠️  Permissions incorrect (${checks.permissions.mode}, should be 700)`);
    issues.push('Directory permissions incorrect');
  }
  
  // Check 5: Gateway service
  console.log('Checking gateway service...');
  checks.service = checkGatewayService();
  if (checks.service.active) {
    console.log(`  ✅ Gateway service ${checks.service.status}`);
  } else if (checks.service.installed) {
    console.log(`  ⚠️  Gateway service installed but not running`);
    issues.push('Gateway service not running');
  } else {
    console.log(`  ⚠️  Gateway service not installed`);
    issues.push('Gateway service not configured');
  }
  
  // Check 6: Gateway port
  if (checks.service.active) {
    console.log('Checking gateway accessibility...');
    checks.port = checkGatewayPort();
    if (checks.port.accessible) {
      console.log(`  ✅ Gateway accessible on port ${checks.port.port}`);
    } else {
      console.log(`  ❌ Gateway not accessible`);
      issues.push('Gateway port not accessible');
    }
  }
  
  // Check 7: API key
  if (checks.config.valid) {
    console.log('Testing API key...');
    checks.apiKey = await testApiKey(checks.config.config);
    if (checks.apiKey.valid) {
      console.log('  ✅ API key valid');
    } else if (checks.apiKey.tested) {
      console.log('  ❌ API key invalid or API unreachable');
      issues.push('API key validation failed');
    } else {
      console.log('  ⚠️  API key not tested');
    }
  }
  
  console.log('');
  console.log('═════════════════════════════════════════');
  
  if (issues.length === 0) {
    console.log('✅ All Checks Passed!');
    console.log('═════════════════════════════════════════');
    return true;
  } else {
    console.log('⚠️  Issues Found:');
    issues.forEach(issue => {
      console.log(`   - ${issue}`);
    });
    console.log('═════════════════════════════════════════');
    return false;
  }
}

/**
 * Generate verification report
 */
function generateReport(checks) {
  const lines = [];
  
  lines.push('OpenClaw Verification Report');
  lines.push('===========================');
  lines.push('');
  
  if (checks.installation.installed) {
    lines.push(`✅ Installation: ${checks.installation.path}`);
  } else {
    lines.push('❌ Installation: Not found');
  }
  
  if (checks.version.available) {
    lines.push(`✅ Version: ${checks.version.version}`);
  } else {
    lines.push('❌ Version: Unknown');
  }
  
  if (checks.config.exists) {
    lines.push(`✅ Config: ${checks.config.path}`);
  } else {
    lines.push('❌ Config: Not found');
  }
  
  if (checks.service.active) {
    lines.push(`✅ Service: ${checks.service.status}`);
  } else {
    lines.push(`⚠️  Service: ${checks.service.status}`);
  }
  
  return lines.join('\n');
}

module.exports = {
  checkOpenClawInstalled,
  checkOpenClawVersion,
  checkConfigFile,
  checkGatewayService,
  checkGatewayPort,
  checkPermissions,
  testApiKey,
  runVerification,
  generateReport
};

// If run directly, execute verification
if (require.main === module) {
  runVerification().then(success => {
    process.exit(success ? 0 : 1);
  });
}
