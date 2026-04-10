#!/usr/bin/env node
/**
 * OpenClaw Config Cleanup Script
 * Migrates or removes deprecated configuration keys
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CONFIG_PATH = path.join(process.env.HOME, '.openclaw', 'openclaw.json');
const BACKUP_DIR = path.join(process.env.HOME, '.openclaw', 'backups');

// Deprecated key definitions with migration strategies
const DEPRECATED_KEYS = [
  {
    id: 'talk.voiceId/talk.apiKey',
    description: 'Voice configuration moved to talk.provider',
    detect: (config) => {
      const hasVoiceId = config.talk?.voiceId !== undefined;
      const hasApiKey = config.talk?.apiKey !== undefined;
      return hasVoiceId || hasApiKey;
    },
    migrate: (config) => {
      if (!config.talk) config.talk = {};
      config.talk.provider = {
        voiceId: config.talk.voiceId,
        apiKey: config.talk.apiKey
      };
      delete config.talk.voiceId;
      delete config.talk.apiKey;
      return { migrated: true, removed: [], added: ['talk.provider'] };
    }
  },
  {
    id: 'browser.ssrfPolicy.allowPrivateNetwork',
    description: 'SSR private network policy removed',
    detect: (config) => config.browser?.ssrfPolicy?.allowPrivateNetwork !== undefined,
    migrate: (config) => {
      delete config.browser.ssrfPolicy.allowPrivateNetwork;
      if (Object.keys(config.browser.ssrfPolicy).length === 0) {
        delete config.browser.ssrfPolicy;
      }
      return { migrated: true, removed: ['browser.ssrfPolicy.allowPrivateNetwork'], added: [] };
    }
  },
  {
    id: 'agents.*.sandbox.perSession',
    description: 'Per-session sandbox setting deprecated',
    detect: (config) => {
      if (!config.agents) return false;
      return Object.values(config.agents).some(agent => agent.sandbox?.perSession !== undefined);
    },
    migrate: (config) => {
      const removed = [];
      if (config.agents) {
        for (const [agentName, agentConfig] of Object.entries(config.agents)) {
          if (agentConfig.sandbox?.perSession !== undefined) {
            delete agentConfig.sandbox.perSession;
            removed.push(`agents.${agentName}.sandbox.perSession`);
            if (Object.keys(agentConfig.sandbox).length === 0) {
              delete agentConfig.sandbox;
            }
          }
        }
      }
      return { migrated: true, removed, added: [] };
    }
  },
  {
    id: 'tools.web.x_search.*',
    description: 'X search tools moved to plugins.entries.xai.config.xSearch',
    detect: (config) => config.tools?.web?.x_search !== undefined,
    migrate: (config) => {
      if (!config.plugins) config.plugins = { entries: {} };
      if (!config.plugins.entries) config.plugins.entries = {};
      if (!config.plugins.entries.xai) config.plugins.entries.xai = { config: {} };
      
      config.plugins.entries.xai.config.xSearch = config.tools.web.x_search;
      delete config.tools.web.x_search;
      
      // Clean up empty objects
      if (Object.keys(config.tools.web).length === 0) delete config.tools.web;
      if (Object.keys(config.tools).length === 0) delete config.tools;
      
      return { 
        migrated: true, 
        removed: ['tools.web.x_search.*'], 
        added: ['plugins.entries.xai.config.xSearch.*'] 
      };
    }
  },
  {
    id: 'tools.web.fetch.firecrawl.*',
    description: 'Firecrawl config moved to plugins.entries.firecrawl.config.webFetch',
    detect: (config) => config.tools?.web?.fetch?.firecrawl !== undefined,
    migrate: (config) => {
      if (!config.plugins) config.plugins = { entries: {} };
      if (!config.plugins.entries) config.plugins.entries = {};
      if (!config.plugins.entries.firecrawl) config.plugins.entries.firecrawl = { config: {} };
      
      config.plugins.entries.firecrawl.config.webFetch = config.tools.web.fetch.firecrawl;
      delete config.tools.web.fetch.firecrawl;
      
      // Clean up empty objects
      if (Object.keys(config.tools.web.fetch).length === 0) delete config.tools.web.fetch;
      if (Object.keys(config.tools.web).length === 0) delete config.tools.web;
      if (Object.keys(config.tools).length === 0) delete config.tools;
      
      return { 
        migrated: true, 
        removed: ['tools.web.fetch.firecrawl.*'], 
        added: ['plugins.entries.firecrawl.config.webFetch.*'] 
      };
    }
  },
  {
    id: 'browser.driver: "extension"',
    description: 'Extension driver deprecated, using managed browser',
    detect: (config) => config.browser?.driver === 'extension',
    migrate: (config) => {
      delete config.browser.driver;
      if (Object.keys(config.browser).length === 0) delete config.browser;
      return { migrated: true, removed: ['browser.driver'], added: [] };
    }
  },
  {
    id: 'hooks.internal.handlers',
    description: 'Internal hooks handlers deprecated',
    detect: (config) => config.hooks?.internal?.handlers !== undefined,
    migrate: (config) => {
      delete config.hooks.internal.handlers;
      if (Object.keys(config.hooks.internal).length === 0) delete config.hooks.internal;
      if (Object.keys(config.hooks).length === 0) delete config.hooks;
      return { migrated: true, removed: ['hooks.internal.handlers'], added: [] };
    }
  },
  {
    id: 'channels.*.dm.policy',
    description: 'DM policy moved to channels.*.dmPolicy',
    detect: (config) => {
      if (!config.channels) return false;
      return Object.values(config.channels).some(ch => ch.dm?.policy !== undefined);
    },
    migrate: (config) => {
      const removed = [];
      const added = [];
      if (config.channels) {
        for (const [channelName, channelConfig] of Object.entries(config.channels)) {
          if (channelConfig.dm?.policy !== undefined) {
            channelConfig.dmPolicy = channelConfig.dm.policy;
            delete channelConfig.dm.policy;
            removed.push(`channels.${channelName}.dm.policy`);
            added.push(`channels.${channelName}.dmPolicy`);
            if (Object.keys(channelConfig.dm).length === 0) {
              delete channelConfig.dm;
            }
          }
        }
      }
      return { migrated: true, removed, added };
    }
  },
  {
    id: 'memory-root',
    description: 'Global memory-root deprecated, use per-agent memory-root-<agent>',
    detect: (config) => config['memory-root'] !== undefined,
    migrate: (config) => {
      const oldValue = config['memory-root'];
      delete config['memory-root'];
      return { 
        migrated: true, 
        removed: ['memory-root'], 
        added: [],
        note: `Old value was "${oldValue}" - create per-agent memory-root-<agent> keys as needed`
      };
    }
  }
];

// Create readline interface for prompts
function createPrompt() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

// Ask user a question
function ask(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

// Create backup
function createBackup(config) {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `openclaw-backup-${timestamp}.json`);
  
  fs.writeFileSync(backupPath, JSON.stringify(config, null, 2));
  return backupPath;
}

// Main function
async function main() {
  console.log('🔧 OpenClaw Config Cleanup\n');
  
  // Check if config exists
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`❌ Config file not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  
  // Load config
  let config;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(content);
  } catch (err) {
    console.error(`❌ Failed to parse config: ${err.message}`);
    process.exit(1);
  }
  
  // Detect deprecated keys
  const detected = DEPRECATED_KEYS.filter(key => key.detect(config));
  
  if (detected.length === 0) {
    console.log('✅ No deprecated keys found. Config is clean!');
    process.exit(0);
  }
  
  console.log(`Found ${detected.length} deprecated key(s):\n`);
  detected.forEach((key, i) => {
    console.log(`  ${i + 1}. ${key.id}`);
    console.log(`     ${key.description}\n`);
  });
  
  // Interactive mode or auto mode
  const rl = createPrompt();
  const mode = await ask(rl, '\nChoose action: [m]igrate all, [d]elete all, [r]eview each, [c]ancel: ');
  
  if (mode.toLowerCase() === 'c') {
    console.log('\n❎ Cancelled. No changes made.');
    rl.close();
    process.exit(0);
  }
  
  // Create backup before modifications
  const backupPath = createBackup(config);
  console.log(`\n💾 Backup created: ${backupPath}`);
  
  const results = [];
  
  for (const key of detected) {
    let action = mode.toLowerCase();
    
    if (action === 'r') {
      const response = await ask(rl, `\n${key.id}: [m]igrate, [d]elete, [s]kip? `);
      action = response.toLowerCase() || 's';
    }
    
    if (action === 's') {
      results.push({ key: key.id, action: 'skipped', details: null });
      console.log(`  ⏭️  Skipped`);
      continue;
    }
    
    if (action === 'm') {
      const migration = key.migrate(config);
      results.push({ key: key.id, action: 'migrated', details: migration });
      console.log(`  ✅ Migrated`);
      if (migration.note) console.log(`     ℹ️  ${migration.note}`);
    } else if (action === 'd') {
      // For delete, we just remove without migration (same as migrate for removal-only keys)
      const migration = key.migrate(config);
      results.push({ key: key.id, action: 'deleted', details: migration });
      console.log(`  🗑️  Deleted`);
    }
  }
  
  rl.close();
  
  // Save modified config
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\n✅ Config saved to: ${CONFIG_PATH}`);
  
  // Summary
  console.log('\n📋 Summary of Changes:');
  console.log('='.repeat(60));
  
  const migrated = results.filter(r => r.action === 'migrated');
  const deleted = results.filter(r => r.action === 'deleted');
  const skipped = results.filter(r => r.action === 'skipped');
  
  if (migrated.length > 0) {
    console.log('\n🔄 Migrated:');
    migrated.forEach(r => {
      console.log(`  • ${r.key}`);
      if (r.details?.removed?.length > 0) {
        r.details.removed.forEach(path => console.log(`    - ${path}`));
      }
      if (r.details?.added?.length > 0) {
        r.details.added.forEach(path => console.log(`    + ${path}`));
      }
    });
  }
  
  if (deleted.length > 0) {
    console.log('\n🗑️  Deleted:');
    deleted.forEach(r => console.log(`  • ${r.key}`));
  }
  
  if (skipped.length > 0) {
    console.log('\n⏭️  Skipped:');
    skipped.forEach(r => console.log(`  • ${r.key}`));
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`\n💾 Backup available at: ${backupPath}`);
  console.log('\n✨ Config cleanup complete!');
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
}

module.exports = { DEPRECATED_KEYS, createBackup };
