// ============================================
// ARCHITECTURE DIAGRAM MODULE
// ============================================
// Auto-generate dependency visualizations from code

const archDiagramState = {
  isOpen: false,
  currentDiagram: null,
  cache: new Map(),
  diagramType: 'dependency', // 'dependency' | 'component' | 'flow'
};

/**
 * Initialize architecture diagram module
 */
function initArchitectureDiagram() {
  console.log('📊 Architecture diagram initialized');
}

/**
 * Show architecture diagram for current file or project
 * @param {string} scope - 'file' | 'folder' | 'project'
 */
async function showArchitectureDiagram(scope = 'file') {
  let panel = document.getElementById('archDiagramPanel');
  
  if (!panel) {
    panel = createDiagramPanel();
    document.body.appendChild(panel);
  }
  
  panel.classList.remove('hidden');
  archDiagramState.isOpen = true;
  
  // Show loading
  document.getElementById('archDiagramContent').innerHTML = `
    <div class="arch-loading">
      <div class="loading-spinner"></div>
      <span>Analyzing ${scope}...</span>
    </div>
  `;
  
  try {
    const diagramData = await generateDiagram(scope);
    renderDiagram(diagramData);
  } catch (err) {
    document.getElementById('archDiagramContent').innerHTML = `
      <div class="arch-error">
        <span>⚠ Failed to generate diagram</span>
        <span class="error-detail">${escapeHtml(err.message)}</span>
      </div>
    `;
  }
}

/**
 * Close diagram panel
 */
function closeArchitectureDiagram() {
  const panel = document.getElementById('archDiagramPanel');
  if (panel) {
    panel.classList.add('hidden');
  }
  archDiagramState.isOpen = false;
}

/**
 * Create the diagram panel
 */
function createDiagramPanel() {
  const panel = document.createElement('div');
  panel.id = 'archDiagramPanel';
  panel.className = 'arch-diagram-panel hidden';
  
  panel.innerHTML = `
    <div class="arch-diagram-overlay" onclick="closeArchitectureDiagram()"></div>
    <div class="arch-diagram-modal">
      <div class="arch-diagram-header">
        <span class="arch-icon">📊</span>
        <span class="arch-title">Architecture Diagram</span>
        <div class="arch-controls">
          <select id="archDiagramType" onchange="changeDiagramType(this.value)">
            <option value="dependency">Dependencies</option>
            <option value="component">Components</option>
            <option value="flow">Data Flow</option>
          </select>
          <select id="archDiagramScope" onchange="refreshDiagram()">
            <option value="file">Current File</option>
            <option value="folder">Current Folder</option>
            <option value="project">Entire Project</option>
          </select>
        </div>
        <button class="arch-close" onclick="closeArchitectureDiagram()">×</button>
      </div>
      <div class="arch-diagram-content" id="archDiagramContent">
        <!-- Diagram rendered here -->
      </div>
      <div class="arch-diagram-footer">
        <button onclick="exportDiagram('svg')">📥 Export SVG</button>
        <button onclick="exportDiagram('mermaid')">📝 Export Mermaid</button>
        <button onclick="refreshDiagram()">↻ Refresh</button>
      </div>
    </div>
  `;
  
  return panel;
}

/**
 * Generate diagram data by analyzing code
 * @param {string} scope - Analysis scope
 */
async function generateDiagram(scope) {
  const type = document.getElementById('archDiagramType')?.value || 'dependency';
  archDiagramState.diagramType = type;
  
  // Check cache
  const cacheKey = `${scope}-${type}-${state.currentFile || 'project'}`;
  const cached = archDiagramState.cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 30000) {
    return cached.data;
  }
  
  try {
    const response = await fetch('/api/architecture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope,
        type,
        currentFile: state.currentFile,
        workspace: state.workspace
      })
    });
    
    const data = await response.json();
    
    if (data.error) throw new Error(data.error);
    
    // Cache result
    archDiagramState.cache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });
    
    archDiagramState.currentDiagram = data;
    return data;
    
  } catch (err) {
    // If server endpoint not available, generate client-side
    return generateClientSideDiagram(scope, type);
  }
}

/**
 * Generate a simple diagram client-side
 * @param {string} scope - Scope
 * @param {string} type - Diagram type
 */
