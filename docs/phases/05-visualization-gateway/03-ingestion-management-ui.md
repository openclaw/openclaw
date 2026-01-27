# Phase 5, Task 03: Ingestion Management UI

**Phase:** 5 - Web Visualization + Gateway API
**Task:** Implement UI for file upload and crawl management
**Duration:** 1 week
**Complexity:** Medium
**Depends on:** Task 01 (React Flow Visualization), Task 02 (Gateway API)

---

## Task Overview

Create web UI components for:
- File upload with progress
- Crawl launcher and progress
- Source list with actions
- Entity detail sidebar (already done)

## File Structure

```
ui/src/ui/components/knowledge-ingestion/
├── FileUpload.tsx         # File upload component
├── CrawlPanel.tsx          # Crawl launcher and progress
└── SourceList.tsx          # List of knowledge sources
```

## File Upload Component

```typescript
/**
 * File upload component for knowledge ingestion.
 */

import React, { useState, useCallback } from 'react';

export interface FileUploadProps {
  gatewayUrl: string;
  onUploadComplete?: (sourceId: string) => void;
}

export function FileUpload({ gatewayUrl, onUploadComplete }: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setProgress(0);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('source', 'file');

      const xhr = new XMLHttpRequest();

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setProgress((e.loaded / e.total) * 100);
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          const result = JSON.parse(xhr.responseText);
          onUploadComplete?.(result.sourceId);
        } else {
          console.error('Upload failed:', xhr.responseText);
        }
        setUploading(false);
      };

      xhr.onerror = () => {
        console.error('Upload error');
        setUploading(false);
      };

      xhr.open('POST', `${gatewayUrl}/api/knowledge/ingest`);
      xhr.send(formData);
    } catch (error) {
      console.error('Upload error:', error);
      setUploading(false);
    }
  }, [gatewayUrl, onUploadComplete]);

  return (
    <div className="file-upload">
      <input
        type="file"
        onChange={handleFileSelect}
        disabled={uploading}
        accept=".pdf,.docx,.md,.txt,.html"
        style={{ display: 'none' }}
        id="file-upload"
      />
      <label
        htmlFor="file-upload"
        className={`
          upload-button
          ${uploading ? 'uploading' : ''}
        `}
        style={{
          display: 'inline-block',
          padding: '12px 24px',
          backgroundColor: uploading ? '#9CA3AF' : '#3B82F6',
          color: 'white',
          borderRadius: '6px',
          cursor: uploading ? 'wait' : 'pointer',
        }}
      >
        {uploading ? `Uploading... ${Math.round(progress)}%` : 'Upload File'}
      </label>
    </div>
  );
}
```

## Crawl Panel Component

