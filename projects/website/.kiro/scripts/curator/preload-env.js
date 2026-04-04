/**
 * 環境變數預載入器
 * 在任何模組載入前先讀取 .env 並設定到 process.env
 */
const fs = require('fs');
const path = require('path');

try {
  const envPath = path.join(process.cwd(), '.env');
  const envContent = fs.readFileSync(envPath, 'utf-8');

  envContent.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;

    const [key, ...values] = line.split('=');
    if (key && values.length > 0) {
      const value = values.join('=').trim();
      process.env[key.trim()] = value;
    }
  });

  console.log('✅ 環境變數已預載入');
} catch (error) {
  console.error('❌ 無法載入 .env:', error.message);
  process.exit(1);
}
