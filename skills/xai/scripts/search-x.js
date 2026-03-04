#!/usr/bin/env node
/**
 * xAI X Search Script - Uses Responses API with x_search tool
 *
 * Usage:
 *   node search-x.js "Remotion best practices"
 *   node search-x.js --days 30 "AI video creation"
 *   node search-x.js --handles @remotion_dev,@jonnyburger "updates"
 */

const https = require('https');

const API_BASE = 'api.x.ai';
const DEFAULT_MODEL = 'grok-4-1-fast';

function getApiKey() {
  return process.env.XAI_API_KEY || null;
}

function parseArgs(args) {
  const result = {
    model: DEFAULT_MODEL,
    query: '',
    days: 30,
    handles: [],
    excludeHandles: [],
    json: false,
    requireCitations: true,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--model' || arg === '-m') {
      result.model = args[++i];
    } else if (arg === '--days' || arg === '-d') {
      result.days = parseInt(args[++i], 10);
    } else if (arg === '--handles' || arg === '-h') {
      result.handles = args[++i].split(',').map((h) => h.trim());
    } else if (arg === '--exclude') {
      result.excludeHandles = args[++i].split(',').map((h) => h.trim());
    } else if (arg === '--json' || arg === '-j') {
      result.json = true;
    } else if (arg === '--no-require-citations') {
      result.requireCitations = false;
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
  };
}

async function searchX(options) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('❌ No API key found. Set XAI_API_KEY or configure in openclaw.');
    process.exit(1);
  }

  const dateRange = getDateRange(options.days);

  const xSearchTool = {
    type: 'x_search',
    x_search: {
      from_date: dateRange.from_date,
      to_date: dateRange.to_date,
    },
  };

  if (options.handles.length > 0) {
    xSearchTool.x_search.allowed_x_handles = options.handles;
  }
  if (options.excludeHandles.length > 0) {
    xSearchTool.x_search.excluded_x_handles = options.excludeHandles;
  }

  const payload = {
    model: options.model,
    input: `Search X/Twitter and find real posts about: ${options.query}

Give me actual tweets with:
- Username/handle
- The actual tweet content
- Date if available
- Link to the tweet

Only include REAL posts you find. If you can't find any, say so.`,
    tools: [xSearchTool],
  };

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: API_BASE,
        path: '/v1/responses',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = '';

        res.on('data', (chunk) => (data += chunk));

        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.error(`❌ API Error (${res.statusCode}):`, data);
            process.exit(1);
          }

          try {
            const response = JSON.parse(data);

            if (options.json) {
              console.log(JSON.stringify(response, null, 2));
              resolve(response);
              return;
            }

            let content = '(no response)';
            if (response.output) {
              for (const item of response.output) {
                if (item.type === 'message' && item.content) {
                  for (const c of item.content) {
                    if (c.type === 'output_text' && c.text) {
                      content = c.text;
                    }
                  }
                }
              }
            }

            let xCitations = [];
            if (response.output) {
              for (const item of response.output) {
                if (item.content) {
                  for (const c of item.content) {
                    if (c.annotations) {
                      for (const ann of c.annotations) {
                        if (ann.type === 'url_citation' && ann.url) {
                          if (ann.url.includes('x.com') || ann.url.includes('twitter.com')) {
                            xCitations.push(ann);
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
            xCitations = [...new Map(xCitations.map((c) => [c.url, c])).values()];

            if (options.requireCitations && xCitations.length === 0) {
              console.error('⚠️  No X/Twitter citations found in response.\n');
            }

            console.log(content);

            if (xCitations.length > 0) {
              console.log('\n📎 Citations:');
              for (const cite of xCitations) {
                console.log(`   ${cite.url}`);
              }
            }

            resolve(response);
          } catch (e) {
            console.error('❌ Failed to parse response:', e.message);
            process.exit(1);
          }
        });
      },
    );

    req.on('error', (e) => {
      console.error('❌ Request failed:', e.message);
      process.exit(1);
    });

    req.write(JSON.stringify(payload));
    req.end();
  });
}

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help')) {
  console.log(`
🔍 xAI X Search

Usage:
  node search-x.js [options] "Your search query"

Options:
  --model, -m <model>     Model (default: grok-4-1-fast)
  --days, -d <n>          Search last N days (default: 30)
  --handles <list>        Only these handles (comma-separated)
  --exclude <list>        Exclude these handles
  --json, -j              Output full JSON
  --no-require-citations Don't warn if no X citations
`);
  process.exit(0);
}

const options = parseArgs(args);

if (!options.query) {
  console.error('❌ Please provide a search query');
  process.exit(1);
}

console.error(`🔍 Searching X for: "${options.query}" (last ${options.days} days)...\n`);
searchX(options);
