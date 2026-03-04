#!/usr/bin/env node
/**
 * Search X/Twitter using either:
 * 1. xAI Grok x_search tool (default) - requires XAI_API_KEY
 * 2. X API directly (--x-api flag) - requires X_BEARER_TOKEN
 */

const https = require('https');

const XAI_API_BASE = 'api.x.ai';
const X_API_BASE = 'api.x.com';
const DEFAULT_MODEL = process.env.SEARCH_X_MODEL || 'grok-4-1-fast';
const DEFAULT_DAYS = parseInt(process.env.SEARCH_X_DAYS, 10) || 30;

function getApiKey(keyType) {
  if (keyType === 'x') {
    return process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || null;
  }
  return process.env.XAI_API_KEY || null;
}

function parseArgs(args) {
  const result = {
    query: '',
    days: DEFAULT_DAYS,
    handles: [],
    excludeHandles: [],
    json: false,
    compact: false,
    linksOnly: false,
    model: DEFAULT_MODEL,
    useXApi: false,  // NEW: use X API instead of xAI
    maxResults: 20,
  };
  
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    
    if (arg === '--days' || arg === '-d') {
      result.days = parseInt(args[++i], 10);
    } else if (arg === '--handles' || arg === '-h') {
      result.handles = args[++i].split(',').map(h => h.trim().replace(/^@/, ''));
    } else if (arg === '--exclude' || arg === '-e') {
      result.excludeHandles = args[++i].split(',').map(h => h.trim().replace(/^@/, ''));
    } else if (arg === '--json' || arg === '-j') {
      result.json = true;
    } else if (arg === '--compact' || arg === '-c') {
      result.compact = true;
    } else if (arg === '--links-only' || arg === '-l') {
      result.linksOnly = true;
    } else if (arg === '--model' || arg === '-m') {
      result.model = args[++i];
    } else if (arg === '--x-api' || arg === '--native') {
      result.useXApi = true;
    } else if (arg === '--max' || arg === '-n') {
      result.maxResults = parseInt(args[++i], 10);
    } else if (!arg.startsWith('-')) {
      result.query = args.slice(i).join(' ');
      break;
    }
    i++;
  }
  
  return result;
}

function getDateRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  
  return {
    from_date: from.toISOString().split('T')[0],
    to_date: to.toISOString().split('T')[0],
    from_iso: from.toISOString(),
    to_iso: to.toISOString(),
  };
}

// ==================== X API (Native) ====================

function buildXApiQuery(options) {
  let q = options.query;
  
  // Add handle filters
  if (options.handles.length > 0) {
    const fromClause = options.handles.map(h => `from:${h}`).join(' OR ');
    q = `(${fromClause}) ${q}`;
  }
  
  // Add exclusions
  if (options.excludeHandles.length > 0) {
    const excludeClause = options.excludeHandles.map(h => `-from:${h}`).join(' ');
    q = `${q} ${excludeClause}`;
  }
  
  // Exclude retweets by default for cleaner results
  q = `${q} -is:retweet`;
  
  return q;
}

