# Mature Tool Integration Analysis for GraphRAG

**Date:** 2026-01-26
**Purpose:** Evaluate mature solutions to integrate vs. build from scratch
**Status:** Analysis Document

---

## Executive Summary

**Key Insight:** We should **integrate mature tools** for:
1. Vector search (LanceDB, sqlite-vec)
2. Knowledge graph extraction (LlamaIndex, LightRAG)
3. Document parsing (Unstructured, Marker)
4. Reranking (Cohere, sentence-transformers)

**Build ourselves:**
1. Crawler orchestration (Node.js ecosystem is sufficient)
2. Storage abstraction (already designed in ZAI-DATASTORE.md)
3. CLI integration (project-specific)

**Recommendation:** Hybrid approach - integrate where maturity exists, build where project-specific needs dominate.

---

## Part 1: Vector Search & Embedding Storage

### 1.1 Options Analysis

| Tool | Type | Maturity | Pros | Cons | Recommendation |
|------|------|----------|------|------|----------------|
| **LanceDB** | Embedded DB | High | - Zero-config<br>- Serverless<br>- S3-compatible<br>- Great TypeScript SDK | - Newer ecosystem | **HIGH** |
| **sqlite-vec** | SQLite Extension | High | - Built into SQLite<br>- Zero dependencies<br>- We already use SQLite | - No PostgreSQL equivalent | **HIGH** |
| **ChromaDB** | Vector DB | High | - Native Python/JS<br>- Docker ready<br>- Easy to use | - Separate service to manage<br>- Heavier than sqlite-vec | MEDIUM |
| **Qdrant** | Vector DB | High | - Great filtering<br>- High performance<br>- Docker ready | - Separate service | MEDIUM |
| **Weaviate** | Vector + Graph | High | - Built-in graph<br>- Modular | - Complex setup<br>- Heavy | LOW (overkill) |

### 1.2 Detailed Analysis

#### **LanceDB** (Top Pick for Production)

**Why it's compelling:**
```typescript
// Zero-config, embedded, TypeScript-native
import * as lancedb from '@lancedb/lancedb';

const db = await lancedb.connect('~/.clawdbot/vectors');
const table = await db.createTable('chunks', [{
  id: 'chunk-1',
  vector: await embed(chunk.text),
  text: chunk.text,
  metadata: { path: chunk.path, line: chunk.line }
}]
);

const results = await table.search(queryEmbedding)
  .where('path = "src/*.ts"')
  .limit(10)
  .toArray();
```

**Integration Benefits:**
- **Replaces:** Custom sqlite-vec integration
- **Adds:** Automatic indexing, filtering, S3/cloud storage
- **Performance:** IVF-PQ indexing for 100M+ vectors at sub-10ms
- **Storage:** Copy-on-write, versioned, no data corruption risk
- **Migration:** Export LanceDB to S3 for production, local files for dev

**Cost:**
- Open source (Apache 2.0)
- Cloud managed: $0.10/GB/month (optional)

**When to use:**
- Production with >100K embeddings
- Need persistent cloud storage
- Want advanced filtering (scalar + vector)

**When NOT to use:**
- Simple SQLite-only deployment (use sqlite-vec instead)

#### **sqlite-vec** (Top Pick for Simplicity)

**Why it's compelling:**
```sql
-- Works with existing SQLite, no new service
SELECT
  chunk.id,
  chunk.text,
  distance
FROM chunk_embeddings
WHERE v_id MATCH '[0.1, 0.2, ...]'
ORDER BY distance
LIMIT 10;
```

**Integration Benefits:**
- **Zero new infrastructure** - just a loadable extension
- **Same DB** - vectors live alongside chunks
- **Fast enough** - 50K vectors at ~10ms

**When to use:**
- Development and small-medium deployments (<100K embeddings)
- Want single-file database simplicity
- Existing SQLite investment

#### **ChromaDB** (Alternative for Easy Scaling)

```typescript
import { ChromaClient } from 'chromadb';

const client = new ChromaClient();
await client.addDocuments({
  ids: ['chunk-1'],
  embeddings: [embedding],
  documents: [text],
  metadata: [{ path: 'src/index.ts' }]
});

const results = await client.query({
  queryEmbeddings: [queryEmbed],
  nResults: 10
});
```

