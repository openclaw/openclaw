/**
 * Debug: List all inboxes to see exact format
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_PATH = path.join(__dirname, '..', 'secrets', 'agentmail.env');

function loadSecrets() {
  const contents = fs.readFileSync(SECRETS_PATH, 'utf8');
  const secrets = {};
  contents.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, value] = trimmed.split('=');
      if (key && value) {
        secrets[key.trim()] = value.trim();
      }
    }
  });
  return secrets;
}

const secrets = loadSecrets();

const response = await fetch(`${secrets.AGENTMAIL_BASE_URL}/v0/inboxes`, {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${secrets.AGENTMAIL_API_KEY}`,
  },
});

const result = await response.json();

console.log('\n📧 Available Inboxes:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (result.inboxes) {
  result.inboxes.forEach((inbox, index) => {
    console.log(`[${index}] Inbox Details:`);
    console.log(`  - inbox_id: ${inbox.inbox_id}`);
    console.log(`  - display_name: ${inbox.display_name}`);
    console.log(`  - pod_id: ${inbox.pod_id}`);
    console.log(`  - client_id: ${inbox.client_id}`);
    console.log(`  - created_at: ${inbox.created_at}`);
    console.log('');
  });
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
