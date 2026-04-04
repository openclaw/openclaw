import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function investigate() {
  console.log('='.repeat(60));
  console.log('🔍 調查 1: auth.users 的 schema 和資料');
  console.log('='.repeat(60));

  // Query auth.users using raw SQL via RPC or direct query
  const { data: users, error: usersError } = await supabase.auth.admin.listUsers();

  if (usersError) {
    console.error('❌ Error fetching users:', usersError);
  } else {
    console.log(`\n📊 找到 ${users.users.length} 個用戶\n`);

    // Show first user's complete structure
    if (users.users[0]) {
      console.log('第一個用戶完整資料結構：');
      console.log(JSON.stringify(users.users[0], null, 2));

      console.log('\n📋 auth.users 欄位：');
      Object.keys(users.users[0]).forEach(key => {
        const value = users.users[0][key];
        const type = value === null ? 'null' : typeof value;
        console.log(`  ✓ ${key}: ${type}`);
      });

      console.log('\n📦 user_metadata 內容：');
      console.log(users.users[0].user_metadata);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('🔍 調查 2: 檢查 Database Triggers');
  console.log('='.repeat(60));

  // Check for triggers on auth.users or public.profiles
  const { data: triggers, error: triggersError } = await supabase.rpc('exec_sql', {
    query: `
      SELECT
        trigger_name,
        event_object_schema,
        event_object_table,
        action_timing,
        event_manipulation,
        action_statement
      FROM information_schema.triggers
      WHERE event_object_schema IN ('auth', 'public')
      ORDER BY event_object_schema, event_object_table, trigger_name;
    `
  });

  if (triggersError) {
    console.log('\n⚠️  無法使用 RPC 查詢 triggers，嘗試其他方法...\n');

    // Try to infer from profiles data
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: true });

    if (!profilesError && profiles) {
      console.log(`📊 找到 ${profiles.length} 個 profiles\n`);

      // Compare with users count
      console.log('比對分析：');
      console.log(`  auth.users: ${users.users.length} 個用戶`);
      console.log(`  profiles: ${profiles.length} 個 profiles`);

      if (users.users.length === profiles.length) {
        console.log('  ✅ 數量一致 → 可能有自動建立機制');
      } else {
        console.log(`  ⚠️  數量不一致 (差 ${users.users.length - profiles.length}) → 可能沒有自動建立`);
      }

      // Check if created_at matches
      console.log('\n時間戳記比對（前 3 筆）：');
      for (let i = 0; i < Math.min(3, profiles.length); i++) {
        const profile = profiles[i];
        const user = users.users.find(u => u.id === profile.user_id);
        if (user) {
          console.log(`\n  用戶 ${i + 1}:`);
          console.log(`    auth.users.created_at: ${user.created_at}`);
          console.log(`    profiles.created_at:   ${profile.created_at}`);
          console.log(`    user_metadata: ${JSON.stringify(user.user_metadata)}`);
          console.log(`    profile data:  full_name=${profile.full_name}, phone_number=${profile.phone_number}`);

          // Check if metadata matches profile
          if (user.user_metadata.fullName === profile.full_name) {
            console.log('    ✅ fullName 一致 → 可能由 metadata 自動建立');
          }
          if (user.user_metadata.phoneNumber === profile.phone_number) {
            console.log('    ✅ phoneNumber 一致 → 可能由 metadata 自動建立');
          }
        }
      }
    }
  } else {
    console.log('\n找到的 Triggers：');
    console.log(triggers);
  }

  console.log('\n' + '='.repeat(60));
  console.log('🔍 調查 3: 檢查是否有 Database Functions');
  console.log('='.repeat(60));

  const { data: functions, error: functionsError } = await supabase.rpc('exec_sql', {
    query: `
      SELECT
        routine_name,
        routine_schema,
        routine_definition
      FROM information_schema.routines
      WHERE routine_schema = 'public'
      AND routine_type = 'FUNCTION'
      AND (
        routine_name LIKE '%profile%' OR
        routine_name LIKE '%user%' OR
        routine_name LIKE '%signup%'
      )
      ORDER BY routine_name;
    `
  });

  if (functionsError) {
    console.log('⚠️  無法使用 RPC 查詢 functions');
  } else {
    console.log('\n找到的相關 Functions：');
    console.log(functions);
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ 調查完成');
  console.log('='.repeat(60));
}

investigate().catch(console.error);
