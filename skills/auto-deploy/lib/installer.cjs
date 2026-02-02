#!/usr/bin/env node

/**
 * Installation Automation Module
 * Handles installation of Node.js, OpenClaw, and dependencies
 */

const { execSync } = require('child_process');
const { detectOS, checkNodeVersion } = require('./detector');

/**
 * Install Node.js on various distributions
 */
function installNodejs() {
  const os = detectOS();
  const osId = os.id.toLowerCase();
  
  console.log(`📦 Installing Node.js 22 on ${os.prettyName}...`);
  
  try {
    if (osId.includes('ubuntu') || osId.includes('debian')) {
      // Ubuntu/Debian
      console.log('Using NodeSource repository...');
      execSync('curl -fsSL https://deb.nodesource.com/setup_22.x | bash -', {
        stdio: 'inherit'
      });
      execSync('apt-get install -y nodejs', { stdio: 'inherit' });
      
    } else if (osId.includes('rhel') || osId.includes('centos') || osId.includes('opencloudos')) {
      // RHEL/CentOS/OpenCloudOS
      console.log('Using NodeSource repository...');
      execSync('curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -', {
        stdio: 'inherit'
      });
      execSync('dnf install -y nodejs', { stdio: 'inherit' });
      
    } else {
      throw new Error(`Unsupported OS for Node.js installation: ${osId}`);
    }
    
    // Verify installation
    const node = checkNodeVersion();
    if (node.installed && node.meetsRequirement) {
      console.log(`✅ Node.js ${node.version} installed successfully`);
      return true;
    } else {
      throw new Error('Node.js installation failed');
    }
    
  } catch (error) {
    console.error(`❌ Node.js installation failed: ${error.message}`);
    return false;
  }
}

/**
 * Install Git if missing
 */
function installGit() {
  const os = detectOS();
  const osId = os.id.toLowerCase();
  
  console.log('📦 Installing Git...');
  
  try {
    if (osId.includes('ubuntu') || osId.includes('debian')) {
      execSync('apt-get install -y git', { stdio: 'inherit' });
    } else if (osId.includes('rhel') || osId.includes('centos') || osId.includes('opencloudos')) {
      execSync('dnf install -y git', { stdio: 'inherit' });
    }
    
    console.log('✅ Git installed successfully');
    return true;
    
  } catch (error) {
    console.error(`❌ Git installation failed: ${error.message}`);
    return false;
  }
}

/**
 * Run OpenClaw installer
 */
function installOpenClaw() {
  console.log('🦞 Installing OpenClaw...');
  
  try {
    // Download and run installer
    execSync('curl -fsSL https://openclaw.ai/install.sh | bash', {
      stdio: 'inherit',
      shell: '/bin/bash'
    });
    
    console.log('✅ OpenClaw installed successfully');
    return true;
    
  } catch (error) {
    console.error(`❌ OpenClaw installation failed: ${error.message}`);
    return false;
  }
}

/**
 * Fix directory permissions
 */
function fixPermissions() {
  console.log('🔧 Fixing OpenClaw directory permissions...');
  
  try {
    const { execSync } = require('child_process');
    const os = require('os');
    
    const openclawDir = `${os.homedir()}/.openclaw`;
    
    // Create directory if it doesn't exist
    execSync(`mkdir -p ${openclawDir}`, { stdio: 'inherit' });
    
    // Set permissions
    execSync(`chmod -R 700 ${openclawDir}`, { stdio: 'inherit' });
    
    console.log('✅ Permissions fixed');
    return true;
    
  } catch (error) {
    console.error(`❌ Failed to fix permissions: ${error.message}`);
    return false;
  }
}

/**
 * Create required directories
 */
function createDirectories() {
  console.log('📁 Creating required directories...');
  
  try {
    const os = require('os');
    const { execSync } = require('child_process');
    
    const openclawDir = `${os.homedir()}/.openclaw`;
    const dirs = [
      `${openclawDir}/workspace`,
      `${openclawDir}/memory`,
      `${openclawDir}/sessions`
    ];
    
    dirs.forEach(dir => {
      execSync(`mkdir -p ${dir}`, { stdio: 'inherit' });
    });
    
    console.log('✅ Directories created');
    return true;
    
  } catch (error) {
    console.error(`❌ Failed to create directories: ${error.message}`);
    return false;
  }
}

/**
 * Configure systemd service
 */
function configureSystemService() {
  console.log('⚙️  Configuring systemd service...');
  
  try {
    const os = require('os');
    const { execSync } = require('child_process');
    
    const openclawDir = `${os.homedir()}/.openclaw`;
    
    // Check if systemd is available
    try {
      execSync('which systemctl', { stdio: 'ignore' });
    } catch {
      console.log('⚠️  systemd not available, skipping service configuration');
      return true;
    }
    
    // Create systemd service file
    const serviceContent = `[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
Type=simple
User=${os.userInfo().username}
WorkingDirectory=${openclawDir}
ExecStart=$(which node) ${openclawDir}/node_modules/openclaw/dist/gateway.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
    
    const serviceFile = '/etc/systemd/system/openclaw-gateway.service';
    execSync(`cat > ${serviceFile} << 'EOF'\n${serviceContent}\nEOF`, {
      stdio: 'inherit'
    });
    
    // Reload systemd
    execSync('systemctl daemon-reload', { stdio: 'inherit' });
    
    console.log('✅ Systemd service configured');
    return true;
    
  } catch (error) {
    console.error(`❌ Failed to configure service: ${error.message}`);
    return false;
  }
}

/**
 * Main installation function
 */
async function runInstallation(options = {}) {
  const { skipNodejs = false, skipOpenClaw = false } = options;
  
  console.log('═════════════════════════════════════════');
  console.log('🚀 Starting Installation');
  console.log('═════════════════════════════════════════');
  console.log('');
  
  const results = {};
  
  // Install Node.js if needed
  if (!skipNodejs) {
    const node = checkNodeVersion();
    if (!node.installed || !node.meetsRequirement) {
      results.nodejs = await installNodejs();
      if (!results.nodejs) {
        console.error('❌ Installation failed at Node.js step');
        return false;
      }
    } else {
      console.log(`✅ Node.js ${node.version} already installed`);
      results.nodejs = true;
    }
  }
  
  // Install Git if needed
  const { checkGit } = require('./detector');
  const git = checkGit();
  if (!git.installed) {
    results.git = await installGit();
    if (!results.git) {
      console.error('❌ Installation failed at Git step');
      return false;
    }
  } else {
    console.log(`✅ Git ${git.version} already installed`);
    results.git = true;
  }
  
  // Install OpenClaw
  if (!skipOpenClaw) {
    results.openclaw = await installOpenClaw();
    if (!results.openclaw) {
      console.error('❌ Installation failed at OpenClaw step');
      return false;
    }
  }
  
  // Fix permissions
  results.permissions = await fixPermissions();
  
  // Create directories
  results.directories = await createDirectories();
  
  // Configure service
  results.service = await configureSystemService();
  
  console.log('');
  console.log('═════════════════════════════════════════');
  console.log('✅ Installation Complete');
  console.log('═════════════════════════════════════════');
  
  return results;
}

module.exports = {
  installNodejs,
  installGit,
  installOpenClaw,
  fixPermissions,
  createDirectories,
  configureSystemService,
  runInstallation
};

// If run directly, execute installation
if (require.main === module) {
  runInstallation().then(success => {
    process.exit(success ? 0 : 1);
  });
}