async function generateClientSideDiagram(scope, type) {
  // Get file list for analysis
  let files = [];
  
  if (scope === 'file' && state.currentFile) {
    files = [state.currentFile];
  } else if (scope === 'folder' && state.currentFile) {
    const folder = state.currentFile.split('/').slice(0, -1).join('/');
    // Would need to fetch folder contents
    files = [state.currentFile];
  } else {
    // Would need full file list
    files = Array.from(state.panes[0]?.files?.keys() || []);
  }
  
  // Parse imports from files
  const nodes = [];
  const edges = [];
  const nodeSet = new Set();
  
  for (const file of files) {
    const pane = state.panes.find(p => p.files.has(file));
    const fileData = pane?.files.get(file);
    
    if (!fileData?.model) continue;
    
    const content = fileData.model.getValue();
    const fileName = file.split('/').pop();
    
    // Add node
    if (!nodeSet.has(fileName)) {
      nodes.push({ id: fileName, label: fileName, type: getFileType(file) });
      nodeSet.add(fileName);
    }
    
    // Parse imports
    const imports = parseImports(content, file);
    
    for (const imp of imports) {
      const targetName = imp.source.split('/').pop();
      
      if (!nodeSet.has(targetName)) {
        nodes.push({ 
          id: targetName, 
          label: targetName, 
          type: imp.isExternal ? 'external' : 'internal' 
        });
        nodeSet.add(targetName);
      }
      
      edges.push({
        source: fileName,
        target: targetName,
        label: imp.specifiers?.join(', ') || ''
      });
    }
  }
  
  return {
    nodes,
    edges,
    mermaid: generateMermaidCode(nodes, edges, type)
  };
}

/**
 * Parse imports from file content
 * @param {string} content - File content
 * @param {string} filePath - File path
 */
