// ChatGPT Full Export Bookmarklet
// Paste this entire script in Chrome DevTools console while on chatgpt.com
// It will download all conversations as a single JSON file

(async function() {
  console.log('🚀 ChatGPT Exporter starting...');
  
  // Get access token
  console.log('🔑 Getting access token...');
  const sessionResp = await fetch('/api/auth/session', { credentials: 'include' });
  const { accessToken } = await sessionResp.json();
  
  if (!accessToken) {
    alert('❌ Not logged in! Please log into ChatGPT first.');
    return;
  }
  
  // Fetch all conversation IDs
  console.log('📋 Fetching conversation list...');
  const allConversations = [];
  let offset = 0;
  const limit = 100;
  
  while (true) {
    const resp = await fetch(`/backend-api/conversations?offset=${offset}&limit=${limit}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await resp.json();
    allConversations.push(...data.items);
    console.log(`   Found ${allConversations.length} conversations...`);
    
    if (data.items.length < limit) break;
    offset += limit;
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log(`📊 Total: ${allConversations.length} conversations`);
  
  // Fetch each conversation
  const results = [];
  const errors = [];
  
  for (let i = 0; i < allConversations.length; i++) {
    const conv = allConversations[i];
    const progress = `[${i + 1}/${allConversations.length}]`;
    
    try {
      const resp = await fetch(`/backend-api/conversation/${conv.id}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      
      const data = await resp.json();
      
      // Extract messages
      const messages = [];
      for (const [nodeId, node] of Object.entries(data.mapping || {})) {
        if (node.message?.content?.parts && node.message.author?.role !== 'system') {
          const textParts = node.message.content.parts.filter(p => typeof p === 'string');
          if (textParts.length > 0) {
            messages.push({
              role: node.message.author.role,
              content: textParts.join('\n'),
              timestamp: node.message.create_time || 0
            });
          }
        }
      }
      messages.sort((a, b) => a.timestamp - b.timestamp);
      
      results.push({
        id: conv.id,
        title: data.title || 'Untitled',
        created: data.create_time,
        updated: data.update_time,
        messages
      });
      
      console.log(`✅ ${progress} ${data.title || 'Untitled'}`);
    } catch (e) {
      console.error(`❌ ${progress} Error: ${e.message}`);
      errors.push({ id: conv.id, title: conv.title, error: e.message });
    }
    
    // Rate limiting
    if (i < allConversations.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  
  // Create download
  console.log('📦 Creating download...');
  
  const exportData = {
    exported: new Date().toISOString(),
    total: allConversations.length,
    successful: results.length,
    errors: errors.length,
    conversations: results,
    failedConversations: errors
  };
  
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chatgpt-export-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  console.log('');
  console.log('🎉 Export complete!');
  console.log(`   ✅ Exported: ${results.length}`);
  console.log(`   ❌ Errors: ${errors.length}`);
  console.log('   📁 Check your Downloads folder');
  
  alert(`✅ Export complete!\n\nExported: ${results.length} conversations\nErrors: ${errors.length}\n\nCheck your Downloads folder for the JSON file.`);
})();
