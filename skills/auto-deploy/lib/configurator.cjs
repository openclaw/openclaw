#!/usr/bin/env node

/**
 * Configuration Wizard Module
 * Interactive prompts for gateway, model, and API key configuration
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Create readline interface
 */
function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

/**
 * Prompt user for input
 */
function question(rl, query) {
  return new Promise(resolve => {
    rl.question(query, resolve);
  });
}

/**
 * Prompt yes/no question
 */
async function confirm(rl, query, defaultYes = false) {
  const answer = await question(rl, `${query} (y/N): `);
  return answer.toLowerCase().startsWith('y');
}

/**
 * Generate random token
 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Configure gateway settings
 */
async function configureGateway() {
  const rl = createInterface();
  
  console.log('');
  console.log('═════════════════════════════════════════');
  console.log('🔐 Gateway Configuration');
  console.log('═════════════════════════════════════════');
  console.log('');
  
  const config = {
    mode: 'local',
    token: generateToken(),
    port: 18789
  };
  
  // Gateway mode
  console.log('Gateway mode:');
  console.log('  1. Local (recommended for most users)');
  console.log('  2. Remote (advanced)');
  const modeChoice = await question(rl, 'Select mode [1]: ');
  
  if (modeChoice === '2') {
    config.mode = 'remote';
  }
  
  // Custom token
  const useCustomToken = await confirm(rl, 'Generate custom auth token?');
  if (useCustomToken) {
    config.token = await question(rl, 'Enter token (leave empty to auto-generate): ');
    if (!config.token) {
      config.token = generateToken();
    }
  }
  
  // Port
  const portChoice = await question(rl, `Gateway port [${config.port}]: `);
  if (portChoice) {
    config.port = parseInt(portChoice);
  }
  
  rl.close();
  
  console.log('');
  console.log('✅ Gateway configuration complete');
  console.log(`   Mode: ${config.mode}`);
  console.log(`   Port: ${config.port}`);
  console.log(`   Token: ${config.token.substring(0, 8)}...`);
  
  return config;
}

/**
 * Configure model provider
 */
async function configureModel() {
  const rl = createInterface();
  
  console.log('');
  console.log('═════════════════════════════════════════');
  console.log('🤖 Model Configuration');
  console.log('═════════════════════════════════════════');
  console.log('');
  
  console.log('Select model provider:');
  console.log('  1. Zhipu AI (GLM-4.7, GLM-4.6, GLM-4.5-Air)');
  console.log('  2. OpenAI (GPT-4, GPT-3.5)');
  console.log('  3. Anthropic (Claude)');
  console.log('  4. Custom');
  
  const providerChoice = await question(rl, 'Provider [1]: ');
  
  let provider, model, apiKey;
  
  switch (providerChoice) {
    case '2':
      provider = 'openai';
      console.log('');
      console.log('OpenAI Models:');
      console.log('  1. GPT-4 Turbo');
      console.log('  2. GPT-4');
      console.log('  3. GPT-3.5 Turbo');
      const openaiModel = await question(rl, 'Model [1]: ');
      
      model = openaiModel === '2' ? 'gpt-4' :
              openaiModel === '3' ? 'gpt-3.5-turbo' :
              'gpt-4-turbo-preview';
      break;
      
    case '3':
      provider = 'anthropic';
      model = 'claude-3-opus-20240229';
      break;
      
    case '4':
      provider = await question(rl, 'Enter provider name: ');
      model = await question(rl, 'Enter model name: ');
      break;
      
    case '1':
    default:
      provider = 'zhipu';
      console.log('');
      console.log('Zhipu AI Models:');
      console.log('  1. GLM-4.7 (recommended)');
      console.log('  2. GLM-4.6');
      console.log('  3. GLM-4.5-Air');
      const zhipuModel = await question(rl, 'Model [1]: ');
      
      model = zhipuModel === '2' ? 'zhipu/GLM-4.6' :
              zhipuModel === '3' ? 'zhipu/GLM-4.5-Air' :
              'zhipu/GLM-4.7';
      break;
  }
  
  // API Key
  console.log('');
  apiKey = await question(rl, `Enter ${provider} API key: `);
  
  while (!apiKey) {
    console.log('❌ API key is required');
    apiKey = await question(rl, `Enter ${provider} API key: `);
  }
  
  rl.close();
  
  console.log('');
  console.log('✅ Model configuration complete');
  console.log(`   Provider: ${provider}`);
  console.log(`   Model: ${model}`);
  console.log(`   API Key: ${apiKey.substring(0, 8)}...`);
  
  return {
    provider,
    model,
    apiKey,
    defaultModel: model
  };
}

