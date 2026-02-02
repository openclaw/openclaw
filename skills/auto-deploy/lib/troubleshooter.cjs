#!/usr/bin/env node

/**
 * Troubleshooting & Diagnostics Module
 * Detects and fixes 10+ common OpenClaw installation issues
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Issue definitions with detection and fix functions
 */
const ISSUES = [
  {
    id: 'node_version',
    name: 'Node.js 版本过低',
    severity: 'critical',
    detect: () => {
      try {
        const version = execSync('node --version', { encoding: 'utf8' });
        const major = parseInt(version.trim().replace('v', '').split('.')[0]);
        return major < 22;
      } catch {
        return true;
      }
    },
    fix: async () => {
      console.log('❌ Node.js 22+ required. Please upgrade manually:');
      console.log('   Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_22.x | bash -');
      console.log('   RHEL/CentOS: curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -');
      return false;
    }
  },
  {
    id: 'missing_token',
    name: 'Gateway 认证 Token 缺失',
    severity: 'critical',
    detect: () => {
      const configPath = path.join(os.homedir(), '.openclaw', 'config.json');
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return !config.gateway?.auth?.token && !config.gateway?.authToken;
      } catch {
        return true;
      }
    },
    fix: async () => {
      const crypto = require('crypto');
      const token = crypto.randomBytes(32).toString('hex');
      const configPath = path.join(os.homedir(), '.openclaw', 'config.json');
      
      try {
        let config = {};
        try {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch {}
        
        if (!config.gateway) config.gateway = {};
        config.gateway.authToken = token;
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`✅ Generated token: ${token.substring(0, 8)}...`);
        return true;
      } catch (error) {
        console.log(`❌ Failed to generate token: ${error.message}`);
        return false;
      }
    }
  },
  {
    id: 'auth_mode_error',
    name: 'Gateway 认证模式配置错误',
    severity: 'warning',
    detect: () => {
      const configPath = path.join(os.homedir(), '.openclaw', 'config.json');
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const auth = config.gateway?.auth;
        // Check if using old auth format
        return auth && typeof auth === 'object' && !auth.token && !authToken;
      } catch {
        return false;
      }
    },
    fix: async () => {
      const configPath = path.join(os.homedir(), '.openclaw', 'config.json');
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        
        // Migrate old auth format to new
        if (config.gateway?.auth) {
          const { auth, ...rest } = config.gateway;
          config.gateway = rest;
        }
        
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('✅ Auth configuration migrated');
        return true;
      } catch (error) {
        console.log(`❌ Failed to migrate: ${error.message}`);
        return false;
      }
    }
  },
  {
    id: 'permissions',
    name: '目录权限问题',
    severity: 'warning',
    detect: () => {
      const openclawDir = path.join(os.homedir(), '.openclaw');
      try {
        const stats = fs.statSync(openclawDir);
        const mode = stats.mode & 0o777;
        return mode !== 0o700;
      } catch {
        return false;
      }
    },
    fix: async () => {
      const openclawDir = path.join(os.homedir(), '.openclaw');
      try {
        execSync(`chmod -R 700 ${openclawDir}`, { stdio: 'inherit' });
        console.log('✅ Permissions fixed to 700');
        return true;
      } catch (error) {
        console.log(`❌ Failed to fix permissions: ${error.message}`);
        return false;
      }
    }
  },
  {
    id: 'missing_directories',
    name: '必需目录缺失',
    severity: 'warning',
    detect: () => {
      const openclawDir = path.join(os.homedir(), '.openclaw');
      const requiredDirs = [
        'agents/main/sessions',
        'credentials',
        'workspace',
        'memory'
      ];
      
      return requiredDirs.some(dir => {
        const fullPath = path.join(openclawDir, dir);
        return !fs.existsSync(fullPath);
      });
    },
    fix: async () => {
      const openclawDir = path.join(os.homedir(), '.openclaw');
      const dirs = [
        path.join(openclawDir, 'agents/main/sessions'),
        path.join(openclawDir, 'credentials'),
        path.join(openclawDir, 'workspace'),
        path.join(openclawDir, 'memory')
      ];
      
      try {
        dirs.forEach(dir => {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
        });
        console.log('✅ Required directories created');
        return true;
      } catch (error) {
        console.log(`❌ Failed to create directories: ${error.message}`);
        return false;
      }
    }
  },
  {
    id: 'old_config',
    name: '旧配置残留',
    severity: 'info',
    detect: () => {
      const oldPaths = [
        path.join(os.homedir(), '.clawdbot'),
        path.join(os.homedir(), '.claw'),
      ];
      
      return oldPaths.some(p => fs.existsSync(p));
    },
    fix: async () => {
      const oldPaths = [
        path.join(os.homedir(), '.clawdbot'),
        path.join(os.homedir(), '.claw'),
      ];
      
      console.log('⚠️  Old installation detected:');
      oldPaths.forEach(p => {
        if (fs.existsSync(p)) {
          console.log(`   - ${p}`);
        }
      });
      console.log('   Consider backing up and removing old config:');
      console.log(`   mv ${oldPaths[0]} ${oldPaths[0]}.backup`);
      return true;
    }
  },
  {
    id: 'systemd_not_running',
    name: 'systemd 用户服务未运行',
    severity: 'info',
    detect: () => {
      try {
        execSync('systemctl --user status', { stdio: 'ignore' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async () => {
      console.log('⚠️  systemd user service not available.');
      console.log('   Make sure you\'re logged in (not via SSH with sudo).');
      console.log('   Run: loginctl enable-linger');
      return false;
    }
  },
  {
    id: 'port_conflict',
    name: 'SSH 隧道端口被占用',
    severity: 'warning',
    detect: () => {
      try {
        const output = execSync('netstat -tuln | grep :8888', { encoding: 'utf8' });
        return output.trim().length > 0;
      } catch {
        return false;
      }
    },
    fix: async () => {
      console.log('⚠️  Port 8888 is in use.');
      console.log('   Find the process: lsof -i :8888');
      console.log('   Or use a different port: ssh -L 8889:localhost:18789 ...');
      return false;
    }
  },
  {
    id: 'missing_git',
    name: 'Git 未安装',
    severity: 'critical',
    detect: () => {
      try {
        execSync('which git', { stdio: 'ignore' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async () => {
      const { detectOS } = require('./detector');
      const os = detectOS();
      const osId = os.id.toLowerCase();
      
      console.log('Installing Git...');
      try {
        if (osId.includes('ubuntu') || osId.includes('debian')) {
          execSync('apt-get install -y git', { stdio: 'inherit' });
        } else if (osId.includes('rhel') || osId.includes('centos') || osId.includes('opencloudos')) {
          execSync('dnf install -y git', { stdio: 'inherit' });
        }
        console.log('✅ Git installed');
        return true;
      } catch (error) {
        console.log(`❌ Failed to install Git: ${error.message}`);
        return false;
      }
    }
  },
  {
    id: 'dashboard_auth_error',
    name: 'Dashboard 认证错误',
    severity: 'warning',
    detect: () => {
      // This would require actually testing the dashboard
      // For now, just check if token exists
      const configPath = path.join(os.homedir(), '.openclaw', 'config.json');
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return !config.gateway?.authToken && !config.gateway?.auth?.token;
      } catch {
        return true;
      }
    },
    fix: async () => {
      console.log('Make sure you\'re accessing the dashboard with the correct token:');
      console.log('  http://localhost:18789?token=<YOUR_TOKEN>');
      return false;
    }
  },
  {
    id: 'gateway_not_running',
    name: 'Gateway 服务未运行',
    severity: 'critical',
    detect: () => {
      try {
        execSync('openclaw gateway status', { stdio: 'ignore' });
        return false;
      } catch {
        return true;
      }
    },
    fix: async () => {
      console.log('Starting Gateway...');
      try {
        execSync('openclaw gateway start', { stdio: 'inherit' });
        console.log('✅ Gateway started');
        return true;
      } catch (error) {
        console.log(`❌ Failed to start Gateway: ${error.message}`);
        console.log('   Try: openclaw gateway start');
        return false;
      }
    }
  }
];

/**
 * Run all diagnostic checks
 */
async function runDiagnostics() {
  console.log('');
  console.log('═════════════════════════════════════════');
  console.log('🔍 Running Diagnostics');
  console.log('═════════════════════════════════════════');
  console.log('');
  
  const results = {
    critical: [],
    warning: [],
    info: []
  };
  
  for (const issue of ISSUES) {
    const hasIssue = issue.detect();
    
    if (hasIssue) {
      const result = {
        id: issue.id,
        name: issue.name,
        severity: issue.severity,
        fixed: false
      };
      
      console.log(`[${issue.severity.toUpperCase()}] ${issue.name}`);
      
      results[issue.severity].push(result);
    }
  }
  
  console.log('');
  console.log('═════════════════════════════════════════');
  
  const totalIssues = results.critical.length + results.warning.length + results.info.length;
  
  if (totalIssues === 0) {
    console.log('✅ No issues found!');
    console.log('═════════════════════════════════════════');
    return true;
  }
  
  console.log(`Found ${totalIssues} issue(s):`);
  console.log(`  Critical: ${results.critical.length}`);
  console.log(`  Warning: ${results.warning.length}`);
  console.log(`  Info: ${results.info.length}`);
  console.log('═════════════════════════════════════════');
  
  return results;
}

/**
 * Auto-fix all detected issues
 */
async function autoFix(results) {
  if (!results || typeof results === 'boolean') {
    results = await runDiagnostics();
  }
  
  if (results === true) {
    return true;
  }
  
  console.log('');
  console.log('═════════════════════════════════════════');
  console.log('🔧 Attempting Auto-Fix');
  console.log('═════════════════════════════════════════');
  console.log('');
  
  let fixed = 0;
  let failed = 0;
  
  const allIssues = [
    ...results.critical,
    ...results.warning,
    ...results.info
  ];
  
  for (const result of allIssues) {
    const issue = ISSUES.find(i => i.id === result.id);
    if (!issue) continue;
    
    console.log(`Fixing: ${result.name}`);
    const success = await issue.fix();
    
    if (success) {
      fixed++;
      console.log('✅ Fixed');
    } else {
      failed++;
      console.log('❌ Failed (manual intervention required)');
    }
    console.log('');
  }
  
  console.log('═════════════════════════════════════════');
  console.log(`Fixed: ${fixed} | Failed: ${failed}`);
  console.log('═════════════════════════════════════════');
  
  return failed === 0;
}

/**
 * Generate diagnostics report
 */
function generateReport(results) {
  const lines = [];
  
  lines.push('OpenClaw Diagnostics Report');
  lines.push('============================');
  lines.push('');
  
  if (results === true) {
    lines.push('✅ All checks passed!');
    return lines.join('\n');
  }
  
  if (results.critical.length > 0) {
    lines.push('CRITICAL:');
    results.critical.forEach(r => {
      lines.push(`  ❌ ${r.name}`);
    });
    lines.push('');
  }
  
  if (results.warning.length > 0) {
    lines.push('WARNINGS:');
    results.warning.forEach(r => {
      lines.push(`  ⚠️  ${r.name}`);
    });
    lines.push('');
  }
  
  if (results.info.length > 0) {
    lines.push('INFO:');
    results.info.forEach(r => {
      lines.push(`  ℹ️  ${r.name}`);
    });
  }
  
  return lines.join('\n');
}

module.exports = {
  runDiagnostics,
  autoFix,
  generateReport,
  ISSUES
};

// If run directly, execute diagnostics
if (require.main === module) {
  const args = process.argv.slice(2);
  const shouldFix = args.includes('--fix');
  
  (async () => {
    const results = await runDiagnostics();
    
    if (shouldFix && results !== true) {
      const fixed = await autoFix(results);
      process.exit(fixed ? 0 : 1);
    } else {
      process.exit(results === true ? 0 : 1);
    }
  })();
}