**When to use:**
- Want drop-in vector DB
- OK with separate Docker service
- Need multi-user concurrency

### 1.3 Recommendation

**Hybrid Approach:**

```typescript
// src/datastore/embedding-store.ts
interface EmbeddingStore {
  search(embedding: number[], limit: number): Promise<SearchResult[]>;
  add(id: string, embedding: number[]): Promise<void>;
}

class SQLiteEmbeddingStore implements EmbeddingStore {
  // Uses sqlite-vec for embedded, zero-config
  private db: RelationalDatastore;
}

class LanceDBEmbeddingStore implements EmbeddingStore {
  // Uses LanceDB for production scale
  private db: LanceConnection;
}

// Factory selects based on config
const store = config.vectorStore.type === 'lancedb'
  ? new LanceDBEmbeddingStore()
  : new SQLiteEmbeddingStore();
```

**Migration Path:**
1. Start with sqlite-vec (zero new deps)
2. Switch to LanceDB when hitting scale limits
3. Same interface, zero code changes

---

## Part 2: Knowledge Graph Extraction

### 2.1 Options Analysis

| Tool | Type | Pros | Cons | Recommendation |
|------|------|------|------|----------------|
| **LightRAG** | Library | - Delimiter-based (our design)<br>- Proven results<br>- Python | - Need to call from Node.js | **HIGH** |
| **LlamaIndex** | Framework | - KnowledgeGraphIndex<br>- Mature<br>- Great docs | - Heavy framework<br>- Python-first | **HIGH** |
| **LangChain** | Framework | - Graph stores<br>- Integrations | - Heavy abstraction | MEDIUM |
| **Microsoft GraphRAG** | Research | - State-of-the-art<br>- Open source | - Python only<br>- Complex setup | LOW |
| **GraphRAG-AC** | Library | - TypeScript native | - Less mature | MEDIUM |

### 2.2 Detailed Analysis

#### **LightRAG** (Top Pick for Extraction Logic)

**What it provides:**
```python
from lightrag import LightRAG, QueryParam

rag = LightRAG(
    working_dir="./dickens",
    llm_model_func=llm_model_func,
    embed_func=embedding_func
)

# Insert document
await rag.ainsert("document text here...")

# Query with graph
result = await rag.aquery(
    "How did Scrooge change?",
    param=QueryParam(mode="hybrid")
)
```

**Why it matches our design:**
- Uses **delimiter-based extraction** (same as ZAI-DESIGN.md)
- Implements **gleaning loop** (we call it "refinement")
- Has **3-tier consolidation** built-in
- Proven in production

**Integration Strategy:**
```typescript
// src/knowledge/extraction/lightrag-wrapper.ts
class LightRAGExtractor {
  private pythonProcess: ChildProcess;

  async extract(text: string): Promise<ExtractionResult> {
    // Call Python LightRAG service
    const result = await this.pythonProcess.send({
      action: 'extract',
      text,
      config: {
        entity_types: ['person', 'org', 'concept'],
        delimiter: '("|")',  // Our format
      }
    });

    return {
      entities: result.entities,
      relationships: result.relationships,
    };
  }
}
```

**Cost:**
- Open source (MIT)
- LLM costs: $0.50 per 100K tokens (GPT-4o-mini)

#### **LlamaIndex KnowledgeGraphIndex** (Alternative)

```python
from llama_index.core import KnowledgeGraphIndex, Document
from llama_index.graph_stores import NebulaGraphStore

# Build graph from documents
index = KnowledgeGraphIndex.from_documents(
    documents,
    llm=llm,
    embed_model=embed_model,
    store_graph=True
)

# Query with graph traversal
query_engine = index.as_query_engine(
    include_text=True,
    retrieval_mode="keyword",
    graph_mode="relational"
)
```

**When to use:**
- Want full-featured RAG framework
- OK with Python service
- Need advanced query modes

### 2.3 Recommendation

**Option A: Pure Node.js (Our Design)**
- Implement extraction ourselves
- Use delimiter format from LightRAG
- Full control, lightweight

