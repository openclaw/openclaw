#!/usr/bin/env node

/**
 * Auto-Deployment Skill Main Entry Point
 * Orchestrates the complete OpenClaw deployment process
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);


const { detectEnvironment, generateReport } = require('./lib/detector.cjs');
const { runInstallation } = require('./lib/installer.cjs');
const { runConfigurationWizard } = require('./lib/configurator.cjs');
const { runVerification } = require('./lib/validator.cjs');
const { runDiagnostics, autoFix } = require('./lib/troubleshooter.cjs');

const readline = require('readline');

/**
 * Prompt yes/no question
 */
async function confirm(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise(resolve => {
    rl.question(`${query} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

/**
 * Main deployment function
 */
async function deploy(options = {}) {
  const { skipInstall = false, skipConfig = false, skipVerify = false } = options;
  
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║          🦞 OpenClaw Auto-Deployment                         ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('This tool will guide you through deploying OpenClaw on your server.');
  console.log('');
  
  // Phase 1: Environment Detection
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 1: Environment Detection');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  const env = detectEnvironment();
  console.log(generateReport(env));
  console.log('');
  
  if (!env.supported) {
    console.error('❌ This OS is not supported by auto-deploy yet.');
    console.error('   Supported: OpenCloudOS, RHEL, CentOS, Ubuntu, Debian');
    process.exit(1);
  }
  
  // Phase 2: Installation
  if (!skipInstall) {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Phase 2: Installation');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    
    const installSuccess = await runInstallation({
      skipNodejs: env.node.meetsRequirement,
      skipOpenClaw: false
    });
    
    if (!installSuccess) {
      console.error('❌ Installation failed. Please check the errors above.');
      process.exit(1);
    }
  }
  
  // Phase 3: Configuration
  if (!skipConfig) {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Phase 3: Configuration');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const configSuccess = await runConfigurationWizard();
    
    if (!configSuccess) {
      console.error('❌ Configuration failed. Please check the errors above.');
      process.exit(1);
    }
  }
  
  // Phase 4: Troubleshooting
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 4: Troubleshooting & Diagnostics');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  
  const issues = await runDiagnostics();
  
  if (issues !== true) {
    console.log('');
    const autoFixChoice = await confirm('\nAttempt auto-fix for detected issues?');
    if (autoFixChoice) {
      const fixed = await autoFix(issues);
      if (!fixed) {
        console.warn('⚠️  Some issues require manual intervention.');
      }
    }
  }
  
  // Phase 5: Verification
  if (!skipVerify) {
    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Phase 5: Verification');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    
    const verifySuccess = await runVerification();
    
    if (!verifySuccess) {
      console.warn('⚠️  Verification found issues. Please check the warnings above.');
    }
  }
  
  // Final summary
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║          ✅ Deployment Complete!                            ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Start the gateway:');
  console.log('     $ openclaw gateway start');
  console.log('');
  console.log('  2. Enable auto-start (optional):');
  console.log('     $ systemctl enable openclaw-gateway');
  console.log('     $ systemctl start openclaw-gateway');
  console.log('');
  console.log('  3. Access dashboard:');
  console.log('     http://localhost:18789?token=<YOUR_TOKEN>');
  console.log('');
  console.log('  4. Or create SSH tunnel for remote access:');
  console.log('     $ ssh -L 8888:localhost:18789 root@<server-ip>');
  console.log('     Then: http://localhost:8888?token=<YOUR_TOKEN>');
  console.log('');
  console.log('For help: openclaw help');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

/**
 * Quick deploy (non-interactive mode)
 */
async function quickDeploy(config) {
  console.log('🚀 Quick deploy mode');
  // TODO: Implement non-interactive deployment
  await deploy();
}

// Export functions
module.exports = {
  deploy,
  quickDeploy
};

// If run directly, execute deployment
if (require.main === module) {
  const args = process.argv.slice(2);
  const skipInstall = args.includes('--skip-install');
  const skipConfig = args.includes('--skip-config');
  const skipVerify = args.includes('--skip-verify');
  
  deploy({ skipInstall, skipConfig, skipVerify })
    .then(() => {
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Deployment failed:', error.message);
      process.exit(1);
    });
}