async function searchXNative(options) {
  const bearerToken = getApiKey('x');
  if (!bearerToken) {
    console.error('❌ No X API Bearer Token found.');
    console.error('   Set X_BEARER_TOKEN environment variable.');
    console.error('   Get your token at: https://console.x.com');
    process.exit(1);
  }
  
  const dateRange = getDateRange(Math.min(options.days, 7)); // Recent search is 7 days max
  const query = buildXApiQuery(options);
  
  const params = new URLSearchParams({
    query: query,
    max_results: Math.min(options.maxResults, 100).toString(),
    'tweet.fields': 'created_at,author_id,public_metrics,entities',
    'user.fields': 'name,username,verified',
    'expansions': 'author_id',
    'start_time': dateRange.from_iso,
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: X_API_BASE,
      path: `/2/tweets/search/recent?${params.toString()}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
      },
    }, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`❌ X API Error (${res.statusCode}):`, data.slice(0, 500));
          process.exit(1);
        }
        
        try {
          const response = JSON.parse(data);
          
          // Full JSON output
          if (options.json) {
            console.log(JSON.stringify(response, null, 2));
            resolve(response);
            return;
          }
          
          // Build user lookup map
          const users = {};
          if (response.includes?.users) {
            for (const user of response.includes.users) {
              users[user.id] = user;
            }
          }
          
          // Format results
          const tweets = response.data || [];
          
          if (tweets.length === 0) {
            console.log('No results found.');
            resolve({ text: '', citations: [] });
            return;
          }
          
          const citations = [];
          const lines = [];
          
          for (const tweet of tweets) {
            const user = users[tweet.author_id] || { username: 'unknown', name: 'Unknown' };
            const url = `https://x.com/${user.username}/status/${tweet.id}`;
            citations.push(url);
            
            if (!options.linksOnly) {
              const date = tweet.created_at ? new Date(tweet.created_at).toLocaleDateString() : '';
              const metrics = tweet.public_metrics || {};
              const engagement = metrics.like_count ? ` (❤️ ${metrics.like_count})` : '';
              
              lines.push(`**@${user.username}** (${user.name}) — ${date}${engagement}`);
              lines.push(tweet.text);
              lines.push(`🔗 ${url}`);
              lines.push('');
            }
          }
          
          // Links only output
          if (options.linksOnly) {
            citations.forEach(url => console.log(url));
            resolve({ text: '', citations });
            return;
          }
          
          // Standard output
          console.log(lines.join('\n'));
          
          if (!options.compact) {
            console.log(`\n📊 Found ${tweets.length} tweets via X API`);
          }
          
          resolve({ text: lines.join('\n'), citations });
        } catch (e) {
          console.error('❌ Failed to parse response:', e.message);
          process.exit(1);
        }
      });
    });
    
    req.on('error', (e) => {
      console.error('❌ Request failed:', e.message);
      process.exit(1);
    });
    
    req.end();
  });
}

// ==================== xAI Grok x_search ====================

function extractContent(response) {
  if (!response.output) return { text: '', citations: [] };
  
  let text = '';
  let citations = [];
  
  for (const item of response.output) {
    if (item.type === 'message' && item.content) {
      for (const c of item.content) {
        if (c.type === 'output_text' && c.text) {
          text = c.text;
        }
        if (c.annotations) {
          for (const ann of c.annotations) {
            if (ann.type === 'url_citation' && ann.url) {
              if (ann.url.includes('x.com') || ann.url.includes('twitter.com')) {
                citations.push(ann.url);
              }
            }
          }
        }
      }
    }
  }
  
  citations = [...new Set(citations)];
  
  return { text, citations };
}

