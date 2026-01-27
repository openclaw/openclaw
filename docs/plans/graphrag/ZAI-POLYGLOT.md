# Polyglot Architecture Analysis: Python Services for Clawdbrain

**Date:** 2026-01-26
**Based On:** Analysis of [Archon by coleam00](https://github.com/coleam00/Archon)
**Purpose:** Evaluate what Clawdbrain should move to Python and why

---

## Executive Summary

After analyzing Archon's microservices architecture, I recommend **selective adoption of Python services** for Clawdbrain, focused on **AI/ML-heavy workloads** where Python's ecosystem is superior. Not everything should move to Python—the key is identifying the right boundary.

**Key Recommendation:** Create a **hybrid Node.js + Python architecture** where:
- **Node.js** remains the orchestrator, CLI, and lightweight services
- **Python** handles AI/ML, graph algorithms, and data processing
- **HTTP-based IPC** maintains clean separation

---

## Part 1: Archon's Architecture Analysis

### What Archon Did Well

Archon separates concerns into distinct Python microservices:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend UI   │    │  Server (API)   │    │   MCP Server    │
│                 │    │                 │    │                 │
│  React + Vite   │◄──►│    FastAPI +    │◄──►│    Lightweight  │
│  Port 3737      │    │    SocketIO     │    │    HTTP Wrapper │
└─────────────────┘    │    Port 8181    │    │    Port 8051    │
         │                └─────────────────┘    └─────────────────┘
         │                        │                        │
         └────────────────────────┼────────────────────────┘
                                  │
                         ┌─────────────────┐
                         │    Agents       │
                         │                 │
                         │   PydanticAI    │
                         │   Port 8052     │
                         └─────────────────┘
```

### Service Responsibilities

| Service | Language | Purpose | Key Dependencies |
|---------|----------|---------|------------------|
| **archon-server** | Python | Core API, crawling, ML/AI operations | FastAPI, crawl4ai, OpenAI, Supabase, PyPDF2 |
| **archon-mcp** | Python | MCP protocol interface, lightweight | FastAPI, MCP SDK, HTTP client |
| **archon-agents** | Python | PydanticAI agent hosting (RAG, Document) | PydanticAI, FastAPI |
| **archon-ui** | TypeScript | React frontend, user interface | React, Vite, TailwindCSS |

### Why Python for AI/ML?

**Library Ecosystem Gap:**

| Domain | Python | Node.js | Winner |
|--------|--------|---------|--------|
| **LLM Frameworks** | LangChain, PydanticAI, LlamaIndex | LangChain.js (port), Vercel AI SDK | **Python** |
| **Vector DB Clients** | All official clients first | Limited support, ports lag | **Python** |
| **Web Crawling** | crawl4ai, Scrapy, Playwright | Playwright (Node-native), Puppeteer | **Tie** |
| **Document Parsing** | PyPDF2, pdfplumber, python-docx | pdf-parse, mammoth (good) | **Tie** |
| **Graph Algorithms** | NetworkX, graphology, igraph | graphology (port available) | **Python** |
| **Embedding Models** | sentence-transformers, transformers | None (requires API) | **Python** |
| **Machine Learning** | scikit-learn, PyTorch, TensorFlow | TensorFlow.js (limited) | **Python** |
| **Reranking** | sentence-transformers, colbert | None | **Python** |
| **Data Processing** | pandas, numpy, polars | Danfo.js (limited) | **Python** |

**Key Insight:** Python wins on **library maturity**, **feature completeness**, and **community support** for AI/ML workloads.

---

## Part 2: What Should Move to Python for Clawdbrain

### HIGH PRIORITY: Clear Python Wins

#### 1. Entity Extraction Pipeline (GraphRAG)

**Current Plan (Node.js):**
- LLM calls via existing provider abstraction
- Delimiter-based parsing
- Consolidation algorithm

**Why Python is Better:**
- **LangChain/LLamaIndex integration** - Pre-built extraction templates
- **Structured output** - Better JSON schema validation
- **Batch processing** - asyncio + concurrent futures
- **Extraction quality** - More proven patterns for NER + relation extraction

**Python Implementation:**
```python
# src/python/extraction/extraction_service.py
from langchain.extractors import EntityExtractor
from langchain_experimental.graph_transformers import LLMGraphTransformer
from sentence_transformers import SentenceTransformer

class ExtractionService:
    async def extract_from_chunks(self, chunks: List[str]) -> GraphResult:
        # LangChain has optimized extractors
        extractor = EntityExtractor(llm=self.llm)
        entities = await extractor.aextract_entities(chunks)

        # LlamaIndex has better relation extraction
        transformer = LLMGraphTransformer(llm=self.llm)
        relationships = await transformer.aextract_relations(chunks)

        # Consolidate with proven algorithms
        return await self.consolidate(entities, relationships)
```

**Interface:**
```typescript
// Node.js wrapper calls Python service
const extractionResult = await pythonService.extract({
    chunks: processedChunks,
    config: extractionConfig
});
```

---

#### 2. Graph Algorithms & Community Detection

**Current Plan (Node.js with graphology):**
- BFS, DFS, shortest path
- Basic centrality measures
- No community detection

**Why Python is Better:**
- **NetworkX** - Comprehensive graph algorithms
- **igraph** - Performance-optimized (10x faster than Node.js)
- **python-louvain** - Community detection (missing in Node.js)
- **graph-tool** - 100K+ nodes at scale

**Python Implementation:**
```python
# src/python/graph/graph_service.py
import networkx as nx
import igraph as ig
from community import community_louvain

class GraphAlgorithmsService:
    async def detect_communities(self, graph: GraphSnapshot) -> List[List[str]]:
        """Detect communities using Louvain algorithm."""
        nx_graph = self.to_networkx(graph)
        partition = community_louvain.best_partition(nx_graph)

        # Group by community ID
        communities = {}
        for node, comm_id in partition.items():
            communities.setdefault(comm_id, []).append(node)

        return list(communities.values())

    async def calculate_pagerank(self, graph: GraphSnapshot, damping: float = 0.85):
        """Calculate PageRank centrality."""
        nx_graph = self.to_networkx(graph)
        return nx.pagerank(nx_graph, alpha=damping)

    async def find_shortest_path_multiple_targets(
        self, source: str, targets: List[str]
    ) -> Dict[str, List[str]]:
        """Find shortest paths to multiple targets efficiently."""
        nx_graph = self.to_networkx(graph)
        paths = {}
        for target in targets:
            try:
                paths[target] = nx.shortest_path(nx_graph, source, target)
            except nx.NetworkXNoPath:
                continue
        return paths
```

**Interface:**
```typescript
// Node.js delegates complex graph queries to Python
const communities = await pythonGraphService.detectCommunities({
    entityIds: relevantEntityIds
});
```

---

#### 3. Reranking & Cross-Encoders

**Current Plan (Node.js):**
- Basic scoring, no reranking
- Missing cross-encoder for quality improvement

**Why Python is Better:**
- **sentence-transformers** - Multiple cross-encoder models
- **colbert** - Late interaction reranking (SOTA)
- **Cohere Rerank** - API-wrapper but Python has better integration
- **monot5** - Top-quality reranker

**Python Implementation:**
```python
# src/python/reranking/reranking_service.py
from sentence_transformers import CrossEncoder
from typing import List

class RerankingService:
    def __init__(self, model: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"):
        self.model = CrossEncoder(model, max_length=512)

    async def rerank_results(
        self, query: str, results: List[SearchResult], top_k: int = 10
    ) -> List[SearchResult]:
        """Rerank search results using cross-encoder."""
        if not results:
            return []

        # Prepare query-document pairs
        pairs = [[query, result.content] for result in results]

        # Score all pairs at once (batch processing)
        scores = self.model.predict(pairs)

        # Sort by score and return top-k
        reranked = sorted(
            zip(results, scores),
            key=lambda x: x[1],
            reverse=True
        )[:top_k]

        return [result for result, score in reranked]
```

**Interface:**
```typescript
// Node.js calls Python for reranking after initial search
const reranked = await pythonService.rerank({
    query: userQuery,
    results: initialResults,
    topK: 10
});
```

---

#### 4. Advanced Document Processing

**Current Plan (Node.js):**
- pdf-parse, mammoth (good, but limited)
- Basic chunking

**Why Python is Better:**
- **Unstructured** - Advanced layout detection, table extraction
- **LayoutParser** - Document structure understanding
- **Nougat** - Table extraction (SOTA for PDF tables)
- **Marker** - Convert PDF to markdown with high accuracy
- **LangChain document loaders** - Pre-built for many formats

**Python Implementation:**
```python
# src/python/processing/document_service.py
from unstructured.partition.pdf import partition_pdf
from unstructured.staging import base
from langchain_community.document_loaders import (
    PyPDFLoader, UnstructuredMarkdownLoader, DirectoryLoader
)

class AdvancedDocumentService:
    async def process_pdf_advanced(self, pdf_bytes: bytes) -> ProcessedDocument:
        """Process PDF with layout-aware extraction."""
        # Partition by element type
        elements = partition_pdf(
            file=pdf_bytes,
            partition_by_api=True,
            extract_images_in_pdf=True,
            infer_table_structure=True,
        )

        # Clean and chunk semantically
        chunks = []
        for element in elements:
            if element.category == "Table":
                # Extract table with structure
                chunks.append(self.extract_table(element))
            elif element.category == "NarrativeText":
                chunks.append(element.text)
            # Skip headers, footers

        return ProcessedDocument(chunks=chunks, metadata=elements.metadata)

    async def extract_code_from_docs(self, url: str) -> List[CodeBlock]:
        """Extract code examples from documentation."""
        from langchain.document_loaders import WebBaseLoader

        loader = WebBaseLoader(url)
        docs = await loader.aload()

        # Use code detection (tree-sitter based)
        code_blocks = []
        for doc in docs:
            code_blocks.extend(self.extract_code_blocks(doc.page_content))

        return code_blocks
```

---

### MEDIUM PRIORITY: Consider for Python

#### 5. Knowledge Graph Consolidation

**Current Plan (Node.js with graphology):**
- Consolidation algorithm
- Embedding-based fuzzy matching

**Why Python is Better:**
- **rapidfuzz** - Fuzzy string matching at scale
- **dedupe** - Record linkage and deduplication
- **polars** - Faster data processing than pandas
- **sentence-transformers** - Embedding computation

**Note:** This could stay in Node.js if graphology is sufficient, but Python has better deduplication libraries.

---

#### 6. Crawler Orchestration (Hybrid)

**Current Plan (Node.js):**
- Playwright already in Node.js
- HTTP fetching with rate limiting

**Why Hybrid is Better:**
- **Node.js**: Playwright crawling (native), HTTP fetching (fast)
- **Python**: Content processing, extraction, ML-based filtering
- **Split responsibility**: Node.js fetches, Python processes

**Hybrid Implementation:**
```typescript
// Node.js fetcher
class CrawlerOrchestrator {
    async crawl(url: string) {
        // Use Playwright (Node.js) for JS rendering
        const html = await this.playwright.fetch(url);

        // Send to Python for processing
        const extracted = await pythonService.processContent({
            html,
            url,
            extractEntities: true,
            extractCode: true
        });

        return extracted;
    }
}
```

---

### LOW PRIORITY: Keep in Node.js

#### 7. Gateway, CLI, Channel Interfaces

**Why Node.js Wins:**
- **Performance** - Faster I/O, lower memory footprint
- **Ecosystem** - Better WebSocket libraries, CLI frameworks
- **Existing codebase** - Clawdbrain already has mature Node.js services
- **Deployment** - Single binary, no Python runtime needed

#### 8. SQLite Operations

**Why Node.js is Fine:**
- **better-sqlite3** - Excellent async SQLite driver
- **sqlite-vec** - Vector operations in Node.js
- **No Python overhead** - Direct database access

#### 9. Agent Tool Registration

**Why Node.js is Fine:**
- Tools are simple JSON schemas
- TypeBox validation is already working
- No ML needed

---

## Part 3: Proposed Architecture for Clawdbrain

### Diagram: Hybrid Node.js + Python Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CLAWDBOT                                 │
│                    (TypeScript/Node.js)                            │
│                                                                     │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐          │
│  │   CLI &       │  │   Gateway     │  │   Channels    │          │
│  │   Commands    │  │   (Express)   │  │   (Telegram,  │          │
│  │               │  │               │  │   Discord...)  │          │
│  └───────┬───────┘  └───────┬───────┘  └───────┬───────┘          │
│          │                  │                  │                  │
│          ▼                  ▼                  ▼                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              Core Services (TypeScript/Node.js)           │  │
│  │  ┌────────────────┐  ┌──────────────┐  ┌──────────────┐     │  │
│  │  │  Config       │  │   Memory     │  │   Overseer   │     │  │
│  │  │  Manager      │  │   Manager    │  │   (Planning)  │     │  │
│  │  └────────────────┘  └──────────────┘  └──────────────┘     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│          │                  │                  │                  │
│          ▼                  ▼                  ▼                  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              Python Service (Optional)                      │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  FastAPI Server (Port 8888)                          │  │  │
│  │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐       │  │  │
│  │  │  │ Entity     │  │  Graph      │  │ Reranking  │       │  │  │
│  │  │  │ Extraction│  │  Algorithms│  │ Service    │       │  │  │
│  │  │  └────────────┘  └────────────┘  └────────────┘       │  │  │
│  │  │  ┌────────────┐  ┌────────────┐  ┌────────────┐       │  │  │
│  │  │  │ Advanced  │  │  Document  │  │ Community  │       │  │  │
│  │  │  │ NER/RE     │  │  Processing│  │ Detection  │       │  │  │
│  │  │  └────────────┘  └────────────┘  └────────────┘       │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Part 4: Python Service Specification

### Service Definition

**Package:** `@clawdbot/python-service` (optional extension)
**Port:** 8888 (configurable)
**Protocol:** HTTP (JSON) + gRPC (future)

### Dependencies

```toml
[project]
name = "clawdbot-python-service"
requires-python = ">=3.12"

dependencies = [
    # Web framework
    "fastapi>=0.104.0",
    "uvicorn>=0.24.0",
    "pydantic>=2.0.0",

    # AI/ML
    "langchain>=0.3.0",
    "langchain-experimental>=0.0.1",
    "openai>=1.71.0",
    "pydantic-ai>=0.0.13",

    # Graph algorithms
    "networkx>=3.0",
    "python-louvain>=0.16",
    "igraph>=0.11.0",

    # Reranking
    "sentence-transformers>=3.0.0",

    # Document processing
    "unstructured>=0.15.0",
    "pypdf2>=3.0.1",
    "pdfplumber>=0.11.6",
    "python-docx>=1.1.2",

    # Data processing
    "polars>=1.0.0",
    "rapidfuzz>=3.0.0",

    # HTTP client
    "httpx>=0.24.0",
]
```

### API Endpoints

```python
# src/python/main.py
from fastapi import FastAPI
app = FastAPI(title="Clawdbot Python AI Service")

@app.post("/v1/extraction/extract")
async def extract_entities(request: ExtractionRequest) -> ExtractionResult:
    """Extract entities and relationships from text chunks."""
    pass

@app.post("/v1/graph/communities")
async def detect_communities(request: CommunityDetectionRequest) -> CommunityResult:
    """Detect communities using Louvain algorithm."""
    pass

@app.post("/v1/graph/pagerank")
async def calculate_pagerank(request: PageRankRequest) -> PageRankResult:
    """Calculate PageRank centrality for all entities."""
    pass

@app.post("/v1/search/rerank")
async def rerank(request: RerankRequest) -> RerankResult:
    """Rerank search results using cross-encoder."""
    pass

@app.post("/v1/documents/process")
async def process_document(request: DocumentProcessRequest) -> ProcessedDocument:
    """Process PDF/docx with advanced extraction."""
    pass

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "python-ai"}
```

### Node.js Integration

```typescript
// src/python/python-client.ts
import { Injectable } from '@inversify';
import { HttpService } from './http-service.js';

export interface ExtractionRequest {
    chunks: string[];
    config: ExtractionConfig;
}

export interface ExtractionResult {
    entities: Entity[];
    relationships: Relationship[];
}

@Injectable()
export class PythonService {
    private baseUrl: string;

    constructor(private http: HttpService) {
        this.baseUrl = process.env.PYTHON_SERVICE_URL || 'http://localhost:8888';
    }

    async extractEntities(request: ExtractionRequest): Promise<ExtractionResult> {
        const response = await this.http.post<ExtractionResult>(
            `${this.baseUrl}/v1/extraction/extract`,
            request
        );
        return response;
    }

    async detectCommunities(entityIds: string[]): Promise<CommunityResult> {
        const response = await this.http.post<CommunityResult>(
            `${this.baseUrl}/v1/graph/communities`,
            { entityIds }
        );
        return response;
    }

    async rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
        const response = await this.http.post<SearchResult[]>(
            `${this.baseUrl}/v1/search/rerank`,
            { query, results, topK: 10 }
        );
        return response;
    }

    async isHealthy(): Promise<boolean> {
        try {
            await this.http.get(`${this.baseUrl}/health`);
            return true;
        } catch {
            return false;
        }
    }
}
```

---

## Part 5: Deployment Strategy

### Option 1: Docker Extension (Recommended)

**Similar to Archon's approach:**

```yaml
# docker-compose.yml (extension)
services:
  clawdbot-python:
    build:
      context: ./extensions/python-service
      dockerfile: Dockerfile
    container_name: clawdbot-python
    ports:
      - "8888:8888"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - LOG_LEVEL=${LOG_LEVEL:-INFO}
    networks:
      - clawdbot-network
    profiles:
      - python  # Only start with --profile python