**Option B: LightRAG Integration**
- Extract entities in Python (LightRAG)
- Store in our datastore
- Best of both: proven extraction + our storage

**Recommendation:**
- **MVP:** Build ourselves (ZAI-DESIGN.md design)
- **V2:** Integrate LightRAG for extraction quality

---

## Part 3: Document Processing & Parsing

### 3.1 Options Analysis

| Tool | Type | Pros | Cons | Recommendation |
|------|------|------|------|----------------|
| **Unstructured.io** | Service | - 60+ file formats<br>- Great API<br>- Open source | - Separate service (usually)<br>- Rate limits on free tier | **HIGH** |
| **Marker** | Library | - PDF→Markdown<br>- Fast<br>- Local | - PDFs only | **HIGH** |
| **LlamaParse** | Service | - Great accuracy<br>- Complex layouts | - Paid service<br>- Rate limits | MEDIUM |
| **pdfplumber** | Library | - Great tables<br>- Python | - Python only | MEDIUM |
| **Muti** | Library | - OCR included<br>- Local | - Newer project | MEDIUM |

### 3.2 Detailed Analysis

#### **Unstructured.io** (Top Pick for General Documents)

```python
from unstructured.partition.auto import partition

# Auto-detects file type
elements = partition(filename="document.pdf")

# Clean output
for element in elements:
    print(f"{element.category}: {element.text}")
```

**Supports:**
- PDF, DOCX, PPTX, HTML, TXT, Markdown
- Tables, images, headers
- 60+ formats total

**Integration:**
```typescript
// Docker service for document parsing
class DocumentParser {
  async parse(file: File): Promise<ParsedDocument> {
    const formData = new FormData();
    formData.append('files', file);

    const response = await fetch('http://localhost:8000/general/v0/general', {
      method: 'POST',
      body: formData,
    });

    const elements = await response.json();

    return {
      text: this.extractText(elements),
      tables: this.extractTables(elements),
      metadata: this.extractMetadata(elements),
    };
  }
}
```

**Deployment:**
```yaml
# docker-compose.yml
services:
  unstructured:
    image: downloads.unstructured.io/unstructured-io/unstructured:latest
    ports:
      - "8000:8080"
    environment:
      - UNSTRUCTURED_PARALLEL_MODE_THREADS=4
```

**Cost:**
- Free tier: 100 requests/month
- Paid: $0.001 per page

#### **Marker** (Top Pick for PDFs)

```bash
# Converts PDF to Markdown with tables, images
marker document.pdf
# Output: document.md
```

**Why it's great:**
- Faster than OCR-only tools
- Preserves tables as Markdown
- Extracts images
- 100% local, no API calls

**Integration:**
```typescript
import { exec } from 'child_process';

async function parsePDF(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`marker "${filePath}" -o -`, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
```

**Cost:**
- Open source (GPL-3.0)
- Free to use

### 3.3 Recommendation

**Hybrid Approach:**

```typescript
// src/knowledge/parsing/document-parser.ts
class DocumentParser {
  async parse(file: File): Promise<ParsedDocument> {
    const ext = path.extname(file.name);

    // PDFs: Use Marker (fast, local)
    if (ext === '.pdf') {
      return await this.parseWithMarker(file);
    }

    // Everything else: Use Unstructured
    return await this.parseWithUnstructured(file);
  }

  private async parseWithMarker(file: File): Promise<ParsedDocument> {
    const marker = new MarkerParser();
    return await marker.convert(file);
  }

  private async parseWithUnstructured(file: File): Promise<ParsedDocument> {
    const client = new UnstructuredClient();
    return await client.parse(file);
  }
}
```

**Migration Path:**
1. **MVP:** Simple Markdown-only (existing)
2. **V2:** Add Marker for PDFs
3. **V3:** Add Unstructured for everything else

---

## Part 4: Graph Databases (Optional)

### 4.1 Options Analysis

| Tool | Type | Pros | Cons | Recommendation |
|------|------|------|------|----------------|
| **SQLite + Recursive CTEs** | Built-in | - Zero new deps<br>- Sufficient for <50K entities | - Limited to 3-hop queries | **Start Here** |
| **Neo4j** | Graph DB | - Mature<br>- Cypher query language<br>- Great algorithms | - Separate service<br>- Heavy | Scale later |
| **FalkorDB** | Redis Graph | - Fast<br>- Redis-based | - Redis dependency | Scale later |
| **Weaviate** | Vector + Graph | - Combined | - Complex | MEDIUM |

