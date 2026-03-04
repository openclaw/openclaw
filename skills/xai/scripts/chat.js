#!/usr/bin/env node
/**
 * xAI/Grok Chat Script
 *
 * Usage:
 *   node chat.js "Your prompt here"
 *   node chat.js --model grok-3-mini "Quick question"
 *   node chat.js --image /path/to/image.jpg "Describe this"
 *   node chat.js --system "You are a pirate" "Tell me about ships"
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_BASE = 'api.x.ai';
const DEFAULT_MODEL = 'grok-3';

function getApiKey() {
  return process.env.XAI_API_KEY || null;
}

function parseArgs(args) {
  const result = {
    model: process.env.XAI_MODEL || DEFAULT_MODEL,
    system: null,
    image: null,
    prompt: '',
    stream: false,
    json: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--model' || arg === '-m') {
      result.model = args[++i];
    } else if (arg === '--system' || arg === '-s') {
      result.system = args[++i];
    } else if (arg === '--image' || arg === '-i') {
      result.image = args[++i];
    } else if (arg === '--stream') {
      result.stream = true;
    } else if (arg === '--json' || arg === '-j') {
      result.json = true;
    } else if (!arg.startsWith('-')) {
      result.prompt = args.slice(i).join(' ');
      break;
    }
    i++;
  }

  return result;
}

function imageToBase64(imagePath) {
  const absolutePath = path.resolve(imagePath);

  const ext = path.extname(absolutePath).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };

  if (!mimeTypes[ext]) {
    throw new Error(`Unsupported image format: ${ext}. Allowed: ${Object.keys(mimeTypes).join(', ')}`);
  }

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image not found: ${absolutePath}`);
  }

  const imageData = fs.readFileSync(absolutePath);
  const base64 = imageData.toString('base64');
  const mimeType = mimeTypes[ext];

  return `data:${mimeType};base64,${base64}`;
}

async function chat(options) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('❌ No API key found. Set XAI_API_KEY or configure in openclaw.');
    console.error('   Get your key at: https://console.x.ai');
    process.exit(1);
  }

  const messages = [];

  if (options.system) {
    messages.push({ role: 'system', content: options.system });
  }

  let userContent;
  if (options.image) {
    const imageUrl = imageToBase64(options.image);
    userContent = [
      { type: 'image_url', image_url: { url: imageUrl } },
      { type: 'text', text: options.prompt || 'Describe this image.' },
    ];
    if (options.model === DEFAULT_MODEL) {
      options.model = 'grok-2-vision-1212';
    }
  } else {
    userContent = options.prompt;
  }

  messages.push({ role: 'user', content: userContent });

  const payload = {
    model: options.model,
    messages: messages,
    stream: options.stream,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: API_BASE,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;

          if (options.stream) {
            const lines = data.split('\n');
            data = lines.pop();

            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const json = JSON.parse(line.slice(6));
                  const content = json.choices?.[0]?.delta?.content;
                  if (content) {
                    process.stdout.write(content);
                  }
                } catch (e) {
                  // ignore
                }
              }
            }
          }
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error(`❌ API Error (${res.statusCode}):`, data);
            process.exit(1);
          }

          if (!options.stream) {
            try {
              const response = JSON.parse(data);
              const content = response.choices?.[0]?.message?.content;

              if (options.json) {
                console.log(JSON.stringify(response, null, 2));
              } else {
                console.log(content || '(no response)');
              }

              resolve(response);
            } catch (e) {
              console.error('❌ Failed to parse response:', e.message);
              process.exit(1);
            }
          } else {
            console.log();
            resolve();
          }
        });
      },
    );

    req.on('error', (e) => {
      console.error('❌ Request failed:', e.message);
      process.exit(1);
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`
🤖 xAI/Grok Chat

Usage:
  node chat.js [options] "Your prompt"

Options:
  --model, -m <model>   Model to use (default: grok-3)
  --system, -s <text>   System prompt
  --image, -i <path>    Image for vision analysis
  --stream              Stream the response
  --json, -j            Output full JSON response
  --help, -h            Show this help
`);
  process.exit(0);
}

const options = parseArgs(args);

if (!options.prompt && !options.image) {
  console.error('❌ Please provide a prompt');
  process.exit(1);
}

chat(options);