```

**Usage:**
```bash
# Normal operation (no Python service)
docker compose up

# With Python service
docker compose --profile python up
```

### Option 2: Optional npm Install

```bash
# Users install Python service like an extension
clawdbot extensions install python-service

# Starts Python service automatically
```

### Option 3: Standalone Binary

For users who want zero Docker:
- Python service runs as separate process
- Managed by CLI (start/stop commands)
- Configuration via `~/.clawdbot/python-service.json`

---

## Part 6: Communication Patterns

### Synchronous HTTP (Simple)

**Good for:**
- Entity extraction (batch operation)
- Graph algorithms (query/response)
- Reranking (fast, blocking)

```typescript
// Node.js
const result = await pythonService.extractEntities({ chunks });
```

### Asynchronous Job Queue (Better for Long Tasks)

**Good for:**
- Large document processing
- Slow graph computations
- Batch extraction

```python
# Python - job queue processor
async def process_extraction_job(job: Job):
    result = await extract_entities(job.chunks)
    await callback_to_nodejs(job.job_id, result)
```

```typescript
// Node.js - job submission
const jobId = await pythonService.submitJob({
    type: 'extraction',
    chunks: largeDocumentChunks
});

// Poll for result
const result = await pythonService.getJobResult(jobId);
```

---

## Part 7: Trade-offs Analysis

### Why NOT to Move Everything to Python

| Concern | Explanation |
|---------|-------------|
| **Performance** | Node.js has faster I/O, lower memory, better concurrency for simple HTTP/gateway work |
| **Ecosystem** | Clawdbrain's existing channel providers, CLI, gateway are Node.js-native |
| **Deployment** | Python adds runtime dependency, larger containers |
| **Complexity** | Polyglot adds build, deployment, debugging overhead |
| **Team Skills** | TypeScript/Node.js skills transfer, Python is separate skillset |

### Why Python for Select Services

| Benefit | Explanation |
|---------|-------------|
| **AI/ML libraries** | Python has 2-5 year head start on AI/ML tooling |
| **Proven patterns** | LangChain, LlamaIndex have thousands of production deployments |
| **Graph algorithms** | NetworkX, igraph are industry standards |
| **Community** | Larger community for AI/ML, faster bug fixes |
| **R&D speed** | Faster prototyping of new AI techniques |

---

## Part 8: Migration Path

### Phase 1: PoC (Proof of Concept)

**Duration:** 1 week
**Goal:** Validate Python service value

1. Create minimal FastAPI service
2. Implement one endpoint (e.g., entity extraction)
3. Benchmark against Node.js implementation
4. Measure: accuracy, speed, cost

### Phase 2: Incremental Adoption (if PoC successful)

**Duration:** 2-3 weeks
**Goal:** Move high-value features to Python

1. **Entity extraction** → Python
2. **Reranking** → Python
3. **Graph algorithms** → Python (community detection, PageRank)

### Phase 3: Full Integration

**Duration:** 1-2 weeks
**Goal:** Seamless operation

1. Health checks and failover
2. Configuration management
3. Logging and observability
4. Documentation

---

## Part 9: Configuration

### Enable Python Service

```yaml
# config.yaml
agents:
  defaults:
    pythonService:
      enabled: true
      url: "http://localhost:8888"
      timeout: 30000  # 30 seconds
      features:
        entityExtraction: true
        graphAlgorithms: true
        reranking: true
        documentProcessing: false
