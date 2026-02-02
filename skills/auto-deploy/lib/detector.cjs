#!/usr/bin/env node

/**
 * Environment Detection Module
 * Detects OS, version, and system information for OpenClaw deployment
 */

const fs = require('fs');
const { execSync } = require('child_process');

/**
 * Detect OS information
 */
function detectOS() {
  try {
    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    const info = {};

    // Parse key-value pairs
    osRelease.split('\n').forEach(line => {
      const match = line.match(/^(\w+)=(.*)$/);
      if (match) {
        let value = match[2];
        // Remove quotes
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1);
        }
        info[match[1]] = value;
      }
    });

    return {
      name: info.NAME || info.ID || 'Unknown',
      id: info.ID || 'unknown',
      version: info.VERSION_ID || 'unknown',
      prettyName: info.PRETTY_NAME || 'Unknown Linux'
    };
  } catch (error) {
    return {
      name: 'Unknown',
      id: 'unknown',
      version: 'unknown',
      prettyName: 'Unknown Linux'
    };
  }
}

/**
 * Detect kernel information
 */
function detectKernel() {
  try {
    const uname = execSync('uname -a', { encoding: 'utf8' });
    return uname.trim();
  } catch (error) {
    return 'Unknown kernel';
  }
}

/**
 * Detect architecture
 */
function detectArch() {
  try {
    const arch = execSync('uname -m', { encoding: 'utf8' });
    return arch.trim();
  } catch (error) {
    return 'unknown';
  }
}

/**
 * Check if Node.js is installed
 */
function checkNodeVersion() {
  try {
    const version = execSync('node --version', { encoding: 'utf8' });
    const versionNum = version.trim().replace('v', '');
    
    // Parse major version
    const major = parseInt(versionNum.split('.')[0]);
    
    return {
      installed: true,
      version: version.trim(),
      major,
      meetsRequirement: major >= 22
    };
  } catch (error) {
    return {
      installed: false,
      version: null,
      major: 0,
      meetsRequirement: false
    };
  }
}

/**
 * Check if Git is installed
 */
function checkGit() {
  try {
    const version = execSync('git --version', { encoding: 'utf8' });
    return {
      installed: true,
      version: version.trim()
    };
  } catch (error) {
    return {
      installed: false,
      version: null
    };
  }
}

/**
 * Check available disk space
 */
function checkDiskSpace() {
  try {
    const output = execSync('df -h / | tail -1', { encoding: 'utf8' });
    const parts = output.trim().split(/\s+/);
    
    const available = parts[3]; // e.g., "50G"
    const usedPercent = parts[4]; // e.g., "30%"
    
    return {
      available,
      usedPercent,
      sufficient: true // TODO: Parse actual GB value
    };
  } catch (error) {
    return {
      available: 'unknown',
      usedPercent: 'unknown',
      sufficient: false
    };
  }
}

/**
 * Check available RAM
 */
function checkRAM() {
  try {
    const output = execSync('free -h | grep Mem', { encoding: 'utf8' });
    const parts = output.trim().split(/\s+/);
    
    const total = parts[1]; // e.g., "2.0Gi"
    
    return {
      total,
      sufficient: true // TODO: Parse actual GB value
    };
  } catch (error) {
    return {
      total: 'unknown',
      sufficient: false
    };
  }
}

/**
 * Check network connectivity
 */
function checkNetwork() {
  try {
    // Try to reach a reliable server
    execSync('curl -s --max-time 5 https://www.google.com > /dev/null', {
      stdio: 'ignore'
    });
    return { connected: true };
  } catch (error) {
    return { connected: false };
  }
}

/**
 * Main detection function
 */
function detectEnvironment() {
  const os = detectOS();
  const kernel = detectKernel();
  const arch = detectArch();
  const node = checkNodeVersion();
  const git = checkGit();
  const disk = checkDiskSpace();
  const ram = checkRAM();
  const network = checkNetwork();

  return {
    os,
    kernel,
    arch,
    node,
    git,
    disk,
    ram,
    network,
    supported: isSupportedOS(os.id)
  };
}

/**
 * Check if OS is supported
 */
function isSupportedOS(osId) {
  const supported = [
    'opencloudos',
    'rhel',
    'centos',
    'ubuntu',
    'debian'
  ];
  
  return supported.some(id => osId.toLowerCase().includes(id));
}

/**
 * Generate detection report
 */
function generateReport(env) {
  const lines = [];
  
  lines.push('═════════════════════════════════════════');
  lines.push('🖥️  Environment Detection Report');
  lines.push('═════════════════════════════════════════');
  lines.push('');
  
  // OS Info
  lines.push(`OS: ${env.os.prettyName}`);
  lines.push(`Kernel: ${env.kernel}`);
  lines.push(`Architecture: ${env.arch}`);
  lines.push(`Supported: ${env.supported ? '✅ Yes' : '❌ No'}`);
  lines.push('');
  
  // Software
  lines.push('Software:');
  lines.push(`  Node.js: ${env.node.installed ? env.node.version + (env.node.meetsRequirement ? ' ✅' : ' ❌ Need 22+') : '❌ Not installed'}`);
  lines.push(`  Git: ${env.git.installed ? env.git.version + ' ✅' : '❌ Not installed'}`);
  lines.push('');
  
  // Resources
  lines.push('Resources:');
  lines.push(`  Disk: ${env.disk.available} available (${env.disk.usedPercent} used)`);
  lines.push(`  RAM: ${env.ram.total} total`);
  lines.push(`  Network: ${env.network.connected ? '✅ Connected' : '❌ No connection'}`);
  lines.push('');
  
  // Status
  const issues = [];
  if (!env.node.meetsRequirement) issues.push('Node.js 22+ required');
  if (!env.git.installed) issues.push('Git required');
  if (!env.network.connected) issues.push('Network connectivity required');
  
  if (issues.length === 0) {
    lines.push('✅ All requirements met!');
  } else {
    lines.push('⚠️  Issues found:');
    issues.forEach(issue => lines.push(`   - ${issue}`));
  }
  
  lines.push('═════════════════════════════════════════');
  
  return lines.join('\n');
}

// Export functions
module.exports = {
  detectEnvironment,
  detectOS,
  checkNodeVersion,
  checkGit,
  checkDiskSpace,
  checkRAM,
  checkNetwork,
  isSupportedOS,
  generateReport
};

// If run directly, output report
if (require.main === module) {
  const env = detectEnvironment();
  console.log(generateReport(env));
}
