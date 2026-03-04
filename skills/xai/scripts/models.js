#!/usr/bin/env node
/**
 * List available xAI models
 */

const https = require('https');

const API_BASE = 'api.x.ai';

function getApiKey() {
  return process.env.XAI_API_KEY || null;
}

async function listModels() {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('❌ No API key found. Set XAI_API_KEY or configure in openclaw.');
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: API_BASE,
        path: '/v1/models',
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error(`❌ API Error (${res.statusCode}):`, data);
            process.exit(1);
          }

          try {
            const response = JSON.parse(data);
            const models = response.data || [];

            console.log('🤖 Available xAI Models:\n');

            for (const model of models) {
              console.log(`  • ${model.id}`);
              if (model.description) {
                console.log(`    ${model.description}`);
              }
            }

            if (models.length === 0) {
              console.log('  (no models available)');
            }

            console.log('\nUsage: node chat.js --model <model-id> "Your prompt"');

            resolve(models);
          } catch (e) {
            console.error('❌ Failed to parse response:', e.message);
            process.exit(1);
          }
        });
      },
    );

    req.on('error', (e) => {
      console.error('❌ Request failed:', e.message);
      process.exit(1);
    });

    req.end();
  });
}

listModels();
