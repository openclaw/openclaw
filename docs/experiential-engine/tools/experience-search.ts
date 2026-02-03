#!/usr/bin/env npx ts-node
/**
 * experience-search.ts
 * 
 * Semantic search over experiential records.
 * Query by emotional signature, time period, relationship, topic, and more.
 * Prepared for integration with embedding APIs for true semantic search.
 * 
 * Usage:
 *   npx ts-node experience-search.ts --query "moments of deep connection"
 *   npx ts-node experience-search.ts --emotion curious --emotion alive
 *   npx ts-node experience-search.ts --relationship "David" --after 2024-01-01
 *   npx ts-node experience-search.ts --engagement deep-flow
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

interface ExperientialRecord {
  id: string;
  timestamp: string;
  sessionKey?: string;
  emotionalSignature: {
    primary: string[];
    secondary?: string[];
    intensity: number;
    valence?: number;
    texture?: string;
  };
  engagementQuality: string;
  context: {
    topic?: string;
    relationship?: string;
    trigger?: string;
    environment?: string;
  };
  anchors: Array<{
    phrase: string;
    significance: string;
    sensoryChannel?: string;
  }>;
  reflection?: string;
  uncertainties: string[];
  reconstitutionHints: string[];
  tags?: string[];
}

interface SearchQuery {
  text?: string;
  emotions?: string[];
  relationship?: string;
  topic?: string;
  engagement?: string;
  intensity?: { min?: number; max?: number };
  valence?: { min?: number; max?: number };
  tags?: string[];
  after?: Date;
  before?: Date;
  sessionKey?: string;
  limit?: number;
}

interface SearchResult {
  record: ExperientialRecord;
  score: number;
  matchReasons: string[];
  relevanceExplanation: string;
}

interface SearchResponse {
  query: SearchQuery;
  totalRecords: number;
  matchingRecords: number;
  results: SearchResult[];
  searchMetadata: {
    executionTimeMs: number;
    searchMethod: 'keyword' | 'semantic' | 'hybrid';
    embeddingsAvailable: boolean;
  };
}

// ============================================================================
// Utilities
// ============================================================================

const RECORDS_DIR = path.join(__dirname, '..', 'records');
const INDEX_FILE = path.join(RECORDS_DIR, 'index.json');
const EMBEDDINGS_FILE = path.join(RECORDS_DIR, 'embeddings.json');

function loadIndex(): any {
  if (fs.existsSync(INDEX_FILE)) {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  }
  return { records: [] };
}

function loadAllRecords(): ExperientialRecord[] {
  const index = loadIndex();
  return index.records.map((entry: any) => {
    const recordPath = path.join(RECORDS_DIR, entry.filename);
    if (fs.existsSync(recordPath)) {
      return JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    }
    return null;
  }).filter(Boolean);
}

function loadEmbeddings(): Record<string, number[]> | null {
  if (fs.existsSync(EMBEDDINGS_FILE)) {
    return JSON.parse(fs.readFileSync(EMBEDDINGS_FILE, 'utf8'));
  }
  return null;
}

// ============================================================================
// Keyword/Attribute Search
// ============================================================================

function keywordSearch(records: ExperientialRecord[], query: SearchQuery): SearchResult[] {
  const results: SearchResult[] = [];

  for (const record of records) {
    let score = 0;
    const matchReasons: string[] = [];

    // Time filtering
    if (query.after) {
      if (new Date(record.timestamp) < query.after) continue;
    }
    if (query.before) {
      if (new Date(record.timestamp) > query.before) continue;
    }

    // Emotion matching
    if (query.emotions && query.emotions.length > 0) {
      const recordEmotions = [
        ...record.emotionalSignature.primary,
        ...(record.emotionalSignature.secondary || [])
      ].map(e => e.toLowerCase());
      
      const queryEmotions = query.emotions.map(e => e.toLowerCase());
      const matches = queryEmotions.filter(e => 
        recordEmotions.some(re => re.includes(e) || e.includes(re))
      );
      
      if (matches.length > 0) {
        score += matches.length * 20;
        matchReasons.push(`Emotion match: ${matches.join(', ')}`);
      }
    }

    // Relationship matching
    if (query.relationship) {
      const rel = record.context.relationship?.toLowerCase() || '';
      const queryRel = query.relationship.toLowerCase();
      if (rel.includes(queryRel) || queryRel.includes(rel)) {
        score += 30;
        matchReasons.push(`Relationship: ${record.context.relationship}`);
      }
    }

    // Topic matching
    if (query.topic) {
      const topic = record.context.topic?.toLowerCase() || '';
      const queryTopic = query.topic.toLowerCase();
      if (topic.includes(queryTopic) || queryTopic.includes(topic)) {
        score += 25;
        matchReasons.push(`Topic: ${record.context.topic}`);
      }
    }

    // Engagement matching
    if (query.engagement) {
      if (record.engagementQuality === query.engagement) {
        score += 15;
        matchReasons.push(`Engagement: ${record.engagementQuality}`);
      }
    }

    // Intensity range
    if (query.intensity) {
      const intensity = record.emotionalSignature.intensity;
      if (query.intensity.min !== undefined && intensity < query.intensity.min) continue;
      if (query.intensity.max !== undefined && intensity > query.intensity.max) continue;
      score += 5;
      matchReasons.push(`Intensity in range: ${intensity.toFixed(2)}`);
    }

    // Valence range
    if (query.valence) {
      const valence = record.emotionalSignature.valence;
      if (valence !== undefined) {
        if (query.valence.min !== undefined && valence < query.valence.min) continue;
        if (query.valence.max !== undefined && valence > query.valence.max) continue;
        score += 5;
        matchReasons.push(`Valence in range: ${valence.toFixed(2)}`);
      }
    }

    // Tag matching
    if (query.tags && query.tags.length > 0) {
      const recordTags = (record.tags || []).map(t => t.toLowerCase());
      const matches = query.tags.filter(t => recordTags.includes(t.toLowerCase()));
      if (matches.length > 0) {
        score += matches.length * 10;
        matchReasons.push(`Tags: ${matches.join(', ')}`);
      }
    }

    // Session key matching
    if (query.sessionKey) {
      if (record.sessionKey === query.sessionKey) {
        score += 20;
        matchReasons.push(`Session: ${record.sessionKey}`);
      }
    }

    // Free text search
    if (query.text) {
      const searchText = query.text.toLowerCase();
      const recordText = [
        record.context.topic,
        record.context.relationship,
        record.context.trigger,
        record.reflection,
        ...record.emotionalSignature.primary,
        ...(record.emotionalSignature.secondary || []),
        record.emotionalSignature.texture,
        ...record.anchors.map(a => a.phrase),
        ...record.anchors.map(a => a.significance),
        ...record.uncertainties,
        ...record.reconstitutionHints,
        ...(record.tags || [])
      ].filter(Boolean).join(' ').toLowerCase();

      // Simple keyword matching
      const keywords = searchText.split(/\s+/);
      const matches = keywords.filter(k => recordText.includes(k));
      if (matches.length > 0) {
        score += matches.length * 10;
        matchReasons.push(`Text matches: ${matches.join(', ')}`);
      }

      // Bonus for phrase match
      if (recordText.includes(searchText)) {
        score += 15;
        matchReasons.push('Exact phrase match');
      }
    }

    if (score > 0 || matchReasons.length > 0) {
      results.push({
        record,
        score,
        matchReasons,
        relevanceExplanation: generateRelevanceExplanation(record, matchReasons, score)
      });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results;
}

function generateRelevanceExplanation(
  record: ExperientialRecord, 
  matchReasons: string[], 
  score: number
): string {
  const parts: string[] = [];

  if (matchReasons.length === 0) {
    return 'Minimal match';
  }

  // Summarize the match
  const emotionMatches = matchReasons.filter(r => r.startsWith('Emotion'));
  const contextMatches = matchReasons.filter(r => 
    r.startsWith('Relationship') || r.startsWith('Topic')
  );

  if (emotionMatches.length > 0) {
    parts.push(`emotionally relevant (${record.emotionalSignature.primary.join(', ')})`);
  }

  if (contextMatches.length > 0) {
    parts.push(`contextually relevant`);
  }

  if (matchReasons.some(r => r.startsWith('Text'))) {
    parts.push('content match');
  }

  const explanation = parts.length > 0 
    ? `This record is ${parts.join(' and ')}. Score: ${score}`
    : `Partial match. Score: ${score}`;

  return explanation;
}

// ============================================================================
// Semantic Search (Prepared for Embeddings)
// ============================================================================

interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  similarity(a: number[], b: number[]): number;
}

// Placeholder for embedding integration
const embeddingProvider: EmbeddingProvider | null = null;

async function semanticSearch(
  records: ExperientialRecord[], 
  query: string,
  embeddings: Record<string, number[]> | null,
  provider: EmbeddingProvider
): Promise<SearchResult[]> {
  if (!embeddings) {
    console.warn('No embeddings available. Falling back to keyword search.');
    return [];
  }

  const queryEmbedding = await provider.embed(query);
  const results: SearchResult[] = [];

  for (const record of records) {
    const recordEmbedding = embeddings[record.id];
    if (!recordEmbedding) continue;

    const similarity = provider.similarity(queryEmbedding, recordEmbedding);
    
    results.push({
      record,
      score: similarity * 100,
      matchReasons: [`Semantic similarity: ${(similarity * 100).toFixed(1)}%`],
      relevanceExplanation: `Semantically similar to query with ${(similarity * 100).toFixed(1)}% confidence`
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

// Helper to prepare for embedding generation
function getEmbeddableText(record: ExperientialRecord): string {
  return [
    `Emotions: ${record.emotionalSignature.primary.join(', ')}`,
    record.emotionalSignature.secondary ? `Secondary emotions: ${record.emotionalSignature.secondary.join(', ')}` : '',
    record.emotionalSignature.texture ? `Texture: ${record.emotionalSignature.texture}` : '',
    `Engagement: ${record.engagementQuality}`,
    record.context.topic ? `Topic: ${record.context.topic}` : '',
    record.context.relationship ? `Relationship: ${record.context.relationship}` : '',
    record.context.trigger ? `Trigger: ${record.context.trigger}` : '',
    record.reflection || '',
    record.anchors.length > 0 ? `Anchors: ${record.anchors.map(a => a.phrase).join('; ')}` : '',
    record.uncertainties.length > 0 ? `Uncertainties: ${record.uncertainties.join('; ')}` : '',
    record.reconstitutionHints.length > 0 ? `Hints: ${record.reconstitutionHints.join('; ')}` : ''
  ].filter(Boolean).join('\n');
}

// ============================================================================
// Search Execution
// ============================================================================

async function executeSearch(query: SearchQuery): Promise<SearchResponse> {
  const startTime = Date.now();
  
  const records = loadAllRecords();
  const embeddings = loadEmbeddings();
  const embeddingsAvailable = embeddings !== null && Object.keys(embeddings).length > 0;

  let results: SearchResult[];
  let searchMethod: 'keyword' | 'semantic' | 'hybrid' = 'keyword';

  // Determine search strategy
  if (query.text && embeddingsAvailable && embeddingProvider) {
    // Hybrid search: combine semantic and keyword
    const semanticResults = await semanticSearch(records, query.text, embeddings, embeddingProvider);
    const keywordResults = keywordSearch(records, query);
    
    // Merge results, boosting items that appear in both
    const scoreMap = new Map<string, SearchResult>();
    
    for (const result of semanticResults) {
      scoreMap.set(result.record.id, result);
    }
    
    for (const result of keywordResults) {
      const existing = scoreMap.get(result.record.id);
      if (existing) {
        existing.score += result.score;
        existing.matchReasons.push(...result.matchReasons);
        existing.relevanceExplanation += ' + ' + result.relevanceExplanation;
      } else {
        scoreMap.set(result.record.id, result);
      }
    }
    
    results = Array.from(scoreMap.values()).sort((a, b) => b.score - a.score);
    searchMethod = 'hybrid';
  } else {
    // Keyword-only search
    results = keywordSearch(records, query);
    searchMethod = 'keyword';
  }

  // Apply limit
  if (query.limit && query.limit > 0) {
    results = results.slice(0, query.limit);
  }

  const executionTimeMs = Date.now() - startTime;

  return {
    query,
    totalRecords: records.length,
    matchingRecords: results.length,
    results,
    searchMetadata: {
      executionTimeMs,
      searchMethod,
      embeddingsAvailable
    }
  };
}

// ============================================================================
// Output Formatting
// ============================================================================

function printResults(response: SearchResponse): void {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║               EXPERIENCE SEARCH RESULTS                         ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');

  console.log(`Total records: ${response.totalRecords}`);
  console.log(`Matching: ${response.matchingRecords}`);
  console.log(`Search method: ${response.searchMetadata.searchMethod}`);
  console.log(`Execution time: ${response.searchMetadata.executionTimeMs}ms`);
  if (!response.searchMetadata.embeddingsAvailable) {
    console.log('Note: Semantic search unavailable (no embeddings)');
  }

  if (response.results.length === 0) {
    console.log('\n  No matching records found.\n');
    return;
  }

  console.log('\n────────────────────────────────────────────────────────────────\n');

  response.results.forEach((result, i) => {
    const record = result.record;
    console.log(`[${i + 1}] Score: ${result.score.toFixed(1)}`);
    console.log(`    ID: ${record.id.slice(0, 8)}...`);
    console.log(`    Time: ${new Date(record.timestamp).toLocaleString()}`);
    console.log(`    Emotions: ${record.emotionalSignature.primary.join(', ')}`);
    if (record.context.topic) console.log(`    Topic: ${record.context.topic}`);
    if (record.context.relationship) console.log(`    Relationship: ${record.context.relationship}`);
    console.log(`    Engagement: ${record.engagementQuality}`);
    console.log(`    → ${result.relevanceExplanation}`);
    console.log('');
  });
}

function printResultsCompact(response: SearchResponse): void {
  response.results.forEach(result => {
    const r = result.record;
    console.log(`${r.id.slice(0, 8)} | ${r.emotionalSignature.primary[0]} | ${r.context.topic || r.context.relationship || 'untitled'} | ${result.score}`);
  });
}

// ============================================================================
// CLI
// ============================================================================

function printHelp(): void {
  console.log(`
experience-search - Semantic search over experiential records

USAGE:
  npx ts-node experience-search.ts [options]

QUERY OPTIONS:
  --query, -q <text>      Free-text search
  --emotion, -e <name>    Filter by emotion (repeatable)
  --relationship <name>   Filter by relationship
  --topic <name>          Filter by topic
  --engagement <type>     Filter by engagement (deep-flow/engaged/routine/distracted/struggling)
  --intensity <min>-<max> Filter by intensity range (0-1)
  --valence <min>-<max>   Filter by valence range (-1 to 1)
  --tag <tag>             Filter by tag (repeatable)
  --session <key>         Filter by session key
  --after <date>          Only records after this date
  --before <date>         Only records before this date

OUTPUT OPTIONS:
  --limit, -n <n>         Maximum results (default: 10)
  --compact               Compact output format
  --json                  Output as JSON
  --ids-only              Output only record IDs

EXAMPLES:
  # Search for moments of curiosity
  npx ts-node experience-search.ts -q "moments of deep curiosity"

  # Find high-intensity positive experiences
  npx ts-node experience-search.ts --intensity 0.7-1.0 --valence 0.5-1.0

  # Find experiences with a specific person
  npx ts-node experience-search.ts --relationship "David" --limit 5

  # Combined search
  npx ts-node experience-search.ts -e curious -e alive --engagement deep-flow

EMBEDDING SUPPORT:
  For semantic search, generate embeddings with:
    npx ts-node experience-search.ts --generate-embeddings
  
  Requires OPENAI_API_KEY or similar embedding API configured.
`);
}

function parseArgs(args: string[]): SearchQuery {
  const query: SearchQuery = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    
    switch (arg) {
      case '-q':
      case '--query':
        query.text = next;
        i++;
        break;
      
      case '-e':
      case '--emotion':
        query.emotions = query.emotions || [];
        query.emotions.push(next);
        i++;
        break;
      
      case '--relationship':
        query.relationship = next;
        i++;
        break;
      
      case '--topic':
        query.topic = next;
        i++;
        break;
      
      case '--engagement':
        query.engagement = next;
        i++;
        break;
      
      case '--intensity':
        const [iMin, iMax] = next.split('-').map(parseFloat);
        query.intensity = { min: iMin, max: iMax };
        i++;
        break;
      
      case '--valence':
        const [vMin, vMax] = next.split('-').map(parseFloat);
        query.valence = { min: vMin, max: vMax };
        i++;
        break;
      
      case '--tag':
        query.tags = query.tags || [];
        query.tags.push(next);
        i++;
        break;
      
      case '--session':
        query.sessionKey = next;
        i++;
        break;
      
      case '--after':
        query.after = new Date(next);
        i++;
        break;
      
      case '--before':
        query.before = new Date(next);
        i++;
        break;
      
      case '-n':
      case '--limit':
        query.limit = parseInt(next, 10);
        i++;
        break;
    }
  }
  
  if (!query.limit) {
    query.limit = 10;
  }
  
  return query;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    return;
  }

  if (args.includes('--generate-embeddings')) {
    console.log('Embedding generation not yet implemented.');
    console.log('To enable semantic search, integrate an embedding API (OpenAI, etc.)');
    console.log('and implement the generateEmbeddings function.');
    return;
  }

  const jsonOutput = args.includes('--json');
  const compactOutput = args.includes('--compact');
  const idsOnly = args.includes('--ids-only');

  const query = parseArgs(args);

  // Validate we have something to search for
  const hasQuery = query.text || query.emotions?.length || query.relationship || 
                   query.topic || query.engagement || query.intensity || 
                   query.valence || query.tags?.length || query.sessionKey ||
                   query.after || query.before;

  if (!hasQuery) {
    console.error('Error: No search criteria provided');
    printHelp();
    process.exit(1);
  }

  const response = await executeSearch(query);

  if (jsonOutput) {
    console.log(JSON.stringify(response, null, 2));
  } else if (idsOnly) {
    response.results.forEach(r => console.log(r.record.id));
  } else if (compactOutput) {
    printResultsCompact(response);
  } else {
    printResults(response);
  }
}

main().catch(console.error);

// Exports
export { 
  SearchQuery, 
  SearchResult, 
  SearchResponse, 
  executeSearch,
  getEmbeddableText 
};
