# Phase 5, Task 01: React Flow Graph Visualization

**Phase:** 5 - Web Visualization + Gateway API
**Task:** Implement knowledge graph visualization using React Flow
**Duration:** 2 weeks
**Complexity:** High
**Depends on:** Phase 4 complete

---

## Task Overview

Create an interactive graph visualization using React Flow:
- Force-directed layout
- Entity type filtering
- Relationship filtering
- Click to inspect
- Zoom, pan, mini-map

## Architecture Decision

**Reference:** AD-06 in `docs/plans/graphrag/ZAI-DECISIONS.md`

**Decision:** React Flow for knowledge graph visualization
- Native React integration
- Optimized for <1000 visible nodes
- Built-in interactive features (drag, zoom, mini-map)

## File Structure

```
ui/src/ui/components/knowledge-graph/
├── GraphVisualization.tsx     # Main React Flow component
├── EntityNode.tsx             # Custom entity node component
├── EntityDetailPanel.tsx      # Sidebar for entity details
├── GraphControls.tsx          # Filter controls
└── useGraphData.ts            # Hook for fetching graph data

apps/macos/Sources/Views/      # macOS app views
├── KnowledgeGraphView.swift   # Native wrapper (optional)
```

## Main Visualization Component

**File:** `ui/src/ui/components/knowledge-graph/GraphVisualization.tsx`

```typescript
/**
 * Knowledge graph visualization using React Flow.
 *
 * Features:
 * - Force-directed layout
 * - Interactive nodes (click, drag, hover)
 * - Mini-map navigation
 * - Entity type filtering
 * - Relationship filtering
 *
 * Reference: docs/plans/graphrag/ZAI-DECISIONS.md AD-06
 */

import React, { useCallback, useMemo, useState } from 'react';
import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
  NodeTypes,
  Position,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { EntityNode } from './EntityNode.js';
import { EntityDetailPanel } from './EntityDetailPanel.js';
import { GraphControls } from './GraphControls.js';
import { useGraphData } from './useGraphData.js';
import type { Entity, Relationship } from '../../../knowledge/graph/types.js';

const nodeTypes: NodeTypes = {
  entity: EntityNode,
};

export interface GraphVisualizationProps {
  gatewayUrl: string;
  initialFilter?: {
    entityTypes?: string[];
    relationshipTypes?: string[];
  };
}

export function GraphVisualization({ gatewayUrl, initialFilter }: GraphVisualizationProps) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);

  // Fetch graph data
  const { graphData, loading, error, refetch } = useGraphData(gatewayUrl, {
    entityTypes: initialFilter?.entityTypes,
    relationshipTypes: initialFilter?.relationshipTypes,
  });

  // Convert graph data to React Flow format
  const flowNodes = useMemo(() => {
    return graphData.entities.map((entity, index) => ({
      id: entity.id,
      type: 'entity',
      position: { x: Math.random() * 800, y: Math.random() * 600 },
      data: {
        entity,
        onSelect: () => setSelectedEntity(entity),
      },
    }));
  }, [graphData.entities]);

  const flowEdges = useMemo(() => {
    return graphData.relationships.map((rel, index) => ({
      id: rel.id,
      source: rel.sourceId,
      target: rel.targetId,
      label: rel.type,
      type: 'smoothstep',
      animated: true,
      style: { stroke: getRelationshipColor(rel.type), strokeWidth: rel.strength / 2 },
      data: { relationship: rel },
    }));
  }, [graphData.relationships]);

  // Handle filter changes
  const handleFilterChange = useCallback((filter: {
    entityTypes: string[];
    relationshipTypes: string[];
  }) => {
    refetch(filter);
  }, [refetch]);

  return (
    <div className="knowledge-graph-container" style={{ width: '100%', height: '100vh', display: 'flex' }}>
      {/* Main graph area */}
      <div className="graph-canvas" style={{ flex: 1, position: 'relative' }}>
        {loading && (
          <div className="loading-overlay">
            Loading graph...
          </div>
        )}

        {error && (
          <div className="error-overlay">
            Error loading graph: {error.message}
          </div>
        )}

        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.1}
          maxZoom={2}
          defaultEdgeOptions={{ animated: true }}
        >
          <Background />
          <Controls />
          <MiniMap
            nodeColor={(node) => getEntityColor(node.data.entity.type)}
            nodeStrokeWidth={3}
          />
        </ReactFlow>

        {/* Filter controls */}
        <div className="graph-controls" style={{ position: 'absolute', top: 16, left: 16, zIndex: 10 }}>
          <GraphControls
            availableEntityTypes={graphData.availableEntityTypes}
            availableRelationshipTypes={graphData.availableRelationshipTypes}
            onFilterChange={handleFilterChange}
            initialFilter={initialFilter}
          />
        </div>

        {/* Stats */}
        <div className="graph-stats" style={{ position: 'absolute', bottom: 16, left: 16, zIndex: 10 }}>
          <div className="stat">
            {graphData.entities.length} entities
          </div>
          <div className="stat">
            {graphData.relationships.length} relationships
          </div>
        </div>
      </div>

      {/* Entity detail panel */}
      {selectedEntity && (
        <EntityDetailPanel
          entity={selectedEntity}
          relationships={graphData.relationships.filter(
            r => r.sourceId === selectedEntity.id || r.targetId === selectedEntity.id
          )}
          onClose={() => setSelectedEntity(null)}
          gatewayUrl={gatewayUrl}
        />
      )}
    </div>
  );
}

// Helper: Get color for entity type
function getEntityColor(type: string): string {
  const colors: Record<string, string> = {
    person: '#3B82F6',
    org: '#10B981',
    repo: '#8B5CF6',
    concept: '#F59E0B',
    tool: '#EF4444',
    location: '#EC4899',
    event: '#6366F1',
    goal: '#14B8A6',
    task: '#84CC16',
    file: '#64748B',
  };
  return colors[type] || '#9CA3AF';
}

// Helper: Get color for relationship type
function getRelationshipColor(type: string): string {
  const colors: Record<string, string> = {
    depends_on: '#EF4444',
    implements: '#3B82F6',
    located_in: '#8B5CF6',
    created_by: '#10B981',
    related_to: '#9CA3AF',
    part_of: '#F59E0B',
    calls: '#EC4899',
    exposes: '#6366F1',
    uses: '#14B8A6',
    precedes: '#84CC16',
  };
  return colors[type] || '#9CA3AF';
}
```

