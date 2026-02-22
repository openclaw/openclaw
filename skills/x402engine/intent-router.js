// Match user queries to services via catalog description scoring + synonym
// expansion + parameter extraction. Catalog-driven — no hardcoded service list.

const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'can', 'check', 'current', 'do', 'for',
  'get', 'give', 'how', 'i', 'is', 'it', 'latest', 'me', 'much',
  'my', 'of', 'on', 'please', 'show', 'tell', 'the', 'to', 'want',
  'what', 'whats', "what's", 'with', 'you',
]);

const SYNONYM_MAP = {
  // Crypto price
  'price': ['crypto-price'],
  'cost': ['crypto-price'],
  'quote': ['crypto-price'],
  'worth': ['crypto-price'],
  'btc': ['crypto-price'],
  'bitcoin': ['crypto-price'],
  'eth': ['crypto-price'],
  'ethereum': ['crypto-price'],
  'sol': ['crypto-price'],
  'solana': ['crypto-price'],

  // Markets
  'market': ['crypto-markets'],
  'markets': ['crypto-markets'],
  'ranking': ['crypto-markets'],
  'rankings': ['crypto-markets'],
  'leaderboard': ['crypto-markets'],
  'top': ['crypto-markets'],

  // Trending
  'trending': ['crypto-trending'],
  'popular': ['crypto-trending'],
  'hot': ['crypto-trending'],

  // History
  'history': ['crypto-history'],
  'historical': ['crypto-history'],
  'chart': ['crypto-history'],

  // Search
  'search': ['crypto-search'],
  'find': ['crypto-search'],
  'lookup': ['crypto-search'],

  // Image
  'image': ['image-fast', 'image-quality', 'image-text'],
  'draw': ['image-fast'],
  'generate': ['image-fast'],
  'picture': ['image-fast'],
  'photo': ['image-quality'],
  'logo': ['image-text'],

  // Video
  'video': ['video-fast', 'video-quality'],
  'animate': ['video-animate'],
  'animation': ['video-animate'],
  'clip': ['video-fast'],

  // Code
  'run': ['code-run'],
  'execute': ['code-run'],
  'code': ['code-run'],
  'python': ['code-run'],
  'javascript': ['code-run'],
  'bash': ['code-run'],

  // Transcribe
  'transcribe': ['transcribe'],
  'transcription': ['transcribe'],
  'audio': ['transcribe'],
  'speech': ['transcribe', 'tts-openai', 'tts-elevenlabs'],

  // Wallet
  'wallet': ['wallet-balances', 'wallet-transactions'],
  'balance': ['wallet-balances'],
  'balances': ['wallet-balances'],
  'transactions': ['wallet-transactions'],
  'activity': ['wallet-transactions'],
  'transfers': ['wallet-transactions'],

  // Token
  'token': ['token-prices', 'token-metadata'],
  'metadata': ['token-metadata'],

  // IPFS
  'ipfs': ['ipfs-pin', 'ipfs-get'],
  'pin': ['ipfs-pin'],

  // ENS
  'ens': ['ens-resolve', 'ens-reverse'],
  'resolve': ['ens-resolve'],

  // LLM
  'ask': ['llm-llama'],
  'prompt': ['llm-llama'],
  'llm': ['llm-llama'],
  'llama': ['llm-llama'],
  'gpt': ['llm-gpt-4o'],
  'claude': ['llm-claude-sonnet'],
  'gemini': ['llm-gemini-pro'],
  'deepseek': ['llm-deepseek'],
  'grok': ['llm-grok'],
  'perplexity': ['llm-perplexity'],

  // Web
  'scrape': ['web-scrape'],
  'screenshot': ['web-screenshot'],
  'webpage': ['web-scrape'],

  // TTS
  'tts': ['tts-openai'],
  'speak': ['tts-openai'],
  'voice': ['tts-elevenlabs'],

  // Embeddings
  'embed': ['embeddings'],
  'embedding': ['embeddings'],
  'embeddings': ['embeddings'],

  // Simulate
  'simulate': ['tx-simulate'],
  'simulation': ['tx-simulate'],
};

