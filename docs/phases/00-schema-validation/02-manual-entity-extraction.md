# Phase 0, Task 02: Manual Entity Extraction (Ground Truth)

**Phase:** 0 - Schema Validation & Ground Truth
**Task:** Create ground truth entity and relationship extraction
**Duration:** 1 day
**Complexity:** Medium

---

## Task Overview

Manually extract entities and relationships from the test corpus created in Task 01. This ground truth will be used to measure extraction quality (precision/recall) of the automated pipeline.

## Deliverables

1. File: `src/knowledge/extraction/gold-standard.json`
2. Format: Structured JSON matching the extraction schema

## Schema Definition

```typescript
interface GroundTruthExtraction {
  documentId: string;
  documentName: string;
  entities: Entity[];
  relationships: Relationship[];
}

interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description: string;
  aliases: string[];
  mentions: TextMention[];
}

interface EntityType {
  type: 'person' | 'org' | 'repo' | 'concept' | 'tool' |
        'location' | 'event' | 'goal' | 'task' | 'file' | 'custom';
  customType?: string;  // If type === 'custom'
}

interface TextMention {
  text: string;
  startIndex: number;
  endIndex: number;
  context: string;  // 50 chars before and after
}

interface Relationship {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  description: string;
  keywords: string[];
  strength: number;  // 1-10
  mentions: TextMention[];
}
```

## Extraction Guidelines

### Entity Extraction Rules

1. **Extract every meaningful entity** that matches the defined types
2. **Include aliases** when multiple forms are used
3. **Capture context** with text mentions (index positions)
4. **Write descriptions** based on document content only
5. **Mark custom types** if entity doesn't fit predefined categories

### Relationship Extraction Rules

1. **Extract explicit relationships** stated in the text
2. **Infer implicit relationships** when clear from context
3. **Assign strength** based on how central the relationship is:
   - 1-3: Tangential / mentioned in passing
   - 4-6: Direct relationship but not core
   - 7-10: Central / defining relationship
4. **Extract keywords** that indicate the relationship type

## Example: Ground Truth for auth-service-spec.pdf