## Entity Node Component

**File:** `ui/src/ui/components/knowledge-graph/EntityNode.tsx`

```typescript
/**
 * Custom entity node for React Flow.
 */

import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import type { Entity } from '../../../../knowledge/graph/types.js';
import { getEntityColor } from './GraphVisualization.js';

export const EntityNode = memo(({ data, selected }: NodeProps) => {
  const entity = data.entity as Entity;

  return (
    <div
      className={`
        entity-node
        ${selected ? 'selected' : ''}
      `}
      style={{
        padding: '8px 12px',
        borderRadius: '8px',
        border: '2px solid',
        borderColor: selected ? '#2563EB' : getEntityColor(entity.type),
        backgroundColor: 'white',
        boxShadow: selected ? '0 4px 12px rgba(0,0,0,0.15)' : '0 2px 4px rgba(0,0,0,0.1)',
        minWidth: '150px',
        cursor: 'pointer',
        transition: 'all 0.2s',
      }}
      onClick={data.onSelect}
    >
      {/* Input handle */}
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: getEntityColor(entity.type) }}
      />

      {/* Entity icon */}
      <div className="entity-icon" style={{ fontSize: '20px', marginBottom: '4px' }}>
        {getEntityIcon(entity.type)}
      </div>

      {/* Entity name */}
      <div className="entity-name" style={{
        fontWeight: 600,
        fontSize: '14px',
        color: '#1F2937',
      }}>
        {entity.name}
      </div>

      {/* Entity type */}
      <div className="entity-type" style={{
        fontSize: '12px',
        color: '#6B7280',
        marginTop: '2px',
      }}>
        {entity.type}
      </div>

      {/* Description preview */}
      {entity.description && (
        <div className="entity-description" style={{
          fontSize: '11px',
          color: '#9CA3AF',
          marginTop: '4px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {entity.description.slice(0, 30)}...
        </div>
      )}

      {/* Output handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: getEntityColor(entity.type) }}
      />
    </div>
  );
});

EntityNode.displayName = 'EntityNode';

function getEntityIcon(type: string): string {
  const icons: Record<string, string> = {
    person: '👤',
    org: '🏢',
    repo: '📦',
    concept: '💡',
    tool: '🔧',
    location: '📍',
    event: '📅',
    goal: '🎯',
    task: '✅',
    file: '📄',
  };
  return icons[type] || '📍';
}
```

## Graph Data Hook

**File:** `ui/src/ui/components/knowledge-graph/useGraphData.ts`