### 4.2 Recommendation

**SQLite First, Neo4j Later**

```typescript
// Start with SQLite (ZAI-DESIGN.md)
class GraphRepository {
  constructor(private store: RelationalDatastore) {}

  // Uses recursive CTEs - works in SQLite AND PostgreSQL
  async getNeighborhood(entityId: string, hops: number) {
    return this.store.query(`
      WITH RECURSIVE neighborhood AS (...)
      SELECT * FROM neighborhood WHERE depth <= ?
    `, [hops]);
  }
}

// When scale requires, switch to Neo4j
class Neo4jGraphRepository {
  constructor(private driver: neo4j.Driver) {}

  async getNeighborhood(entityId: string, hops: number) {
    const session = this.driver.session();
    const result = await session.run(`
      MATCH path = (e:Entity {id: $id})-[*1..${hops}]-(related)
      RETURN related
    `, { id: entityId });
    return result.records;
  }
}
```

**When to switch to Neo4j:**
- >100K entities
- Need >3-hop queries frequently
- Need advanced algorithms (PageRank, community detection)

---

## Part 5: Reranking & Relevance

### 5.1 Options Analysis

| Tool | Type | Pros | Cons | Recommendation |
|------|------|------|------|----------------|
| **Cohere Rerank** | API | - Best quality<br>- Simple API<br>- Fast | - Paid<br>- Rate limits | **HIGH** |
| **sentence-transformers** | Library | - Local<br>- Free<br>- Great models | - Python | **HIGH** |
| **Jina Reranker** | API | - Fast<br>- Good quality | - Newer | MEDIUM |
| **Colbert** | Library | - State-of-the-art | - Complex setup | LOW (overkill) |

### 5.2 Detailed Analysis

#### **Cohere Rerank** (Top Pick for Quality)

```typescript
import { CohereRerankClient } from 'cohere-ai';

const cohere = new CohereRerankClient(process.env.COHERE_API_KEY);

const results = await cohere.rerank({
  documents: searchResults,
  query: userQuery,
  topN: 10,
  model: 'rerank-v3.5',
});

// Results re-ordered by relevance
```

**Performance:**
- ~100ms for 100 documents
- Improves precision@10 by 20-30%

**Cost:**
- $2 per 1,000 searches (100 docs each)

#### **sentence-transformers** (Top Pick for Free)

```python
from sentence_transformers import CrossEncoder

model = CrossEncoder('cross-encoder/ms-marco-MiniLM-L-6-v2')
scores = model.predict([
  ['What is Clawdbot?', 'Clawdbot is a CLI tool...'],
  ['What is Clawdbot?', 'The weather is nice today...'],
])

# Returns: [0.95, 0.02]
```

**Integration:**
```typescript
// Python microservice for reranking
class RerankingService {
  async rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    const response = await fetch('http://localhost:8001/rerank', {
      method: 'POST',
      body: JSON.stringify({ query, results }),
      headers: { 'Content-Type': 'application/json' },
    });

    const reranked = await response.json();
    return reranked.results;
  }
}
```

### 5.3 Recommendation

**Start Free, Add Paid Later**

```typescript
// src/memory/reranking.ts
interface Reranker {
  rerank(query: string, results: SearchResult[]): Promise<SearchResult[]>;
}

class NoOpReranker implements Reranker {
  async rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    return results; // No reranking
  }
}

class LocalReranker implements Reranker {
  // Uses sentence-transformers via Python
  async rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    return this.pythonService.rerank(query, results);
  }
}

class CohereReranker implements Reranker {
  // Uses Cohere API
  async rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    return this.cohere.rerank(query, results);
  }
}

// Config-driven selection
const reranker = config.reranking.type === 'cohere'
  ? new CohereReranker()
  : config.reranking.type === 'local'
  ? new LocalReranker()
  : new NoOpReranker();
```

---

## Part 6: Web Crawling

### 6.1 Options Analysis