function tokenize(text) {
  return String(text || '').toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function contentTokens(text) {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

/**
 * Score each catalog service against the user query.
 * Returns sorted array of { service, score } where score > 0.
 */
function scoreServices(query, services) {
  const tokens = contentTokens(query);
  if (!tokens.length) return [];

  const results = [];
  for (const svc of services) {
    let score = 0;

    // 1. Synonym bonus: if any query token maps to this service id.
    for (const t of tokens) {
      const synonymTargets = SYNONYM_MAP[t];
      if (synonymTargets && synonymTargets.includes(svc.id)) {
        score += 10;
      }
    }

    // 2. Description word overlap.
    const descTokens = new Set(contentTokens(`${svc.name || ''} ${svc.description || ''} ${svc.id || ''}`));
    for (const t of tokens) {
      if (descTokens.has(t)) score += 3;
    }

    // 3. ID substring match.
    const idLower = (svc.id || '').toLowerCase();
    for (const t of tokens) {
      if (t.length >= 3 && idLower.includes(t)) score += 5;
    }

    if (score > 0) {
      results.push({ service: svc, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ---- Parameter extraction helpers ----

const COINGECKO_ID_MAP = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  sol: 'solana', solana: 'solana',
  usdc: 'usd-coin', usdt: 'tether',
  dai: 'dai', bnb: 'binancecoin',
  xrp: 'ripple', doge: 'dogecoin',
  ada: 'cardano', avax: 'avalanche-2',
  matic: 'polygon', dot: 'polkadot',
  link: 'chainlink', uni: 'uniswap',
  atom: 'cosmos', near: 'near',
  apt: 'aptos', sui: 'sui',
  arb: 'arbitrum', op: 'optimism',
};

function normalizeCoingeckoId(s) {
  const lower = String(s || '').trim().toLowerCase();
  return COINGECKO_ID_MAP[lower] ?? lower;
}

function extractCryptoAsset(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (STOPWORDS.has(t)) continue;
    if (/^\d+(?:d|h|m)?$/.test(t)) continue;
    if (t.length < 2) continue;
    if (COINGECKO_ID_MAP[t]) return normalizeCoingeckoId(t);
    // If it's not a known keyword, treat it as a potential id.
    if (!SYNONYM_MAP[t]) return t;
  }
  return null;
}

const ENS_RE = /\b[a-z0-9][a-z0-9.-]{1,253}\.eth\b/i;
const EVM_ADDR_RE = /\b0x[a-f0-9]{40}\b/i;

function extractWalletAddress(text) {
  const ens = text.match(ENS_RE);
  if (ens) return ens[0].toLowerCase();
  const addr = text.match(EVM_ADDR_RE);
  if (addr) return addr[0];
  return null;
}

function extractImagePrompt(text) {
  // Strip the trigger keyword and quality modifier.
  return text
    .replace(/^.*?\b(?:image|draw|generate\s+image|create\s+image|picture|photo)\b\s*/i, '')
    .replace(/^(fast|quality|text)\s+/i, '')
    .trim() || null;
}

function extractImageMode(text) {
  const lower = text.toLowerCase();
  if (/\bquality\b/.test(lower)) return 'quality';
  if (/\btext\b/.test(lower) || /\blogo\b/.test(lower)) return 'text';
  return 'fast';
}

/**
 * Match a user query to a catalog service.
 *
 * @param {string} query - Natural language user query
 * @param {object[]} services - Service catalog from discovery
 * @returns {{ service: object, params: object } | null}
 */
export function matchQuery(query, services) {
  if (!query || !services?.length) return null;

  const scored = scoreServices(query, services);
  if (!scored.length) return null;

  const best = scored[0];
  const svc = best.service;
  const tokens = contentTokens(query);
  const params = {};

  // Extract params based on matched service category.
  const id = svc.id || '';

  if (id.startsWith('crypto-price')) {
    const asset = extractCryptoAsset(tokens);
    if (asset) params.ids = asset;
    params.currencies = 'usd';
  } else if (id === 'crypto-markets') {
    params.currency = 'usd';
  } else if (id === 'crypto-history') {
    const asset = extractCryptoAsset(tokens);
    if (asset) params.id = asset;
    const daysMatch = query.match(/\b(\d{1,4})\s*d(?:ays?)?\b/i);
    params.days = daysMatch ? daysMatch[1] : '30';
  } else if (id === 'crypto-search') {
    const asset = extractCryptoAsset(tokens) || tokens.filter((t) => !SYNONYM_MAP[t]).join(' ');
    params.q = asset;
  } else if (id.startsWith('image-')) {
    params.prompt = extractImagePrompt(query);
    // Override service selection based on mode keyword.
    const mode = extractImageMode(query);
    const modeId = `image-${mode}`;
    const modeSvc = services.find((s) => s.id === modeId);
    if (modeSvc) return { service: modeSvc, params };
  } else if (id.startsWith('video-')) {
    params.prompt = query.replace(/^.*?\b(?:video|clip|animate)\b\s*/i, '').trim() || query;
  } else if (id === 'code-run') {
    params.code = query.replace(/^.*?\b(?:run|execute|code)\b\s*/i, '').trim();
    params.language = 'python';
  } else if (id.startsWith('wallet-')) {
    params.address = extractWalletAddress(query);
    const chainMatch = query.match(/\b(?:on|in)\s+([a-z][a-z0-9_-]{1,30})\b/i);
    params.chain = chainMatch ? chainMatch[1].toLowerCase() : 'base';
  } else if (id === 'ens-resolve') {
    const ens = query.match(ENS_RE);
    if (ens) params.name = ens[0].toLowerCase();
  } else if (id.startsWith('llm-')) {
    // Extract prompt text after the model keyword.
    const modelNames = ['llama', 'gpt', 'claude', 'gemini', 'deepseek', 'grok', 'perplexity', 'qwen', 'mistral'];
    let prompt = query;
    for (const m of modelNames) {
      const re = new RegExp(`\\b${m}\\b\\s*`, 'i');
      prompt = prompt.replace(re, '');
    }
    prompt = prompt.replace(/^.*?\b(?:ask|prompt|llm|model)\b\s*/i, '').trim();
    params.messages = [{ role: 'user', content: prompt || query }];
  } else if (id === 'web-scrape' || id === 'web-screenshot') {
    const urlMatch = query.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) params.url = urlMatch[0];
  } else if (id.startsWith('tts-')) {
    params.text = query.replace(/^.*?\b(?:speak|say|tts|voice|text.to.speech)\b\s*/i, '').trim() || query;
  }

  return { service: svc, params };
}

export { scoreServices, normalizeCoingeckoId, STOPWORDS, SYNONYM_MAP };