```typescript
/**
 * Crawl launcher and progress panel.
 */

import React, { useState } from 'react';

export interface CrawlPanelProps {
  gatewayUrl: string;
}

export function CrawlPanel({ gatewayUrl }: CrawlPanelProps) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'single' | 'sitemap' | 'recursive'>('single');
  const [maxPages, setMaxPages] = useState(100);
  const [crawling, setCrawling] = useState(false);
  const [crawlStatus, setCrawlStatus] = useState<any>(null);

  const startCrawl = async () => {
    if (!url) return;

    setCrawling(true);

    try {
      const response = await fetch(`${gatewayUrl}/api/knowledge/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          mode,
          maxPages,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        setCrawlStatus(result);

        // Poll for status
        const pollInterval = setInterval(async () => {
          const statusResponse = await fetch(`${gatewayUrl}/api/knowledge/crawl/${result.crawlId}`);
          const status = await statusResponse.json();

          setCrawlStatus(status);

          if (status.status === 'completed' || status.status === 'failed') {
            clearInterval(pollInterval);
            setCrawling(false);
          }
        }, 2000);
      } else {
        console.error('Crawl failed:', result.error);
        setCrawling(false);
      }
    } catch (error) {
      console.error('Crawl error:', error);
      setCrawling(false);
    }
  };

  return (
    <div className="crawl-panel" style={{
      padding: '16px',
      backgroundColor: 'white',
      borderRadius: '8px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    }}>
      <h3 style={{ marginTop: 0 }}>Crawl Documentation</h3>

      <div className="crawl-form" style={{ marginBottom: '16px' }}>
        <div className="form-field" style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/docs"
            disabled={crawling}
            style={{
              width: '100%',
              padding: '8px',
              border: '1px solid #D1D5DB',
              borderRadius: '4px',
            }}
          />
        </div>

        <div className="form-field" style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>Mode</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as any)}
            disabled={crawling}
            style={{
              width: '100%',
              padding: '8px',
              border: '1px solid #D1D5DB',
              borderRadius: '4px',
            }}
          >
            <option value="single">Single Page</option>
            <option value="sitemap">Sitemap</option>
            <option value="recursive">Recursive</option>
          </select>
        </div>

        <div className="form-field" style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>
            Max Pages: {maxPages}
          </label>
          <input
            type="range"
            min="10"
            max="1000"
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
            disabled={crawling}
            style={{ width: '100%' }}
          />
        </div>

        <button
          onClick={startCrawl}
          disabled={crawling || !url}
          style={{
            padding: '10px 20px',
            backgroundColor: crawling ? '#9CA3AF' : '#10B981',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: crawling ? 'wait' : 'pointer',
          }}
        >
          {crawling ? 'Crawling...' : 'Start Crawl'}
        </button>
      </div>

      {crawlStatus && (
        <div className="crawl-status" style={{
          padding: '12px',
          backgroundColor: '#F3F4F6',
          borderRadius: '4px',
        }}>
          <div><strong>Status:</strong> {crawlStatus.status}</div>
          <div><strong>Pages:</strong> {crawlStatus.successfulPages}/{crawlStatus.totalPages}</div>
          {crawlStatus.failedPages > 0 && (
            <div><strong>Failed:</strong> {crawlStatus.failedPages}</div>
          )}
          <div><strong>Duration:</strong> {crawlStatus.duration}ms</div>
        </div>
      )}
    </div>
  );
}
```

## Source List Component

```typescript
/**
 * List of knowledge sources with actions.
 */

import React, { useState, useEffect } from 'react';

export interface SourceListProps {
  gatewayUrl: string;
}

export function SourceList({ gatewayUrl }: SourceListProps) {
  const [sources, setSources] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSources();
  }, [gatewayUrl]);

  const fetchSources = async () => {
    setLoading(true);

    try {
      const response = await fetch(`${gatewayUrl}/api/knowledge/sources`);
      const data = await response.json();
      setSources(data.sources);
    } catch (error) {
      console.error('Failed to fetch sources:', error);
    } finally {
      setLoading(false);
    }
  };

  const deleteSource = async (sourceId: string) => {
    if (!confirm('Delete this source and all associated data?')) return;

    try {
      await fetch(`${gatewayUrl}/api/knowledge/sources/${sourceId}`, {
        method: 'DELETE',
      });

      fetchSources();
    } catch (error) {
      console.error('Failed to delete source:', error);
    }
  };

  if (loading) {
    return <div>Loading sources...</div>;
  }

  return (
    <div className="source-list">
      <h3>Sources ({sources.length})</h3>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #E5E7EB' }}>
            <th style={{ padding: '8px', textAlign: 'left' }}>Type</th>
            <th style={{ padding: '8px', textAlign: 'left' }}>Title/URL</th>
            <th style={{ padding: '8px', textAlign: 'left' }}>Created</th>
            <th style={{ padding: '8px', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.id} style={{ borderBottom: '1px solid #F3F4F6' }}>
              <td style={{ padding: '8px' }}>{source.type}</td>
              <td style={{ padding: '8px' }}>
                {source.title || source.url || source.path || '-'}
              </td>
              <td style={{ padding: '8px' }}>
                {new Date(source.created_at * 1000).toLocaleString()}
              </td>
              <td style={{ padding: '8px', textAlign: 'right' }}>
                <button
                  onClick={() => deleteSource(source.id)}
                  style={{
                    padding: '4px 8px',
                    backgroundColor: '#EF4444',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

## Success Criteria

- [ ] File upload works with progress
- [ ] Crawl launches and shows progress
- [ ] Source list displays correctly
- [ ] Delete action works
- [ ] Error handling works
- [ ] Components integrate with React Flow page
- [ ] Tests pass

## References

- Phase 5 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
