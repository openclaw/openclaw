// Check if Stripe environment variables are set
import { config } from 'dotenv';

config();

console.log('🔍 Checking Stripe configuration...\n');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

console.log('STRIPE_SECRET_KEY:', stripeSecretKey ? `✅ Set (${stripeSecretKey.substring(0, 7)}...)` : '❌ NOT SET');
console.log('STRIPE_WEBHOOK_SECRET:', webhookSecret ? `✅ Set (whsec_${webhookSecret.substring(6, 13)}...)` : '⚠️  NOT SET (webhooks will not be verified)');

if (!webhookSecret) {
  console.log('\n⚠️  WARNING: Webhook signature verification is disabled!');
  console.log('To fix: Add STRIPE_WEBHOOK_SECRET to your Railway environment variables');
}
