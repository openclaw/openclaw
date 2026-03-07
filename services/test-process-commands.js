/**
 * Test: Process commands from Tim's inbox
 */

import { readAgentInbox } from './agentmail-gateway.js';
import { loadConfig } from './agentmail-gateway.js';

async function main() {
  console.log('\n🔄 Reading inbox and processing commands...\n');
  
  // Load config
  const config = loadConfig();
  console.log('Config loaded, freeform:', config.features?.freeform);
  
  // Read inbox
  const result = await readAgentInbox();
  
  console.log(`Found ${result.inbox.length} messages\n`);
  
  if (result.inbox.length > 0) {
    console.log('Messages:');
    result.inbox.forEach((msg, idx) => {
      console.log(`\n[${idx + 1}] Subject: ${msg.subject || '(no subject)'}`);
      console.log(`    From: ${msg.from}`);
      console.log(`    Body: ${(msg.body || msg.text || '(no body)').substring(0, 100)}...`);
    });
  }
  
  console.log('\n✅ Script complete - check logs/commands.log for processing results\n');
}

main().catch(console.error);