```json
{
  "documentId": "auth-service-spec",
  "documentName": "auth-service-spec.pdf",
  "entities": [
    {
      "id": "entity_001",
      "name": "Auth Service",
      "type": "concept",
      "description": "Handles JWT authentication for all Clawdbot components",
      "aliases": ["AuthService", "auth service", "Authentication Service"],
      "mentions": [
        {
          "text": "Auth Service",
          "startIndex": 5,
          "endIndex": 17,
          "context": "The Auth Service handles JWT authentication..."
        }
      ]
    },
    {
      "id": "entity_002",
      "name": "JWT",
      "type": "concept",
      "description": "JSON Web Token authentication method",
      "aliases": ["JWT", "JSON Web Token"],
      "mentions": [
        {
          "text": "JWT",
          "startIndex": 35,
          "endIndex": 38,
          "context": "...handles JWT authentication for..."
        }
      ]
    },
    {
      "id": "entity_003",
      "name": "Clawdbot",
      "type": "org",
      "description": "The main product/organization",
      "aliases": ["Clawdbot", "clawdbot"],
      "mentions": [
        {
          "text": "Clawdbot",
          "startIndex": 64,
          "endIndex": 73,
          "context": "...for all Clawdbot components."
        }
      ]
    },
    {
      "id": "entity_004",
      "name": "Redis",
      "type": "tool",
      "description": "Used for token blacklisting",
      "aliases": ["Redis"],
      "mentions": [
        {
          "text": "Redis",
          "startIndex": 145,
          "endIndex": 150,
          "context": "- Redis for token blacklisting"
        }
      ]
    },
    {
      "id": "entity_005",
      "name": "PostgreSQL",
      "type": "tool",
      "description": "Database for user data",
      "aliases": ["PostgreSQL", "postgres"],
      "mentions": [
        {
          "text": "PostgreSQL",
          "startIndex": 168,
          "endIndex": 178,
          "context": "- PostgreSQL for user data"
        }
      ]
    },
    {
      "id": "entity_006",
      "name": "UserService",
      "type": "concept",
      "description": "Service for profile validation",
      "aliases": ["UserService", "User Service"],
      "mentions": [
        {
          "text": "UserService",
          "startIndex": 203,
          "endIndex": 214,
          "context": "Calls UserService for profile validation"
        }
      ]
    },
    {
      "id": "entity_007",
      "name": "Alice Chen",
      "type": "person",
      "description": "Implemented the Auth Service",
      "aliases": ["Alice Chen", "Alice"],
      "mentions": [
        {
          "text": "Alice Chen",
          "startIndex": 230,
          "endIndex": 240,
          "context": "Implemented by Alice Chen on 2024-01-15"
        }
      ]
    },
    {
      "id": "entity_008",
      "name": "clawdbot/core",
      "type": "repo",
      "description": "Core library dependency",
      "aliases": ["clawdbot/core", "core library"],
      "mentions": [
        {
          "text": "clawdbot/core",
          "startIndex": 268,
          "endIndex": 282,
          "context": "Depends on clawdbot/core library v2.1"
        }
      ]
    },
    {
      "id": "entity_009",
      "name": "/api/v1/auth/login",
      "type": "location",
      "description": "Login endpoint",
      "aliases": ["/api/v1/auth/login", "login endpoint"],
      "mentions": [
        {
          "text": "/api/v1/auth/login",
          "startIndex": 84,
          "endIndex": 101,
          "context": "### POST /api/v1/auth/login"
        }
      ]
    }
  ],
  "relationships": [
    {
      "id": "rel_001",
      "sourceEntityId": "entity_001",
      "targetEntityId": "entity_004",
      "type": "uses",
      "description": "Auth Service uses Redis for token blacklisting",
      "keywords": ["uses", "for", "blacklisting"],
      "strength": 7,
      "mentions": [
        {
          "text": "Redis for token blacklisting",
          "startIndex": 145,
          "endIndex": 170,
          "context": "- Redis for token blacklisting"
        }
      ]
    },
    {
      "id": "rel_002",
      "sourceEntityId": "entity_001",
      "targetEntityId": "entity_005",
      "type": "uses",
      "description": "Auth Service uses PostgreSQL for user data",
      "keywords": ["uses", "for", "user data"],
      "strength": 7,
      "mentions": [
        {
          "text": "PostgreSQL for user data",
          "startIndex": 168,
          "endIndex": 190,
          "context": "- PostgreSQL for user data"
        }
      ]
    },
    {
      "id": "rel_003",
      "sourceEntityId": "entity_001",
      "targetEntityId": "entity_006",
      "type": "calls",
      "description": "Auth Service calls UserService for profile validation",
      "keywords": ["calls", "for", "validation"],
      "strength": 8,
      "mentions": [
        {
          "text": "Calls UserService for profile validation",
          "startIndex": 199,
          "endIndex": 238,
          "context": "Calls UserService for profile validation"
        }
      ]
    },
    {
      "id": "rel_004",
      "sourceEntityId": "entity_001",
      "targetEntityId": "entity_007",
      "type": "created_by",
      "description": "Auth Service was implemented by Alice Chen",
      "keywords": ["implemented", "by"],
      "strength": 9,
      "mentions": [
        {
          "text": "Implemented by Alice Chen",
          "startIndex": 230,
          "endIndex": 253,
          "context": "Implemented by Alice Chen on 2024-01-15"
        }
      ]
    },
    {
      "id": "rel_005",
      "sourceEntityId": "entity_001",
      "targetEntityId": "entity_008",
      "type": "depends_on",
      "description": "Auth Service depends on clawdbot/core library",
      "keywords": ["depends", "on", "library"],
      "strength": 8,
      "mentions": [
        {
          "text": "Depends on clawdbot/core library",
          "startIndex": 261,
          "endIndex": 291,
          "context": "Depends on clawdbot/core library v2.1"
        }
      ]
    },
    {
      "id": "rel_006",
      "sourceEntityId": "entity_001",
      "targetEntityId": "entity_009",
      "type": "exposes",
      "description": "Auth Service exposes the /api/v1/auth/login endpoint",
      "keywords": ["endpoint", "post"],
      "strength": 9,
      "mentions": [
        {
          "text": "POST /api/v1/auth/login",
          "startIndex": 78,
          "endIndex": 101,
          "context": "### POST /api/v1/auth/login"
        }
      ]
    },
    {
      "id": "rel_007",
      "sourceEntityId": "entity_001",
      "targetEntityId": "entity_002",
      "type": "implements",
      "description": "Auth Service implements JWT authentication",
      "keywords": ["handles", "authentication"],
      "strength": 10,
      "mentions": [
        {
          "text": "Auth Service handles JWT authentication",
          "startIndex": 5,
          "endIndex": 44,
          "context": "The Auth Service handles JWT authentication..."
        }
      ]
    }
  ]
}
```

