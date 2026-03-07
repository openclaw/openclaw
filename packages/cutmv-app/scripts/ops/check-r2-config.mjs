// Check R2 configuration
import { config } from 'dotenv';

config();

console.log('🔍 Checking R2 Configuration...\n');

const r2Config = {
  'CLOUDFLARE_ACCOUNT_ID': process.env.CLOUDFLARE_ACCOUNT_ID,
  'R2_ACCESS_KEY_ID': process.env.R2_ACCESS_KEY_ID,
  'R2_SECRET_ACCESS_KEY': process.env.R2_SECRET_ACCESS_KEY,
  'R2_BUCKET_NAME': process.env.R2_BUCKET_NAME,
  'R2_PUBLIC_DOMAIN': process.env.R2_PUBLIC_DOMAIN
};

for (const [key, value] of Object.entries(r2Config)) {
  if (value) {
    console.log(`✅ ${key}: ${key.includes('SECRET') ? '***HIDDEN***' : value.substring(0, 20)}${value.length > 20 ? '...' : ''}`);
  } else {
    console.log(`❌ ${key}: NOT SET`);
  }
}

console.log('\n📊 Summary:');
const missingVars = Object.entries(r2Config).filter(([k, v]) => !v).map(([k]) => k);

if (missingVars.length > 0) {
  console.log('❌ Missing environment variables:', missingVars.join(', '));
  console.log('\nThese need to be set in Railway for R2 storage to work.');
} else {
  console.log('✅ All R2 environment variables are configured');
}