| Tool | Type | Pros | Cons | Recommendation |
|------|------|------|------|----------------|
| **Playwright** | Library | - Already in deps<br>- JS rendering<br>- Great API | - We build orchestration | **Build** |
| **Scrapy** | Framework | - Mature<br>- Great pipeline | - Python<br>- Overkill for our needs | LOW |
| **Apify** | Service | - Ready-made crawlers<br>- Proxy rotation | - Paid service<br>- Less control | LOW |
| **Colly** | Library | - Fast<br>- Go | - Not Node.js | LOW |

### 6.2 Recommendation

**Build with Playwright**

**Why:**
- Already in dependencies
- Node.js native
- Sufficient for our needs (we're not a scraping company)
- Control over robots.txt, rate limiting

**What we build:**
1. Crawler orchestrator (ZAI-DESIGN.md)
2. Rate limiting
3. Robots.txt handling
4. Progress tracking

**What we DON'T build:**
- JS rendering (Playwright handles it)
- HTML parsing (turndown, jsdom handle it)

---

## Part 7: Full-Text Search

### 7.1 Options Analysis

| Tool | Type | Pros | Cons | Recommendation |
|------|------|------|------|----------------|
| **FTS5 (SQLite)** | Built-in | - Zero deps<br>- Fast enough | - SQLite only | **Start Here** |
| **GIN (PostgreSQL)** | Built-in | - Great performance<br>- Scalable | - PostgreSQL required | **Scale To** |
| **Meilisearch** | Service | - Great UX<br>- Fast | - Separate service | MEDIUM |
| **Typesense** | Service | - Instant search<br>- Tolerant search | - Separate service | MEDIUM |

### 7.2 Recommendation

**Start Built-in, Consider Service Later**

```typescript
// Use database-native FTS
class FullTextSearch {
  constructor(private datastore: RelationalDatastore) {}

  async search(query: string, limit: number): Promise<SearchResult[]> {
    if (this.datastore.fullTextSearch) {
      // SQLite FTS5 or PostgreSQL GIN
      return this.datastore.fullTextSearch('chunks', ['content'], query, limit);
    }

    // Fallback to LIKE
    return this.datastore.query(`
      SELECT * FROM chunks
      WHERE content LIKE ?
      LIMIT ?
    `, [`%${query}%`, limit]);
  }
}
```

**When to add Meilisearch/Typesense:**
- Need typo tolerance
- Need faceted search
- Need search analytics

---

## Part 8: Summary Integration Matrix

### 8.1 Build vs. Buy Decision Matrix

| Subsystem | Build | Integrate | Tool | Effort |
|-----------|-------|-----------|------|--------|
| **Vector Search** | ❌ | ✅ | LanceDB or sqlite-vec | Low |
| **Entity Extraction** | ✅ | ⚠️ | LightRAG (optional V2) | Medium |
| **Document Parsing** | ❌ | ✅ | Marker + Unstructured | Low |
| **Graph Storage** | ✅ | ⚠️ | SQLite first, Neo4j later | Medium |
| **Reranking** | ❌ | ✅ | sentence-transformers | Low |
| **Crawler** | ✅ | ❌ | Playwright (already in deps) | Medium |
| **Full-Text Search** | ✅ | ⚠️ | Database-native first | Low |
| **Datastore Abstraction** | ✅ | ❌ | Custom (ZAI-DATASTORE.md) | High |

### 8.2 Recommended Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Clawdbot                               │
└─────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   Build         │  │   Integrate     │  │   Build         │
│                 │  │                 │  │                 │
│ • Datastore     │  │ • LanceDB       │  │ • Crawler       │
│   Interface     │  │ • Marker        │  │   (Playwright)  │
│ • Graph Queries │  │ • Unstructured  │  │ • CLI           │
│ • Extraction    │  │ • LightRAG (V2) │  │ • Agent Tools   │
│   Pipeline      │  │ • sentence-     │  │                 │
│ • Migrations    │  │   transformers  │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

### 8.3 Updated Migration Path

**Phase 1: Foundation (Week 1)**
- Build datastore interface (ZAI-DATASTORE.md)
- Set up SQLite + sqlite-vec
- Build extraction pipeline
- **Integration:** Add Marker for PDFs

**Phase 2: Production Scale (Week 2)**
- Integrate LanceDB (optional)
- Integrate sentence-transformers reranker
- Add Unstructured for broader format support

**Phase 3: Advanced Features (Week 3)**
- Consider LightRAG integration for better extraction
- Add Meilisearch if FTS insufficient
- Consider Neo4j if graph queries slow

---

## Part 9: Cost Analysis

### 9.1 Tool Costs (Monthly)

| Tool | Free Tier | Paid Tier | Recommendation |
|------|-----------|-----------|----------------|
| **LanceDB** | Unlimited (local) | $0.10/GB (cloud) | Start local, cloud later |
| **sqlite-vec** | Free | N/A | Always free |
| **Marker** | Free | N/A | Always free |
| **Unstructured** | 100 req/month | $0.001/page | Free tier sufficient |
| **sentence-transformers** | Free | N/A | Always free |
| **Cohere Rerank** | 1,000 req/month | $2/1,000 searches | Free tier sufficient |
| **LightRAG** | Free | N/A | Always free (you pay LLM) |
| **Neo4j** | Free (desktop) | $7/mo+ | Start free |

**Total for MVP:** $0/month (all free)

**Total at Scale:** ~$20-50/month (Cohere + LanceDB cloud + optional)

### 9.2 Development Effort

| Subsystem | From Scratch | With Integration | Savings |
|-----------|--------------|------------------|---------|
| Vector Search | 2 weeks | 2 days | 80% |
| Doc Parsing | 1 week | 1 day | 85% |
| Reranking | 3 days | 1 day | 66% |
| Extraction | 1 week | 1 week (build) + 2 days (integrate V2) | 30% (long-term) |
| **Total** | **5 weeks** | **2 weeks** | **60%** |

---

## Part 10: Recommended Integration Priority

### Must-Have (Phase 1)

1. **sqlite-vec** - Zero-config vector search
2. **Marker** - Fast, local PDF parsing
3. **sentence-transformers** - Free reranking

### Nice-to-Have (Phase 2)

4. **LanceDB** - When sqlite-vec limits hit
5. **Unstructured** - For non-PDF documents
6. **LightRAG** - If extraction quality insufficient

### Optional (Phase 3+)

7. **Cohere Rerank** - If willing to pay for quality
8. **Meilisearch** - If need advanced search features
9. **Neo4j** - If graph queries bottleneck

---

## Part 11: Updated Design Documents

### Changes to ZAI-DESIGN.md

1. **Replace custom vector storage with LanceDB/sqlite-vec**
   - Section 5: Use LanceDB interface
   - Remove custom embedding cache design

2. **Add Marker/Unstructured integration**
   - Section 3: Document processing uses these tools
   - Update crawler design

3. **Add reranking layer**
   - New section: Reranking service
   - Integrate between search and LLM

### Changes to ZAI-PLAN.md

1. **Phase 2: Reduced effort** (1 week → 3 days)
   - Integration vs. build

2. **New Phase: Tool Integration**
   - Set up external services
   - Docker compose for services

### Changes to ZAI-AGENTS.md

1. **Reduced agent work**
   - Less custom code to write
   - Focus on integration glue

2. **New integration tasks**
   - Docker service setup
   - API client implementations

---

## Conclusion

**Key Recommendation:** Integrate mature tools for commodity problems, build for project-specific needs.

**Build:**
- Datastore abstraction (project-specific)
- Crawler orchestration (Node.js ecosystem)
- Extraction pipeline (initially, integrate LightRAG later)
- Graph queries (SQLite recursive CTEs)

**Integrate:**
- **sqlite-vec** or **LanceDB** for vector search
- **Marker** for PDFs
- **Unstructured** for other documents
- **sentence-transformers** for reranking
- **LightRAG** (V2) for better extraction

**Result:** 60% faster development, production-ready tools, focus on Clawdbot-specific value.

---

## Next Steps

1. Update ZAI-DESIGN.md with integration points
2. Create Docker compose for services (Unstructured, reranker)
3. Add tool configuration to config schema
4. Update migration path with integration phases
5. Document API contracts for each integrated tool
