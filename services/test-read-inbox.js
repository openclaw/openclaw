/**
 * Test: Read Tim's inbox
 */

import { readAgentInbox } from './agentmail-gateway.js';

const result = await readAgentInbox();

console.log('\n📬 Tim\'s Inbox:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Status: ${result.status}`);
console.log(`Message: ${result.message}`);
console.log(`Messages count: ${result.inbox.length}`);

if (result.inbox.length > 0) {
  console.log('\nMessages:');
  result.inbox.forEach((msg, idx) => {
    console.log(`\n[${idx + 1}] ${msg.subject || '(no subject)'}`);
    console.log(`    From: ${msg.from}`);
    console.log(`    Date: ${msg.date || msg.created_at}`);
  });
} else {
  console.log('\n(No messages in inbox yet)');
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