```typescript
/**
 * Hook for fetching graph data from gateway API.
 */

import { useEffect, useState } from 'react';
import type { Entity, Relationship } from '../../../knowledge/graph/types.js';

export interface GraphData {
  entities: Entity[];
  relationships: Relationship[];
  availableEntityTypes: string[];
  availableRelationshipTypes: string[];
}

export interface UseGraphDataOptions {
  entityTypes?: string[];
  relationshipTypes?: string[];
  limit?: number;
}

export function useGraphData(
  gatewayUrl: string,
  options: UseGraphDataOptions = {}
) {
  const [graphData, setGraphData] = useState<GraphData>({
    entities: [],
    relationships: [],
    availableEntityTypes: [],
    availableRelationshipTypes: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = async (filterOptions?: UseGraphDataOptions) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();

      if (filterOptions?.entityTypes) {
        params.append('types', filterOptions.entityTypes.join(','));
      }
      if (filterOptions?.relationshipTypes) {
        params.append('relTypes', filterOptions.relationshipTypes.join(','));
      }
      if (filterOptions?.limit) {
        params.append('limit', filterOptions.limit.toString());
      }

      const response = await fetch(`${gatewayUrl}/api/knowledge/graph/entities?${params}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      setGraphData({
        entities: data.entities || [],
        relationships: data.relationships || [],
        availableEntityTypes: data.availableEntityTypes || [],
        availableRelationshipTypes: data.availableRelationshipTypes || [],
      });
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData(options);
  }, [gatewayUrl]);

  const refetch = (newOptions?: UseGraphDataOptions) => {
    fetchData(newOptions || options);
  };

  return { graphData, loading, error, refetch };
}
```

## Filter Controls

**File:** `ui/src/ui/components/knowledge-graph/GraphControls.tsx`

```typescript
/**
 * Filter controls for graph visualization.
 */

import React, { useState } from 'react';

export interface GraphControlsProps {
  availableEntityTypes: string[];
  availableRelationshipTypes: string[];
  onFilterChange: (filter: { entityTypes: string[]; relationshipTypes: string[] }) => void;
  initialFilter?: {
    entityTypes?: string[];
    relationshipTypes?: string[];
  };
}