function parseImports(content, filePath) {
  const imports = [];
  
  // ES6 imports
  const esImportRegex = /import\s+(?:(?:\{([^}]+)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  
  while ((match = esImportRegex.exec(content)) !== null) {
    const namedImports = match[1]?.split(',').map(s => s.trim()) || [];
    const namespaceImport = match[2];
    const defaultImport = match[3];
    const source = match[4];
    
    const specifiers = [
      ...namedImports,
      namespaceImport ? `* as ${namespaceImport}` : null,
      defaultImport
    ].filter(Boolean);
    
    imports.push({
      source,
      specifiers,
      isExternal: !source.startsWith('.') && !source.startsWith('/')
    });
  }
  
  // CommonJS requires
  const requireRegex = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\(['"]([^'"]+)['"]\)/g;
  
  while ((match = requireRegex.exec(content)) !== null) {
    const destructured = match[1]?.split(',').map(s => s.trim()) || [];
    const varName = match[2];
    const source = match[3];
    
    imports.push({
      source,
      specifiers: destructured.length ? destructured : [varName],
      isExternal: !source.startsWith('.') && !source.startsWith('/')
    });
  }
  
  return imports;
}

/**
 * Get file type for styling
 */
function getFileType(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  
  const types = {
    js: 'javascript',
    jsx: 'react',
    ts: 'typescript',
    tsx: 'react-ts',
    vue: 'vue',
    svelte: 'svelte',
    css: 'style',
    scss: 'style',
    json: 'config',
    md: 'doc',
  };
  
  return types[ext] || 'file';
}

/**
 * Generate Mermaid diagram code
 * @param {Array} nodes - Nodes
 * @param {Array} edges - Edges
 * @param {string} type - Diagram type
 */
function generateMermaidCode(nodes, edges, type) {
  let code = '';
  
  if (type === 'flow') {
    code = 'flowchart TD\n';
  } else {
    code = 'graph LR\n';
  }
  
  // Add nodes with styling
  for (const node of nodes) {
    const shape = node.type === 'external' ? `((${node.label}))` : `[${node.label}]`;
    code += `  ${sanitizeId(node.id)}${shape}\n`;
  }
  
  // Add edges
  for (const edge of edges) {
    const label = edge.label ? `|${edge.label.substring(0, 20)}|` : '';
    code += `  ${sanitizeId(edge.source)} -->${label} ${sanitizeId(edge.target)}\n`;
  }
  
  // Add styling
  code += '\n  classDef external fill:#f9f,stroke:#333\n';
  code += '  classDef react fill:#61dafb,stroke:#333\n';
  code += '  classDef typescript fill:#3178c6,stroke:#333,color:#fff\n';
  
  // Apply classes
  for (const node of nodes) {
    if (node.type === 'external') {
      code += `  class ${sanitizeId(node.id)} external\n`;
    } else if (node.type === 'react' || node.type === 'react-ts') {
      code += `  class ${sanitizeId(node.id)} react\n`;
    } else if (node.type === 'typescript') {
      code += `  class ${sanitizeId(node.id)} typescript\n`;
    }
  }
  
  return code;
}

/**
 * Sanitize ID for Mermaid
 */
function sanitizeId(id) {
  return id.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * Render the diagram using Mermaid
 * @param {Object} data - Diagram data
 */
function renderDiagram(data) {
  const container = document.getElementById('archDiagramContent');
  if (!container) return;
  
  if (!data.nodes || data.nodes.length === 0) {
    container.innerHTML = `
      <div class="arch-empty">
        <span>No dependencies found</span>
        <span class="empty-hint">Open a file with imports to see its dependencies</span>
      </div>
    `;
    return;
  }
  
  // Create Mermaid diagram
  container.innerHTML = `
    <div class="arch-stats">
      <span>${data.nodes.length} nodes</span>
      <span>•</span>
      <span>${data.edges.length} connections</span>
    </div>
    <div class="arch-mermaid" id="archMermaidContainer">
      <pre class="mermaid">${data.mermaid}</pre>
    </div>
    <div class="arch-mermaid-source hidden" id="archMermaidSource">
      <pre>${escapeHtml(data.mermaid)}</pre>
    </div>
  `;
  
  // Render with Mermaid if available
  if (typeof mermaid !== 'undefined') {
    try {
      mermaid.init(undefined, document.querySelectorAll('.mermaid'));
    } catch (e) {
      console.error('Mermaid render error:', e);
    }
  } else {
    // Load Mermaid dynamically
    loadMermaid().then(() => {
      mermaid.init(undefined, document.querySelectorAll('.mermaid'));
    }).catch(err => {
      console.error('Failed to load Mermaid:', err);
      // Show source code instead
      document.getElementById('archMermaidContainer').classList.add('hidden');
      document.getElementById('archMermaidSource').classList.remove('hidden');
    });
  }
}

/**
 * Load Mermaid library dynamically
 */
function loadMermaid() {
  return new Promise((resolve, reject) => {
    if (typeof mermaid !== 'undefined') {
      resolve();
      return;
    }
    
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
    script.onload = () => {
      mermaid.initialize({ 
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose'
      });
      resolve();
    };
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

/**
 * Change diagram type
 */
function changeDiagramType(type) {
  archDiagramState.diagramType = type;
  refreshDiagram();
}

/**
 * Refresh the diagram
 */
async function refreshDiagram() {
  const scope = document.getElementById('archDiagramScope')?.value || 'file';
  
  // Clear cache for this scope
  const type = archDiagramState.diagramType;
  const cacheKey = `${scope}-${type}-${state.currentFile || 'project'}`;
  archDiagramState.cache.delete(cacheKey);
  
  await showArchitectureDiagram(scope);
}

/**
 * Export diagram
 * @param {string} format - 'svg' | 'mermaid' | 'png'
 */
function exportDiagram(format) {
  const data = archDiagramState.currentDiagram;
  if (!data) {
    showNotification('No diagram to export', 'warning');
    return;
  }
  
  if (format === 'mermaid') {
    const blob = new Blob([data.mermaid], { type: 'text/plain' });
    downloadBlob(blob, 'architecture.mmd');
  } else if (format === 'svg') {
    const svg = document.querySelector('#archMermaidContainer svg');
    if (svg) {
      const svgData = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      downloadBlob(blob, 'architecture.svg');
    } else {
      showNotification('SVG not available', 'warning');
    }
  }
}

/**
 * Download a blob as a file
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Helper
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Export functions
window.initArchitectureDiagram = initArchitectureDiagram;
window.showArchitectureDiagram = showArchitectureDiagram;
window.closeArchitectureDiagram = closeArchitectureDiagram;
window.changeDiagramType = changeDiagramType;
window.refreshDiagram = refreshDiagram;
window.exportDiagram = exportDiagram;

// Initialize on load
document.addEventListener('DOMContentLoaded', initArchitectureDiagram);
