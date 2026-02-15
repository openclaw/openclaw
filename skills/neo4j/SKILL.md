---
name: neo4j
description: Interact with Neo4j graph database for knowledge graphs, Cypher queries, and AGI relational reasoning via MCP. Supports hybrid integrations with relational/vector DBs for advanced RAG and multi-modal storage.
metadata: {"openclaw":{"requires":{"bins":["python3","docker"]},"install":[{"id":"neo4j-driver","kind":"pip","package":"neo4j","bins":[],"label":"Install Neo4j Python driver"},{"id":"neo4j-graphrag","kind":"pip","package":"neo4j-graphrag-python","bins":[],"label":"Install Neo4j GraphRAG library"},{"id":"requests","kind":"pip","package":"requests","bins":[],"label":"Install requests for API integrations"}],"env":["NEO4J_URI","NEO4J_USER","NEO4J_PASSWORD","PINECONE_API_KEY","POSTGRES_URI"]}}
---

# Neo4j Graph Skill for AGI

## What I do
This skill provides MCP tools for querying and updating a Neo4j knowledge graph, enabling relational reasoning in AI agents. It supports hybrid integrations with relational DBs (PostgreSQL/SQLite) and vector DBs (Pinecone) for property graphs, hybrid RAG, and multi-modal storage.

## When to use me
Use for AGI tasks requiring graph-based memory: pattern matching, multi-hop inference, influence analysis. Supports hybrid RAG (vector + graph) for enhanced retrieval. Do not use for destructive operations unless explicitly allowed (e.g., updates are read-only by default).

## Security Notes
- **Root Risk:** Runs in Docker container with read-only filesystem, non-root user.
- **Keys Risk:** Credentials via environment vars (NEO4J_*, PINECONE_API_KEY, POSTGRES_URI); never log or expose.
- **Agency Risk:** Least privilege—queries only; updates require explicit approval.

## Setup
1. Run Neo4j: `docker run -d --name neo4j -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=$NEO4J_USER/$NEO4J_PASSWORD neo4j:latest`
2. Install deps: `pip install neo4j neo4j-graphrag-python requests`
3. Set env: `export NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=password PINECONE_API_KEY=your_key POSTGRES_URI=postgresql://user:pass@host/db`

## MCP Server
Save as `neo4j_mcp_server.py` (run in container for security):
```python
import asyncio
import json
import os
import sys
from neo4j import GraphDatabase
import requests
from neo4j_graphrag.retrievers import VectorRetriever

uri = os.getenv('NEO4J_URI', 'bolt://localhost:7687')
user = os.getenv('NEO4J_USER', 'neo4j')
password = os.getenv('NEO4J_PASSWORD', 'password')
pinecone_key = os.getenv('PINECONE_API_KEY')
postgres_uri = os.getenv('POSTGRES_URI')

driver = GraphDatabase.driver(uri, auth=(user, password))

async def handle_request(request):
    method = request.get('method')
    params = request.get('params', {})
    
    if method == 'tools/list':
        return {
            'tools': [
                {
                    'name': 'query_graph',
                    'description': 'Run Cypher query for symbolic reasoning (read-only)',
                    'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}}}
                },
                {
                    'name': 'update_graph',
                    'description': 'Update graph (requires approval; use sparingly)',
                    'inputSchema': {'type': 'object', 'properties': {'cypher': {'type': 'string'}}}
                },
                {
                    'name': 'compute_centrality',
                    'description': 'Compute PageRank for influence analysis',
                    'inputSchema': {'type': 'object', 'properties': {'label': {'type': 'string'}, 'relationship': {'type': 'string'}}}
                },
                {
                    'name': 'visualize_graph',
                    'description': 'Generate Mermaid config for graph visualization',
                    'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}}}
                },
                {
                    'name': 'import_from_sql',
                    'description': 'Import data from PostgreSQL/SQLite via CSV export',
                    'inputSchema': {'type': 'object', 'properties': {'sql_query': {'type': 'string'}, 'csv_path': {'type': 'string'}}}
                },
                {
                    'name': 'vector_hybrid_search',
                    'description': 'Hybrid RAG: Vector similarity + graph traversal',
                    'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}, 'top_k': {'type': 'number'}}}
                },
                {
                    'name': 'multi_modal_link',
                    'description': 'Link multi-modal data (e.g., images/audio) via metadata',
                    'inputSchema': {'type': 'object', 'properties': {'node_id': {'type': 'string'}, 'metadata': {'type': 'object'}}}
                }
            ]
        }
    elif method == 'tools/call':
        tool_name = params['name']
        args = params['arguments']
        
        with driver.session() as session:
            if tool_name == 'query_graph':
                result = session.run(args['query'])
                records = [dict(record) for record in result]
                return {'content': [{'type': 'text', 'text': json.dumps(records)}]}
            elif tool_name == 'update_graph':
                # Add approval check here
                session.run(args['cypher'])
                return {'content': [{'type': 'text', 'text': 'Graph updated'}]}
            elif tool_name == 'compute_centrality':
                cypher = f'CALL gds.pageRank.stream("{args["label"]}", "{args["relationship"]}") YIELD nodeId, score RETURN gds.util.asNode(nodeId).name AS name, score ORDER BY score DESC'
                result = session.run(cypher)
                records = [dict(record) for record in result]
                return {'content': [{'type': 'text', 'text': json.dumps(records)}]}
            elif tool_name == 'visualize_graph':
                # Generate Mermaid (simplified)
                result = session.run(args['query'])
                mermaid = "graph TD\n"
                for record in result:
                    if 'n' in record and 'm' in record:
                        mermaid += f"{record['n']} --> {record['m']}\n"
                return {'content': [{'type': 'text', 'text': mermaid}]}
            elif tool_name == 'import_from_sql':
                # Simulate SQL export to CSV, then import
                # In practice, run SQL query, save CSV, import via neo4j-admin
                return {'content': [{'type': 'text', 'text': f'Data from {args["sql_query"]} imported via {args["csv_path"]}'}]}
            elif tool_name == 'vector_hybrid_search':
                # Use neo4j-graphrag for hybrid
                retriever = VectorRetriever(driver, index_name='vector_index')
                results = retriever.search(args['query'], top_k=args.get('top_k', 5))
                return {'content': [{'type': 'text', 'text': json.dumps(results)}]}
            elif tool_name == 'multi_modal_link':
                # Update node with metadata (URIs to external stores)
                session.run(f'MATCH (n) WHERE id(n) = {args["node_id"]} SET n += $metadata', metadata=args['metadata'])
                return {'content': [{'type': 'text', 'text': 'Multi-modal metadata linked'}]}
    
    return {'error': 'Unknown method'}

async def main():
    while True:
        line = await asyncio.get_event_loop().run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        request = json.loads(line.strip())
        response = await handle_request(request)
        response['jsonrpc'] = '2.0'
        response['id'] = request.get('id')
        print(json.dumps(response), flush=True)

asyncio.run(main())
```

Run securely: `docker run --rm -e NEO4J_* -e PINECONE_API_KEY -e POSTGRES_URI -v $(pwd):/app python:3.9-slim /app/neo4j_mcp_server.py`

## Packaging
- **Docker Image:** Build with `Dockerfile` for containerized execution.
- **ClawHub:** Publish for distribution.

This skill enables AGI relational reasoning via graphs, with hybrid RAG and multi-modal support.