export function GraphControls({
  availableEntityTypes,
  availableRelationshipTypes,
  onFilterChange,
  initialFilter,
}: GraphControlsProps) {
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>(
    initialFilter?.entityTypes || []
  );
  const [selectedRelTypes, setSelectedRelTypes] = useState<string[]>(
    initialFilter?.relationshipTypes || []
  );

  const handleEntityTypeToggle = (type: string) => {
    const newTypes = selectedEntityTypes.includes(type)
      ? selectedEntityTypes.filter(t => t !== type)
      : [...selectedEntityTypes, type];

    setSelectedEntityTypes(newTypes);
    onFilterChange({ entityTypes: newTypes, relationshipTypes: selectedRelTypes });
  };

  const handleRelTypeToggle = (type: string) => {
    const newTypes = selectedRelTypes.includes(type)
      ? selectedRelTypes.filter(t => t !== type)
      : [...selectedRelTypes, type];

    setSelectedRelTypes(newTypes);
    onFilterChange({ entityTypes: selectedEntityTypes, relationshipTypes: newTypes });
  };

  return (
    <div className="graph-controls" style={{
      backgroundColor: 'white',
      borderRadius: '8px',
      padding: '12px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    }}>
      {/* Entity type filter */}
      <div className="filter-section" style={{ marginBottom: '12px' }}>
        <div className="filter-title" style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>
          Entity Types
        </div>
        <div className="filter-options">
          {availableEntityTypes.map(type => (
            <label key={type} style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
              <input
                type="checkbox"
                checked={selectedEntityTypes.includes(type)}
                onChange={() => handleEntityTypeToggle(type)}
                style={{ marginRight: '4px' }}
              />
              {type}
            </label>
          ))}
        </div>
      </div>

      {/* Relationship type filter */}
      <div className="filter-section">
        <div className="filter-title" style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>
          Relationship Types
        </div>
        <div className="filter-options">
          {availableRelationshipTypes.map(type => (
            <label key={type} style={{ display: 'block', fontSize: '12px', marginBottom: '4px' }}>
              <input
                type="checkbox"
                checked={selectedRelTypes.includes(type)}
                onChange={() => handleRelTypeToggle(type)}
                style={{ marginRight: '4px' }}
              />
              {type}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
```

## Entity Detail Panel

**File:** `ui/src/ui/components/knowledge-graph/EntityDetailPanel.tsx`

```typescript
/**
 * Sidebar panel showing entity details.
 */

import React from 'react';
import type { Entity, Relationship } from '../../../knowledge/graph/types.js';

export interface EntityDetailPanelProps {
  entity: Entity;
  relationships: Relationship[];
  onClose: () => void;
  gatewayUrl: string;
}

export function EntityDetailPanel({ entity, relationships, onClose, gatewayUrl }: EntityDetailPanelProps) {
  return (
    <div className="entity-detail-panel" style={{
      position: 'fixed',
      right: 0,
      top: 0,
      bottom: 0,
      width: '400px',
      backgroundColor: 'white',
      borderLeft: '1px solid #E5E7EB',
      boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
      padding: '20px',
      overflowY: 'auto',
      zIndex: 100,
    }}>
      {/* Close button */}
      <button
        onClick={onClose}
        style={{
          position: 'absolute',
          top: '16px',
          right: '16px',
          border: 'none',
          background: 'none',
          fontSize: '20px',
          cursor: 'pointer',
        }}
      >
        ×
      </button>

      {/* Entity header */}
      <div className="entity-header" style={{ marginBottom: '20px' }}>
        <div className="entity-icon" style={{ fontSize: '48px', marginBottom: '8px' }}>
          {getEntityIcon(entity.type)}
        </div>
        <h2 className="entity-name" style={{ fontSize: '24px', fontWeight: 600, margin: 0 }}>
          {entity.name}
        </h2>
        <div className="entity-type" style={{ fontSize: '14px', color: '#6B7280' }}>
          {entity.type}
        </div>
      </div>

      {/* Description */}
      {entity.description && (
        <div className="entity-description" style={{ marginBottom: '20px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>Description</h3>
          <p style={{ fontSize: '14px', lineHeight: '1.5' }}>{entity.description}</p>
        </div>
      )}

      {/* Relationships */}
      <div className="entity-relationships">
        <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '12px' }}>
          Relationships ({relationships.length})
        </h3>
        {relationships.map(rel => (
          <div key={rel.id} className="relationship" style={{
            padding: '12px',
            border: '1px solid #E5E7EB',
            borderRadius: '6px',
            marginBottom: '8px',
          }}>
            <div className="relationship-type" style={{
              fontSize: '12px',
              fontWeight: 600,
              color: getRelationshipColor(rel.type),
              marginBottom: '4px',
            }}>
              {rel.type}
            </div>
            <div className="relationship-description" style={{ fontSize: '13px' }}>
              {rel.description}
            </div>
            <div className="relationship-strength" style={{
              fontSize: '11px',
              color: '#9CA3AF',
              marginTop: '4px',
            }}>
              Strength: {rel.strength}/10
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function getEntityIcon(type: string): string {
  // Same as EntityNode
  const icons: Record<string, string> = {
    person: '👤', org: '🏢', repo: '📦', concept: '💡',
    tool: '🔧', location: '📍', event: '📅', goal: '🎯',
    task: '✅', file: '📄',
  };
  return icons[type] || '📍';
}

function getRelationshipColor(type: string): string {
  // Same as GraphVisualization
  const colors: Record<string, string> = {
    depends_on: '#EF4444', implements: '#3B82F6', located_in: '#8B5CF6',
    created_by: '#10B981', related_to: '#9CA3AF', part_of: '#F59E0B',
    calls: '#EC4899', exposes: '#6366F1', uses: '#14B8A6', precedes: '#84CC16',
  };
  return colors[type] || '#9CA3AF';
}
```

## Gateway API Endpoints

**Add to:** Gateway route handlers

```typescript
// GET /api/knowledge/graph/entities
app.get('/api/knowledge/graph/entities', async (req, res) => {
  const { types, relTypes, limit } = req.query;

  const entities = await datastore.query(
    `SELECT * FROM kg_entities
     ${types ? `WHERE type IN (${types.split(',').map(() => '?').join(',')})` : ''}
     LIMIT ${limit || 1000}`,
    types ? types.split(',') : []
  );

  const relationships = await datastore.query(
    `SELECT r.* FROM kg_relationships r
     JOIN kg_entities e1 ON r.source_id = e1.id
     JOIN kg_entities e2 ON r.target_id = e2.id
     WHERE 1=1
       ${types ? `AND e1.type IN (${types.split(',').map(() => '?').join(',')})` : ''}
       ${relTypes ? `AND r.type IN (${relTypes.split(',').map(() => '?').join(',')})` : ''}
     LIMIT ${limit ? limit * 3 : 3000}`,
    [...(types ? types.split(',') : []), ...(relTypes ? relTypes.split(',') : [])]
  );

  const availableEntityTypes = await datastore.query<{ type: string }>(
    'SELECT DISTINCT type FROM kg_entities ORDER BY type'
  );

  const availableRelTypes = await datastore.query<{ type: string }>(
    'SELECT DISTINCT type FROM kg_relationships ORDER BY type'
  );

  res.json({
    entities,
    relationships,
    availableEntityTypes: availableEntityTypes.map(r => r.type),
    availableRelationshipTypes: availableRelTypes.map(r => r.type),
  });
});
```

## Dependencies

```bash
cd ui
pnpm add reactflow
```

## Success Criteria

- [ ] Graph renders with force layout
- [ ] Click entity to show details
- [ ] Drag nodes works
- [ ] Zoom/pan works
- [ ] Mini-map navigation works
- [ ] Filter by entity type works
- [ ] Filter by relationship type works
- [ ] Performance acceptable for <500 nodes

## References

- Decision AD-06: `docs/plans/graphrag/ZAI-DECISIONS.md`
- React Flow Docs: https://reactflow.dev/

## Next Task

Proceed to `02-gateway-api.md` to implement gateway API endpoints.