```

### Feature Flags

```typescript
// Feature flags per operation
const extractionResult = config.pythonService.enabled
    ? await pythonService.extractEntities(chunks)
    : await nodeExtractionService.extractEntities(chunks);
```

---

## Part 10: Monitoring & Observability

### Health Checks

```typescript
// Node.js checks Python service health
if (!await pythonService.isHealthy()) {
    logger.warn('Python service unavailable, falling back to Node.js extraction');
    return await nodeExtractionService.extractEntities(chunks);
}
```

### Metrics

Track:
- Request latency (Node.js → Python)
- Error rates
- Fallback frequency
- Cost per operation

### Logging

- Structured logs with correlation IDs
- Distributed tracing (OpenTelemetry)
- Separate log streams for Node.js and Python

---

## Part 11: Cost-Benefit Analysis

### Upfront Costs

| Cost | Estimate |
|------|----------|
| **Development** | 2-4 weeks development time |
| **Infrastructure** | +200MB Docker image, ~100MB RAM overhead |
| **Maintenance** | +1 service to monitor, patch, update |
| **Complexity** | Polyglot debugging, deployment complexity |

### Ongoing Benefits

| Benefit | Estimate |
|---------|----------|
| **Extraction quality** | +10-20% accuracy (LangChain patterns) |
| **Graph features** | Community detection, PageRank (missing in Node.js) |
| **Reranking** | +15-30% retrieval quality (cross-encoders) |
| **Development speed** | Faster AI feature iteration (Python AI ecosystem) |
| **Community** | Access to cutting-edge AI/ML libraries first |

### Break-Even Analysis

**Python service makes sense if:**
1. You need advanced AI/ML features not available in Node.js
2. Team has Python skills or is willing to learn
3. Infrastructure can support additional service
4. Performance gains justify overhead

---

## Part 12: Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Python service unavailable** | Failover to Node.js implementations |
| **Latency overhead** | Batch operations, use async job queue |
| **Version skew** | Lock Python service version to Clawdbot releases |
| **Debugging complexity** | Structured logs, correlation IDs, distributed tracing |
| **Team skills gap** | Documentation, examples, training resources |

---

## Part 13: Recommended Decision Framework

### When to Use Python Service

✅ **Use Python for:**
- Entity extraction with LangChain/LlamaIndex patterns
- Graph algorithms (community detection, PageRank, centrality)
- Reranking with cross-encoders
- Advanced document processing (layout-aware parsing)
- ML model experimentation

❌ **Keep in Node.js:**
- Gateway, CLI, channel interfaces
- SQLite operations (already working well)
- Agent tool registration
- Simple HTTP APIs
- Real-time WebSocket connections

---

## Conclusion

**Recommendation:** Adopt a **hybrid architecture** with:

1. **Optional Python service** (Docker extension or npm install)
2. **HTTP-based IPC** (clean separation, language-agnostic)
3. **Graceful degradation** (fallback to Node.js if Python unavailable)
4. **Feature flags** (per-operation opt-in)
5. **Phase 1 PoC** (validate before committing)

**Key principle:** Move only what benefits from Python's ecosystem, not just because "AI = Python". Clawdbrain's Node.js foundation is solid—Python should extend, not replace, the core.

---

## Sources

- [Archon Repository](https://github.com/coleam00/Archon) - Microservices architecture reference
- [Archon Python Service](https://github.com/coleam00/Archon/tree/main/python) - Python implementation
- [PydanticAI](https://github.com/pydantic-ai/pydantic-ai) - Agent framework used by Archon
- [LangChain](https://github.com/langchain-ai/langchain) - AI/ML framework for extraction
- [NetworkX](https://networkx.org/) - Graph algorithms library
- [sentence-transformers](https://www.sbert.net/) - Reranking models