/**
 * Configure Telegram (optional)
 */
async function configureTelegram() {
  const rl = createInterface();
  
  console.log('');
  console.log('═════════════════════════════════════════');
  console.log('📱 Telegram Configuration (Optional)');
  console.log('═════════════════════════════════════════');
  console.log('');
  
  const enableTelegram = await confirm(rl, 'Enable Telegram bot?');
  
  if (!enableTelegram) {
    rl.close();
    return null;
  }
  
  const botToken = await question(rl, 'Enter Telegram bot token: ');
  
  console.log('');
  console.log('To get your chat ID, send a message to your bot and visit:');
  console.log('https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates');
  
  const chatId = await question(rl, 'Enter your chat ID: ');
  
  rl.close();
  
  console.log('');
  console.log('✅ Telegram configuration complete');
  
  return {
    enabled: true,
    botToken,
    chatId
  };
}

/**
 * Generate configuration file
 */
function generateConfig(gateway, model, telegram) {
  const config = {
    gateway: {
      mode: gateway.mode,
      port: gateway.port,
      authToken: gateway.token
    },
    model: {
      provider: model.provider,
      defaultModel: model.defaultModel,
      apiKey: model.apiKey
    },
    features: {
      inlineButtons: true
    }
  };
  
  if (telegram && telegram.enabled) {
    config.channels = {
      telegram: {
        enabled: true,
        botToken: telegram.botToken,
        chatId: telegram.chatId
      }
    };
  }
  
  return config;
}

/**
 * Write configuration file
 */
function writeConfig(config) {
  const os = require('os');
  const configPath = path.join(os.homedir(), '.openclaw', 'config.json');
  
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log('');
    console.log(`✅ Configuration written to ${configPath}`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to write configuration: ${error.message}`);
    return false;
  }
}

/**
 * Main configuration wizard
 */
async function runConfigurationWizard() {
  console.log('');
  console.log('═════════════════════════════════════════');
  console.log('⚙️  OpenClaw Configuration Wizard');
  console.log('═════════════════════════════════════════');
  console.log('');
  console.log('This wizard will help you configure OpenClaw.');
  console.log('Press Ctrl+C to cancel at any time.');
  
  try {
    // Gateway
    const gateway = await configureGateway();
    
    // Model
    const model = await configureModel();
    
    // Telegram (optional)
    const telegram = await configureTelegram();
    
    // Generate and write config
    const config = generateConfig(gateway, model, telegram);
    const success = writeConfig(config);
    
    if (success) {
      console.log('');
      console.log('═════════════════════════════════════════');
      console.log('✅ Configuration Complete');
      console.log('═════════════════════════════════════════');
      console.log('');
      console.log('Next steps:');
      console.log('  1. Start the gateway: openclaw gateway start');
      console.log('  2. Access dashboard: http://localhost:18789?token=' + gateway.token);
      console.log('  3. Connect Telegram (if configured)');
    }
    
    return success;
    
  } catch (error) {
    console.error('');
    console.error('❌ Configuration failed:', error.message);
    return false;
  }
}

module.exports = {
  configureGateway,
  configureModel,
  configureTelegram,
  generateConfig,
  writeConfig,
  runConfigurationWizard,
  generateToken
};

// If run directly, execute wizard
if (require.main === module) {
  runConfigurationWizard().then(success => {
    process.exit(success ? 0 : 1);
  });
}
