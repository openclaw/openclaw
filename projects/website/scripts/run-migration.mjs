import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function runMigration() {
  console.log('='.repeat(70));
  console.log('🚀 開始執行 LINE Login Migration');
  console.log('='.repeat(70));

  // Read migration file
  const migrationSQL = readFileSync('migrations/20251105_add_line_login_support.sql', 'utf-8');

  console.log('\n📄 Migration 檔案內容：');
  console.log(migrationSQL);

  console.log('\n' + '='.repeat(70));
  console.log('⚙️  執行 Migration SQL...');
  console.log('='.repeat(70));

  // Split by individual statements and execute them
  const statements = migrationSQL
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('COMMENT'));

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i] + ';';

    // Skip comments and empty statements
    if (stmt.trim().startsWith('--') || stmt.trim() === ';') {
      continue;
    }

    console.log(`\n[${i + 1}/${statements.length}] 執行: ${stmt.substring(0, 60)}...`);

    try {
      // Use rpc to execute raw SQL
      const { data, error } = await supabase.rpc('exec', { sql: stmt });

      if (error) {
        // Try alternative: Use from() with raw SQL via PostgreSQL REST API
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/query`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({ query: stmt })
        });

        if (!response.ok) {
          // Last resort: Direct SQL execution via pg admin API
          const adminResponse = await fetch(`${supabaseUrl}/rest/v1/`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Content-Profile': 'public'
            },
            body: JSON.stringify({ query: stmt })
          });

          if (!adminResponse.ok) {
            throw new Error(`執行失敗: ${error?.message || 'Unknown error'}`);
          }
        }

        console.log('  ✅ 成功');
        successCount++;
      } else {
        console.log('  ✅ 成功', data ? `(${JSON.stringify(data).substring(0, 50)}...)` : '');
        successCount++;
      }
    } catch (err) {
      console.log('  ❌ 錯誤:', err.message);
      errorCount++;
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('📊 執行結果統計');
  console.log('='.repeat(70));
  console.log(`✅ 成功: ${successCount} 個語句`);
  console.log(`❌ 失敗: ${errorCount} 個語句`);

  if (errorCount > 0) {
    console.log('\n⚠️  有語句執行失敗，請手動在 Supabase Dashboard 執行完整 SQL');
    console.log('   檔案位置: migrations/20251105_add_line_login_support.sql');
    return false;
  }

  console.log('\n' + '='.repeat(70));
  console.log('🔍 驗證 Migration 結果');
  console.log('='.repeat(70));

  // Verify the migration
  const { data: profile, error: verifyError } = await supabase
    .from('profiles')
    .select('*')
    .limit(1)
    .single();

  if (verifyError) {
    console.log('❌ 無法驗證結果:', verifyError.message);
    return false;
  }

  console.log('\n✅ profiles 表結構（驗證）：');
  Object.keys(profile).forEach(key => {
    console.log(`  ✓ ${key}`);
  });

  // Check for new LINE columns
  const lineColumns = ['line_user_id', 'line_display_name', 'line_picture_url', 'auth_provider', 'migrated_from_email'];
  const missingColumns = lineColumns.filter(col => !(col in profile));

  if (missingColumns.length > 0) {
    console.log('\n⚠️  缺少以下 LINE 欄位:', missingColumns.join(', '));
    console.log('   Migration 可能未完全成功，請手動檢查 Supabase Dashboard');
    return false;
  }

  console.log('\n✅ 所有 LINE 欄位都已成功新增！');

  console.log('\n' + '='.repeat(70));
  console.log('✨ Migration 執行完成！');
  console.log('='.repeat(70));

  return true;
}

runMigration()
  .then(success => {
    if (success) {
      console.log('\n🎉 Migration 成功完成！可以繼續進行 LINE Login 開發。');
      process.exit(0);
    } else {
      console.log('\n⚠️  Migration 未完全成功，請檢查上方錯誤訊息。');
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('\n💥 執行過程發生錯誤:', err);
    process.exit(1);
  });