async function searchXGrok(options) {
  const apiKey = getApiKey('xai');
  if (!apiKey) {
    console.error('❌ No xAI API key found.');
    console.error('   Set XAI_API_KEY or run: clawdbot config set skills.entries.search-x.apiKey "xai-YOUR-KEY"');
    console.error('   Get your key at: https://console.x.ai');
    console.error('');
    console.error('   💡 Alternatively, use --x-api flag with X_BEARER_TOKEN for native X API search.');
    process.exit(1);
  }
  
  const dateRange = getDateRange(options.days);
  
  const xSearchTool = {
    type: 'x_search',
    x_search: {
      from_date: dateRange.from_date,
      to_date: dateRange.to_date,
    }
  };
  
  if (options.handles.length > 0) {
    xSearchTool.x_search.allowed_x_handles = options.handles;
  }
  if (options.excludeHandles.length > 0) {
    xSearchTool.x_search.excluded_x_handles = options.excludeHandles;
  }
  
  const systemPrompt = options.compact 
    ? 'You are an X/Twitter search assistant. Return only the tweets found, formatted simply with username, content, and link. No commentary.'
    : 'You are an X/Twitter search assistant. Search X and return real tweets with usernames, content, dates, and links. Be thorough but concise.';
  
  const payload = {
    model: options.model,
    input: `${systemPrompt}

Search X/Twitter for: ${options.query}

Return actual tweets with:
- @username (display name)
- Tweet content
- Date
- Link to tweet

Only include REAL posts. If none found, say so clearly.`,
    tools: [xSearchTool],
  };
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: XAI_API_BASE,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      
      res.on('data', chunk => data += chunk);
      
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`❌ API Error (${res.statusCode}):`, data.slice(0, 500));
          process.exit(1);
        }
        
        try {
          const response = JSON.parse(data);
          
          if (options.json) {
            console.log(JSON.stringify(response, null, 2));
            resolve(response);
            return;
          }
          
          const { text, citations } = extractContent(response);
          
          if (options.linksOnly) {
            if (citations.length > 0) {
              citations.forEach(url => console.log(url));
            } else {
              console.log('No X links found.');
            }
            resolve({ text, citations });
            return;
          }
          
          if (text) {
            console.log(text);
          } else {
            console.log('No results found.');
          }
          
          if (!options.compact && citations.length > 0) {
            console.log('\n📎 Citations (' + citations.length + '):');
            citations.slice(0, 10).forEach(url => console.log('   ' + url));
            if (citations.length > 10) {
              console.log(`   ... and ${citations.length - 10} more`);
            }
          }
          
          resolve({ text, citations });
        } catch (e) {
          console.error('❌ Failed to parse response:', e.message);
          process.exit(1);
        }
      });
    });
    
    req.on('error', (e) => {
      console.error('❌ Request failed:', e.message);
      process.exit(1);
    });
    
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// ==================== Main ====================

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) {
  console.log(`
🔍 Search X — Real-time Twitter/X search

Two modes:
  1. xAI Grok (default) - Uses x_search tool, up to 30 days, requires XAI_API_KEY
  2. X API (--x-api)    - Native search, up to 7 days, requires X_BEARER_TOKEN

Usage:
  search-x [options] "your search query"

Options:
  --days, -d <n>        Search last N days (default: ${DEFAULT_DAYS}, max 7 for --x-api)
  --handles, -h <list>  Only these handles (comma-separated, @ optional)
  --exclude, -e <list>  Exclude these handles
  --compact, -c         Minimal output (just tweets)
  --links-only, -l      Only output X links
  --json, -j            Full JSON response
  --max, -n <n>         Max results for --x-api (default: 20, max: 100)
  --x-api, --native     Use X API directly instead of xAI
  --model, -m <model>   Model for xAI (default: ${DEFAULT_MODEL})
  --help                Show this help

Environment:
  XAI_API_KEY           xAI API key (for default mode)
  X_BEARER_TOKEN        X API Bearer Token (for --x-api mode)

Examples:
  search-x "Claude Code tips"
  search-x --days 7 "AI news"
  search-x --x-api "trending AI"                    # Use X API directly
  search-x --x-api --max 50 "Remotion video"        # More results via X API
  search-x --handles elonmusk,OpenAI "announcements"
  search-x --links-only "trending tech"
`);
  process.exit(0);
}

const options = parseArgs(args);

if (!options.query) {
  console.error('❌ Please provide a search query');
  process.exit(1);
}

// Adjust days for X API (max 7)
if (options.useXApi && options.days > 7) {
  console.error(`⚠️  X API only supports 7-day lookback (requested ${options.days}), using 7 days.\n`);
  options.days = 7;
}

// Show search params
if (!options.json && !options.linksOnly) {
  const mode = options.useXApi ? 'X API' : 'xAI Grok';
  console.error(`🔍 Searching X via ${mode}: "${options.query}" (last ${options.days} days)...\n`);
}

// Run search
if (options.useXApi) {
  searchXNative(options);
} else {
  searchXGrok(options);
}
