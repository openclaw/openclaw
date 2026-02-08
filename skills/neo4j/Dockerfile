FROM python:3.9-slim

RUN pip install neo4j neo4j-graphrag-python requests

COPY neo4j_mcp_server.py /app/neo4j_mcp_server.py

WORKDIR /app

USER nobody

CMD ["python", "neo4j_mcp_server.py"]