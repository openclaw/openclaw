/**
 * Test: Send email from Tim to user
 */

import { sendEmail } from './agentmail-gateway.js';

const result = await sendEmail(
  'fjventura20@gmail.com',
  '🎯 Tim Agent Test Email',
  `Hello Frank,

This is Tim sending you a test email through the AgentMail integration.

If you're reading this, the email gateway is working correctly!

Details:
- Sender: timsmail@agentmail.to
- Recipient: fjventura20@gmail.com (allowlisted)
- Time: ${new Date().toISOString()}
- Status: Success ✓

The gateway is now operational and ready for Tim to send emails.

Best,
Tim (Claude Code)`
);

console.log('\n✉️  Email Sent!');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Status: ${result.status}`);
console.log(`Message: ${result.message}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