## Ground Truth Template

Create the file `src/knowledge/extraction/gold-standard.json`:

```json
{
  "version": "1.0",
  "created": "2024-01-26",
  "documents": [
    {
      "documentId": "auth-service-spec",
      "documentName": "auth-service-spec.pdf",
      "entities": [],
      "relationships": []
    },
    {
      "documentId": "payment-flow",
      "documentName": "payment-flow.docx",
      "entities": [],
      "relationships": []
    },
    {
      "documentId": "architecture-decision",
      "documentName": "architecture-decision.md",
      "entities": [],
      "relationships": []
    },
    {
      "documentId": "api-client",
      "documentName": "api-client.ts",
      "entities": [],
      "relationships": []
    },
    {
      "documentId": "meeting-notes",
      "documentName": "meeting-notes.txt",
      "entities": [],
      "relationships": []
    },
    {
      "documentId": "docs-site",
      "documentName": "docs-site.html",
      "entities": [],
      "relationships": []
    },
    {
      "documentId": "deployment-guide",
      "documentName": "deployment-guide.md",
      "entities": [],
      "relationships": []
    },
    {
      "documentId": "entity-model",
      "documentName": "entity-model.json",
      "entities": [],
      "relationships": []
    },
    {
      "documentId": "changelog",
      "documentName": "changelog.md",
      "entities": [],
      "relationships": []
    },
    {
      "documentId": "debug-session",
      "documentName": "debug-session.md",
      "entities": [],
      "relationships": []
    }
  ]
}
```

## Quality Checks

After completing ground truth extraction, verify:

### Completeness
- [ ] All 10 documents have extractions
- [ ] All entity types are represented
- [ ] All relationship types are represented
- [ ] Edge cases are explicitly marked

### Consistency
- [ ] Entity IDs are unique across all documents
- [ ] Relationship IDs are unique
- [ ] Source/target entity IDs exist
- [ ] Strength values are 1-10
- [ ] Mentions have valid indices

### Accuracy
- [ ] Entity descriptions reflect only document content
- [ ] Relationship descriptions match text
- [ ] Keywords are present in text
- [ ] Aliases cover all variations

## Expected Totals

For the 10-document corpus (~2000-3000 words), expect to extract:

- **Entities:** 100-150 total
- **Relationships:** 80-120 total
- **Entity Types:** All 11 types represented
- **Relationship Types:** 10+ unique types

## References

- Entity Type Schema: `docs/plans/graphrag/ZAI-FINAL-DECISIONS.md`
- Relationship Schema: `docs/plans/graphrag/ZAI-DECISIONS.md` AD-05
- Test Corpus: `docs/plans/graphrag/test-corpus/` (created in Task 01)

## Next Task

After completing this task, proceed to `03-quality-metrics-definition.md` to define how we'll measure extraction quality.
