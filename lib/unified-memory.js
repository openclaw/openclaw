/**
 * Unified Memory Store
 * 
 * Single interface for all memory operations.
 * Combines: core memory, session context, experiences, decisions
 * With configurable scoring: semantic + recency + importance
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const CORE_FILE = path.join(MEMORY_DIR, 'MEMORY.md');

// Namespace configuration
const NAMESPACES = {
  core: {
    path: CORE_FILE,
    ttl: null, // Never expires
    weight: 0.4
  },
  session: {
    path: path.join(MEMORY_DIR, 'session'),
    ttl: '1h',
    weight: 0.3
  },
  decisions: {
    path: path.join(MEMORY_DIR, 'decisions', 'decisions.jsonl'),
    ttl: '30d',
    weight: 0.2
  },
  experiences: {
    path: path.join(MEMORY_DIR, 'experiences'),
    ttl: '90d',
    weight: 0.1
  }
};

/**
 * Retrieve memories across all namespaces
 * @param {Object} params
 * @param {string} params.query - Search query
 * @param {string[]} params.namespaces - Which namespaces to search (default: all)
 * @param {Object} params.weights - Scoring weights (semantic, recency, importance)
 * @param {number} params.limit - Max results
 * @returns {Array} Ranked memories
 */
function retrieve({ 
  query, 
  namespaces = Object.keys(NAMESPACES),
  weights = { semantic: 0.5, recency: 0.3, importance: 0.2 },
  limit = 10 
}) {
  const results = [];
  
  for (const ns of namespaces) {
    const config = NAMESPACES[ns];
    if (!config) continue;
    
    const memories = loadNamespace(ns, config);
    
    for (const memory of memories) {
      const score = calculateScore(memory, query, weights);
      if (score > 0.3) { // Threshold
        results.push({
          ...memory,
          namespace: ns,
          score,
          weightedScore: score * config.weight
        });
      }
    }
  }
  
  // Sort by weighted score
  results.sort((a, b) => b.weightedScore - a.weightedScore);
  
  return results.slice(0, limit);
}

/**
 * Store memory in appropriate namespace
 * @param {string} namespace - Target namespace
 * @param {Object} data - Memory data
 */
function store(namespace, data) {
  const config = NAMESPACES[namespace];
  if (!config) throw new Error(`Unknown namespace: ${namespace}`);
  
  const entry = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    ...data,
    importance: data.importance || 5 // 1-10 scale
  };
  
  // Append to appropriate storage
  if (namespace === 'decisions') {
    appendJsonl(config.path, entry);
  } else if (namespace === 'experiences') {
    const file = path.join(config.path, `${new Date().toISOString().split('T')[0]}.jsonl`);
    appendJsonl(file, entry);
  } else {
    // Core and session use markdown
    appendMarkdown(config.path, entry);
  }
  
  return entry.id;
}

/**
 * Load all memories from a namespace
 */
function loadNamespace(ns, config) {
  const memories = [];
  
  try {
    if (ns === 'decisions') {
      return loadJsonl(config.path);
    } else if (ns === 'experiences') {
      const files = fs.readdirSync(config.path).filter(f => f.endsWith('.jsonl'));
      for (const file of files.slice(-7)) { // Last 7 days
        memories.push(...loadJsonl(path.join(config.path, file)));
      }
      return memories;
    } else {
      // Markdown files
      const content = fs.readFileSync(config.path, 'utf8');
      return parseMarkdownSections(content);
    }
  } catch (e) {
    return [];
  }
}

/**
 * Calculate relevance score
 */
function calculateScore(memory, query, weights) {
  const text = `${memory.title || ''} ${memory.content || ''} ${memory.decision || ''}`.toLowerCase();
  const queryLower = query.toLowerCase();
  
  // Semantic match (simplified - keyword overlap)
  const queryWords = queryLower.split(/\s+/);
  const matches = queryWords.filter(w => text.includes(w)).length;
  const semanticScore = matches / queryWords.length;
  
  // Recency score
  const age = Date.now() - new Date(memory.timestamp || 0).getTime();
  const daysOld = age / (1000 * 60 * 60 * 24);
  const recencyScore = Math.max(0, 1 - (daysOld / 30)); // Decay over 30 days
  
  // Importance score
  const importanceScore = (memory.importance || 5) / 10;
  
  return (
    semanticScore * weights.semantic +
    recencyScore * weights.recency +
    importanceScore * weights.importance
  );
}

/**
 * Generate unique ID
 */
function generateId() {
  return `mem-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Append to JSONL file
 */
function appendJsonl(filePath, entry) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

/**
 * Load JSONL file
 */
function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Append to markdown file
 */
function appendMarkdown(filePath, entry) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  const section = `\n## ${entry.title || 'Entry'} [${entry.id}]\n` +
    `- **Time:** ${entry.timestamp}\n` +
    `- **Importance:** ${entry.importance}/10\n\n` +
    `${entry.content}\n`;
  
  fs.appendFileSync(filePath, section);
}

/**
 * Parse markdown into sections
 */
function parseMarkdownSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let current = null;
  
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      const match = line.match(/## (.+?) \[(.+?)\]/);
      current = {
        title: match ? match[1] : line.replace('## ', ''),
        id: match ? match[2] : null,
        content: ''
      };
    } else if (current) {
      current.content += line + '\n';
    }
  }
  
  if (current) sections.push(current);
  return sections;
}

/**
 * Auto-cleanup expired memories
 */
function cleanupExpired() {
  for (const [ns, config] of Object.entries(NAMESPACES)) {
    if (!config.ttl) continue;
    
    const ttlMs = parseTTL(config.ttl);
    const cutoff = Date.now() - ttlMs;
    
    // For JSONL namespaces, filter out old entries
    if (ns === 'experiences') {
      const files = fs.readdirSync(config.path).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const fileDate = new Date(file.replace('.jsonl', ''));
        if (fileDate.getTime() < cutoff) {
          fs.unlinkSync(path.join(config.path, file));
        }
      }
    }
  }
}

/**
 * Parse TTL string to milliseconds
 */
function parseTTL(ttl) {
  const match = ttl.match(/(\d+)([smhd])/);
  if (!match) return 0;
  const [, num, unit] = match;
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(num) * multipliers[unit];
}

module.exports = {
  retrieve,
  store,
  cleanupExpired,
  NAMESPACES
};
