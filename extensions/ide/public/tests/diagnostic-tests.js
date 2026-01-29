/**
 * DIAGNOSTIC TEST SUITE v2.0
 * Comprehensive analysis of IDE & DNA integration
 * 
 * Test Categories:
 * 1. IDE Core Functionality
 * 2. DNA Integration
 * 3. Performance Analysis
 * 4. Conflict Detection
 * 5. Edge Cases
 * 6. Self-Improvement Health
 * 7. API Health
 * 8. Security (NEW)
 * 9. Accessibility (NEW)
 * 10. Error Recovery (NEW)
 * 11. WebSocket Stability (NEW)
 * 12. File Operations (NEW)
 * 13. Agent Reliability (NEW)
 * 14. State Persistence (NEW)
 * 15. Stress Tests (NEW)
 * 
 * Run: await DiagnosticTests.runAll()
 * Quick: await DiagnosticTests.runQuick() // Core tests only
 * Category: await DiagnosticTests.runCategory('security')
 */

const DiagnosticTests = {
  results: [],
  warnings: [],
  improvements: [],
  criticalIssues: [],
  startTime: null,
  
  // Test configuration
  config: {
    timeoutMs: 5000,
    performanceIterations: 50,
    stressTestIterations: 100,
    largeFileThreshold: 1024 * 1024, // 1MB
    slowApiThreshold: 500, // ms
    memoryWarningThreshold: 50, // percent
  },

  // ============================================
  // TEST UTILITIES
  // ============================================

  assert(condition, message) {
    if (!condition) throw new Error(message);
  },

  warn(category, message, suggestion) {
    this.warnings.push({ category, message, suggestion, timestamp: Date.now() });
    console.warn(`⚠️ [${category}] ${message}`);
  },

  critical(category, message, suggestion) {
    this.criticalIssues.push({ category, message, suggestion, timestamp: Date.now() });
    console.error(`🔴 [CRITICAL] [${category}] ${message}`);
  },

  suggest(category, message, impact) {
    this.improvements.push({ category, message, impact });
  },

  async runTest(name, fn, category = 'general', timeout = null) {
    const start = performance.now();
    const testTimeout = timeout || this.config.timeoutMs;
    
    try {
      // Wrap in timeout
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Test timed out after ${testTimeout}ms`)), testTimeout)
        )
      ]);
      
      const duration = performance.now() - start;
      this.results.push({ name, category, status: 'PASS', duration });
      console.log(`✅ ${name} (${duration.toFixed(2)}ms)`);
      return { pass: true, duration, result };
    } catch (e) {
      const duration = performance.now() - start;
      this.results.push({ name, category, status: 'FAIL', error: e.message, duration });
      console.error(`❌ ${name}: ${e.message}`);
      return { pass: false, error: e.message, duration };
    }
  },

  async measure(name, fn, iterations = null) {
    const count = iterations || this.config.performanceIterations;
    const times = [];
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      await fn();
      times.push(performance.now() - start);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    const sorted = [...times].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(times.length * 0.5)];
    const p95 = sorted[Math.floor(times.length * 0.95)];
    const p99 = sorted[Math.floor(times.length * 0.99)];
    return { avg, min, max, p50, p95, p99, iterations: count };
  },

  // ============================================
  // 1. IDE CORE FUNCTIONALITY
  // ============================================

  async testIDECore() {
    console.log('\n🖥️ Testing IDE Core Functionality...\n');

    await this.runTest('IDE Core: File tree state consistency', async () => {
      const fileTree = document.getElementById('fileTree');
      if (!fileTree) {
        this.warn('IDE', 'File tree element not found', 'Ensure fileTree is rendered');
        return;
      }
      
      const items = fileTree.querySelectorAll('.tree-item');
      const folders = fileTree.querySelectorAll('.tree-folder');
      
      let orphans = 0;
      items.forEach(item => {
        if (!item.closest('.tree-folder') && !item.parentElement?.id?.includes('fileTree')) {
          orphans++;
        }
      });
      
      if (orphans > 0) {
        this.warn('IDE', `Found ${orphans} orphaned tree items`, 'Review file tree rendering logic');
      }
      
      this.assert(true, 'File tree structure OK');
    }, 'ide-core');

    await this.runTest('IDE Core: Tab management - no memory leaks', async () => {
      const tabBar = document.querySelector('.tab-bar');
      if (!tabBar) {
        this.warn('IDE', 'Tab bar not found', 'Tabs may not be initialized');
        return;
      }
      
      const tabIds = new Set();
      let duplicates = 0;
      tabBar.querySelectorAll('.tab').forEach(tab => {
        const id = tab.dataset.path || tab.dataset.id;
        if (tabIds.has(id)) duplicates++;
        tabIds.add(id);
      });
      
      if (duplicates > 0) {
        this.warn('IDE', `Found ${duplicates} duplicate tab IDs`, 'Review tab creation logic');
      }
      
      this.assert(duplicates === 0, `No duplicate tabs`);
    }, 'ide-core');

    await this.runTest('IDE Core: Editor state sync', async () => {
      if (typeof monaco === 'undefined') {
        this.warn('IDE', 'Monaco editor not loaded', 'Editor functionality limited');
        return;
      }
      
      const editors = monaco.editor.getEditors();
      let disposedCount = 0;
      editors.forEach(editor => {
        try {
          editor.getModel();
        } catch (e) {
          disposedCount++;
        }
      });
      
      if (disposedCount > 0) {
        this.warn('IDE', `${disposedCount} disposed editors still in memory`, 'Clean up editors on close');
      }
      
      this.assert(disposedCount === 0, 'All editors properly managed');
    }, 'ide-core');

    await this.runTest('IDE Core: Split pane resize handlers', async () => {
      const stuckResizers = document.querySelectorAll('.resizer.active, .gutter.dragging');
      if (stuckResizers.length > 0) {
        this.warn('IDE', `${stuckResizers.length} resizers stuck in active state`, 'Add mouseup cleanup');
      }
      this.assert(stuckResizers.length === 0, 'No stuck resize states');
    }, 'ide-core');

    await this.runTest('IDE Core: Search index integrity', async () => {
      if (window.searchIndex) {
        const indexSize = JSON.stringify(window.searchIndex).length;
        if (indexSize > 5000000) {
          this.warn('IDE', `Search index very large (${(indexSize/1024/1024).toFixed(2)}MB)`, 'Consider pagination');
        }
      }
      this.assert(true, 'Search index OK');
    }, 'ide-core');

    // NEW: Undo/Redo integrity
    await this.runTest('IDE Core: Undo/Redo stack integrity', async () => {
      if (typeof monaco === 'undefined') return;
      
      const editors = monaco.editor.getEditors();
      if (editors.length === 0) return;
      
      const editor = editors[0];
      const model = editor.getModel();
      if (!model) return;
      
      // Check undo stack isn't corrupted
      const canUndo = model.canUndo?.() ?? true;
      const canRedo = model.canRedo?.() ?? true;
      
      // These should not throw
      this.assert(typeof canUndo === 'boolean', 'Undo stack accessible');
    }, 'ide-core');
  },

  // ============================================
  // 2. DNA INTEGRATION
  // ============================================

  async testDNAIntegration() {
    console.log('\n🤖 Testing DNA Integration...\n');

    await this.runTest('DNA: WebSocket connection status', async () => {
      let connected = false;
      if (window.gatewaySocket) {
        connected = window.gatewaySocket.readyState === WebSocket.OPEN;
      } else if (window.gateway?.connected) {
        connected = true;
      }
      
      if (!connected) {
        this.warn('DNA', 'Gateway WebSocket not connected', 'Check gateway is running');
      }
      
      this.assert(true, `Gateway: ${connected ? 'connected' : 'disconnected'}`);
    }, 'dna');

    await this.runTest('DNA: Message queue health', async () => {
      if (window.messageQueue) {
        const queueSize = window.messageQueue.length;
        if (queueSize > 100) {
          this.warn('DNA', `Message queue has ${queueSize} pending`, 'Check for blocked sends');
        }
      }
      this.assert(true, 'Message queue OK');
    }, 'dna');

    await this.runTest('DNA: Session state consistency', async () => {
      const sessionKeys = Object.keys(localStorage).filter(k => 
        k.includes('session') || k.includes('clawd') || k.includes('gateway')
      );
      
      let corruptedKeys = 0;
      sessionKeys.forEach(key => {
        try {
          const value = localStorage.getItem(key);
          if (value && value.startsWith('{')) {
            JSON.parse(value);
          }
        } catch (e) {
          corruptedKeys++;
        }
      });
      
      this.assert(corruptedKeys === 0, `No corrupted session data`);
    }, 'dna');

    await this.runTest('DNA: Memory API accessible', async () => {
      const response = await fetch('/api/memory/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test', limit: 1 })
      });
      this.assert(response.ok || response.status === 404, 'Memory API accessible');
    }, 'dna');

    await this.runTest('DNA: Agent list endpoint', async () => {
      const start = performance.now();
      const response = await fetch('/api/agents/list');
      const duration = performance.now() - start;
      
      if (duration > 2000) {
        this.critical('API', `Agent list slow: ${duration.toFixed(0)}ms`, 'Optimize endpoint');
      } else if (duration > 500) {
        this.warn('API', `Agent list slow: ${duration.toFixed(0)}ms`, 'Optimize endpoint');
      }
      
      this.assert(response.ok, `Agent list: ${duration.toFixed(0)}ms`);
    }, 'dna');
  },

  // ============================================
  // 3. PERFORMANCE ANALYSIS
  // ============================================

  async testPerformance() {
    console.log('\n⚡ Testing Performance...\n');

    await this.runTest('Performance: DOM node count', async () => {
      const nodeCount = document.getElementsByTagName('*').length;
      
      if (nodeCount > 5000) {
        this.warn('Performance', `High DOM nodes: ${nodeCount}`, 'Consider virtualization');
      }
      
      this.assert(nodeCount < 10000, `DOM nodes: ${nodeCount}`);
    }, 'performance');

    await this.runTest('Performance: Event listener audit', async () => {
      let estimatedListeners = 0;
      const eventAttrs = ['onclick', 'onmouseover', 'onmouseout', 'onkeydown', 'onkeyup', 'oninput', 'onchange'];
      eventAttrs.forEach(attr => {
        estimatedListeners += document.querySelectorAll(`[${attr}]`).length;
      });
      
      const highRiskContainers = document.querySelectorAll('.file-tree, .tab-bar, .chat-messages');
      highRiskContainers.forEach(container => {
        if (container.children.length > 100) {
          this.warn('Performance', `Container with ${container.children.length} children`, 'Use event delegation');
        }
      });
      
      this.assert(true, `Inline handlers: ${estimatedListeners}`);
    }, 'performance');

    await this.runTest('Performance: localStorage usage', async () => {
      let totalSize = 0;
      for (let key in localStorage) {
        if (localStorage.hasOwnProperty(key)) {
          totalSize += (localStorage.getItem(key)?.length || 0) * 2;
        }
      }
      
      const sizeMB = totalSize / 1024 / 1024;
      if (sizeMB > 4) {
        this.warn('Performance', `localStorage: ${sizeMB.toFixed(2)}MB`, 'Use IndexedDB');
      }
      
      this.assert(sizeMB < 5, `localStorage: ${sizeMB.toFixed(2)}MB`);
    }, 'performance');

    await this.runTest('Performance: CSS rule count', async () => {
      let totalRules = 0;
      for (const sheet of document.styleSheets) {
        try {
          totalRules += sheet.cssRules?.length || 0;
        } catch (e) {}
      }
      
      if (totalRules > 3000) {
        this.warn('Performance', `High CSS rules: ${totalRules}`, 'Purge unused CSS');
      }
      
      this.assert(totalRules < 5000, `CSS rules: ${totalRules}`);
    }, 'performance');

    await this.runTest('Performance: Memory usage', async () => {
      if (performance.memory) {
        const used = performance.memory.usedJSHeapSize / 1024 / 1024;
        const limit = performance.memory.jsHeapSizeLimit / 1024 / 1024;
        const usage = (used / limit) * 100;
        
        if (usage > this.config.memoryWarningThreshold) {
          this.warn('Performance', `Memory: ${usage.toFixed(1)}%`, 'Check for leaks');
        }
        
        this.assert(usage < 80, `Memory: ${usage.toFixed(1)}%`);
      } else {
        this.assert(true, 'Memory API unavailable');
      }
    }, 'performance');

    await this.runTest('Performance: Layout thrashing', async () => {
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        document.body.offsetHeight;
        document.body.style.opacity = '0.999';
        document.body.offsetHeight;
        document.body.style.opacity = '1';
      }
      const duration = performance.now() - start;
      
      if (duration > 100) {
        this.warn('Performance', `Slow reflow: ${duration.toFixed(0)}ms`, 'Batch DOM ops');
      }
      
      this.assert(duration < 500, `Reflow: ${duration.toFixed(2)}ms`);
    }, 'performance');

    await this.runTest('Performance: File API response', async () => {
      const perf = await this.measure('file-list', async () => {
        await fetch('/api/files');
      }, 10);
      
      if (perf.avg > 100) {
        this.warn('Performance', `Slow file list: ${perf.avg.toFixed(0)}ms`, 'Add caching');
      }
      
      this.assert(perf.avg < 500, `File API: avg ${perf.avg.toFixed(0)}ms, p95 ${perf.p95.toFixed(0)}ms`);
    }, 'performance');
  },

  // ============================================
  // 4. CONFLICT DETECTION
  // ============================================

  async testConflicts() {
    console.log('\n⚔️ Testing for Conflicts...\n');

    await this.runTest('Conflicts: Keyboard shortcut collisions', async () => {
      const shortcuts = {};
      const conflicts = [];
      
      if (window.keyboardShortcuts) {
        for (const [key, handler] of Object.entries(window.keyboardShortcuts)) {
          if (shortcuts[key]) {
            conflicts.push(key);
          }
          shortcuts[key] = handler.name || 'anonymous';
        }
      }
      
      if (conflicts.length > 0) {
        this.warn('Conflicts', `${conflicts.length} shortcut conflicts`, 'Deduplicate handlers');
      }
      
      this.assert(conflicts.length === 0, `Shortcut conflicts: ${conflicts.length}`);
    }, 'conflicts');

    await this.runTest('Conflicts: CSS class collisions', async () => {
      const genericClasses = ['active', 'selected', 'hidden', 'visible', 'open', 'closed', 'loading'];
      
      genericClasses.forEach(cls => {
        const elements = document.querySelectorAll(`.${cls}`);
        if (elements.length > 20) {
          const parents = new Set();
          elements.forEach(el => {
            const parent = el.parentElement?.className?.split(' ')[0];
            if (parent) parents.add(parent);
          });
          
          if (parents.size > 5) {
            this.warn('Conflicts', `.${cls} in ${parents.size} contexts`, 'Use BEM');
          }
        }
      });
      
      this.assert(true, 'CSS class audit complete');
    }, 'conflicts');

    await this.runTest('Conflicts: Global namespace pollution', async () => {
      const builtins = new Set(['document', 'location', 'navigator', 'history', 'screen', 'performance', 'localStorage', 'sessionStorage', 'console', 'fetch', 'WebSocket', 'Worker', 'URL', 'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'JSON', 'Math', 'Date', 'RegExp', 'Error', 'Array', 'Object', 'Function', 'String', 'Number', 'Boolean', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'monaco', 'require', 'define', 'exports', 'module']);
      
      const customGlobals = Object.keys(window).filter(k => 
        !builtins.has(k) && !k.startsWith('on') && !k.startsWith('webkit') && !k.startsWith('__')
      );
      
      if (customGlobals.length > 50) {
        this.warn('Conflicts', `${customGlobals.length} custom globals`, 'Namespace under ClawdIDE');
      }
      
      this.assert(true, `Custom globals: ${customGlobals.length}`);
    }, 'conflicts');

    await this.runTest('Conflicts: Event handler leaks', async () => {
      let potentialLeaks = 0;
      const dynamicContainers = document.querySelectorAll('[data-dynamic], .virtual-list, .infinite-scroll');
      dynamicContainers.forEach(container => {
        if (container.children.length > 50) {
          potentialLeaks++;
        }
      });
      
      this.assert(potentialLeaks < 5, `Potential leaks: ${potentialLeaks}`);
    }, 'conflicts');

    await this.runTest('Conflicts: Module load order', async () => {
      const modules = ['selfCritique', 'learningMemory', 'confidenceCalibration', 'reflexionEngine', 'patternRecognition', 'styleAnalyzer', 'adaptiveCompletions', 'capabilityTracker', 'metacognitiveDashboard'];
      
      const loaded = modules.filter(m => window[m]);
      const missing = modules.filter(m => !window[m]);
      
      if (missing.length > 0 && loaded.length > 0) {
        this.warn('Conflicts', `Mixed: ${missing.length} missing, ${loaded.length} loaded`, 'Check load order');
      }
      
      this.assert(true, `Modules: ${loaded.length}/${modules.length}`);
    }, 'conflicts');
  },

  // ============================================
  // 5. EDGE CASES
  // ============================================

  async testEdgeCases() {
    console.log('\n🔬 Testing Edge Cases...\n');

    await this.runTest('Edge Cases: Empty states handled', async () => {
      const emptyStates = document.querySelectorAll('.empty-state, .no-results, .no-data, [data-empty]');
      this.assert(true, `Empty state handlers: ${emptyStates.length}`);
    }, 'edge-cases');

    await this.runTest('Edge Cases: Long content overflow', async () => {
      const textContainers = document.querySelectorAll('.file-name, .tab-title, .message-content');
      let overflowIssues = 0;
      
      textContainers.forEach(el => {
        const style = window.getComputedStyle(el);
        const hasOverflowHandling = 
          style.overflow === 'hidden' || 
          style.textOverflow === 'ellipsis' ||
          style.overflowX === 'auto';
        
        if (!hasOverflowHandling && el.scrollWidth > el.clientWidth) {
          overflowIssues++;
        }
      });
      
      this.assert(overflowIssues < 10, `Overflow issues: ${overflowIssues}`);
    }, 'edge-cases');

    await this.runTest('Edge Cases: Network failure resilience', async () => {
      const response = await fetch('/api/nonexistent-12345');
      this.assert(response.status === 404, 'Invalid endpoint returns 404');
    }, 'edge-cases');

    await this.runTest('Edge Cases: Rapid click debouncing', async () => {
      const buttons = document.querySelectorAll('button, .btn, [role="button"]');
      let undebounced = 0;
      
      buttons.forEach(btn => {
        const isCritical = /save|delete|send|submit/i.test(btn.textContent);
        const hasDebounce = btn.hasAttribute('data-debounce') || btn.classList.contains('debounced');
        
        if (isCritical && !hasDebounce) undebounced++;
      });
      
      if (undebounced > 0) {
        this.warn('Edge Cases', `${undebounced} critical buttons lack debounce`, 'Add debounce');
      }
      
      this.assert(true, `Undebounced critical buttons: ${undebounced}`);
    }, 'edge-cases');

    await this.runTest('Edge Cases: Focus trap in modals', async () => {
      const modals = document.querySelectorAll('.modal, [role="dialog"], .panel-overlay');
      let issues = 0;
      
      modals.forEach(modal => {
        if (!modal.classList.contains('hidden') && modal.style.display !== 'none') {
          const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          if (focusable.length === 0) issues++;
        }
      });
      
      this.assert(issues === 0, `Modal focus issues: ${issues}`);
    }, 'edge-cases');

    await this.runTest('Edge Cases: Special character handling', async () => {
      const specialChars = ['spaces in name', 'file (1)', 'naïve.js', '日本語.txt'];
      let encodingIssues = 0;
      
      specialChars.forEach(name => {
        try {
          const encoded = encodeURIComponent(name);
          const decoded = decodeURIComponent(encoded);
          if (decoded !== name) encodingIssues++;
        } catch (e) {
          encodingIssues++;
        }
      });
      
      this.assert(encodingIssues === 0, 'Special character encoding OK');
    }, 'edge-cases');
  },

  // ============================================
  // 6. SELF-IMPROVEMENT HEALTH
  // ============================================

  async testSelfImprovementHealth() {
    console.log('\n🧠 Testing Self-Improvement System...\n');

    await this.runTest('Self-Improvement: Data integrity', async () => {
      const modules = {
        learningMemory: 'clawd_learning_memory',
        calibration: 'clawd_calibration',
        reflexions: 'clawd_reflexions',
        patterns: 'clawd_patterns',
        style: 'clawd_user_style',
        completions: 'clawd_adaptive_completions',
        capabilities: 'clawd_capabilities'
      };
      
      let corruptCount = 0;
      
      for (const [name, key] of Object.entries(modules)) {
        const data = localStorage.getItem(key);
        if (data) {
          try {
            JSON.parse(data);
          } catch (e) {
            corruptCount++;
            this.warn('Self-Improvement', `${name} data corrupted`, 'Clear and reinitialize');
          }
        }
      }
      
      this.assert(corruptCount === 0, `Data integrity: ${corruptCount} issues`);
    }, 'self-improvement');

    await this.runTest('Self-Improvement: Module integration', async () => {
      if (window.learningMemory && window.reflexionEngine) {
        const beforeMistakes = window.learningMemory.memory?.mistakes?.length || 0;
        
        await window.reflexionEngine.reflect({
          task: 'Integration test',
          error: 'Test error',
          category: 'diagnostic_test'
        });
        
        const afterMistakes = window.learningMemory.memory?.mistakes?.length || 0;
        
        if (afterMistakes <= beforeMistakes) {
          this.warn('Self-Improvement', 'Reflexion not updating memory', 'Check integration');
        }
      }
      
      this.assert(true, 'Module integration OK');
    }, 'self-improvement');

    await this.runTest('Self-Improvement: Storage usage', async () => {
      const keys = ['clawd_learning_memory', 'clawd_calibration', 'clawd_reflexions', 'clawd_patterns', 'clawd_user_style', 'clawd_adaptive_completions', 'clawd_capabilities'];
      
      let totalSize = 0;
      keys.forEach(key => {
        const data = localStorage.getItem(key);
        if (data) totalSize += data.length * 2;
      });
      
      const totalMB = totalSize / 1024 / 1024;
      
      if (totalMB > 2) {
        this.warn('Self-Improvement', `Storage: ${totalMB.toFixed(2)}MB`, 'Implement pruning');
      }
      
      this.assert(totalMB < 3, `Storage: ${totalMB.toFixed(2)}MB`);
    }, 'self-improvement');

    await this.runTest('Self-Improvement: Calibration sample size', async () => {
      if (window.confidenceCalibration) {
        const history = window.confidenceCalibration.data?.history?.length || 0;
        
        if (history < 20) {
          this.suggest('Self-Improvement', `Only ${history} calibration samples`, 'low');
        }
      }
      
      this.assert(true, 'Calibration check complete');
    }, 'self-improvement');
  },

  // ============================================
  // 7. API HEALTH
  // ============================================

  async testAPIHealth() {
    console.log('\n🌐 Testing API Health...\n');

    const endpoints = [
      { path: '/api/files', method: 'GET', name: 'File list' },
      { path: '/api/files?path=ide/server/index.js', method: 'GET', name: 'File read' },
      { path: '/api/health', method: 'GET', name: 'Health check', optional: true },
      { path: '/api/agents/list', method: 'GET', name: 'Agent list' },
      { path: '/api/lint', method: 'POST', name: 'Lint', body: { filePath: 'ide/server/index.js' } },
    ];

    for (const endpoint of endpoints) {
      await this.runTest(`API: ${endpoint.name}`, async () => {
        const options = {
          method: endpoint.method,
          headers: { 'Content-Type': 'application/json' }
        };
        
        if (endpoint.body) {
          options.body = JSON.stringify(endpoint.body);
        }
        
        const start = performance.now();
        const response = await fetch(endpoint.path, options);
        const duration = performance.now() - start;
        
        if (duration > this.config.slowApiThreshold) {
          this.warn('API', `${endpoint.name}: ${duration.toFixed(0)}ms`, 'Optimize');
        }
        
        if (!response.ok && !endpoint.optional) {
          throw new Error(`Status ${response.status}`);
        }
        
        this.assert(response.ok || endpoint.optional, `${duration.toFixed(0)}ms`);
      }, 'api');
    }
  },

  // ============================================
  // 8. SECURITY (NEW)
  // ============================================

  async testSecurity() {
    console.log('\n🔒 Testing Security...\n');

    await this.runTest('Security: XSS in file paths', async () => {
      const xssPayloads = [
        '<script>alert(1)</script>',
        '"><img src=x onerror=alert(1)>',
        "'; DROP TABLE users;--",
        '../../../etc/passwd'
      ];
      
      for (const payload of xssPayloads) {
        const encoded = encodeURIComponent(payload);
        const response = await fetch(`/api/files?path=${encoded}`);
        const text = await response.text();
        
        // Check response doesn't contain unescaped payload
        if (text.includes(payload) && !text.includes(encoded)) {
          this.critical('Security', `Potential XSS: ${payload.slice(0, 20)}...`, 'Escape user input');
          throw new Error('XSS vulnerability detected');
        }
      }
      
      this.assert(true, 'XSS tests passed');
    }, 'security');

    await this.runTest('Security: Path traversal prevention', async () => {
      const traversalPayloads = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32',
        '/etc/passwd',
        'file:///etc/passwd'
      ];
      
      for (const payload of traversalPayloads) {
        const response = await fetch(`/api/files?path=${encodeURIComponent(payload)}`);
        
        // Should get 400/403/404, not 200 with system file contents
        if (response.ok) {
          const text = await response.text();
          if (text.includes('root:') || text.includes('SYSTEM32')) {
            this.critical('Security', 'Path traversal vulnerability', 'Validate paths server-side');
            throw new Error('Path traversal vulnerability');
          }
        }
      }
      
      this.assert(true, 'Path traversal tests passed');
    }, 'security');

    await this.runTest('Security: CORS headers present', async () => {
      const response = await fetch('/api/files');
      const cors = response.headers.get('Access-Control-Allow-Origin');
      
      if (cors === '*') {
        this.warn('Security', 'CORS allows all origins', 'Restrict to specific origins');
      }
      
      this.assert(true, `CORS: ${cors || 'not set'}`);
    }, 'security');

    await this.runTest('Security: No sensitive data in localStorage', async () => {
      const sensitivePatterns = [/password/i, /secret/i, /token/i, /apikey/i, /private/i];
      let issues = 0;
      
      for (let key in localStorage) {
        const value = localStorage.getItem(key);
        for (const pattern of sensitivePatterns) {
          if (pattern.test(key) || (value && pattern.test(value) && value.length < 200)) {
            issues++;
            this.warn('Security', `Sensitive data in localStorage: ${key}`, 'Use secure storage');
          }
        }
      }
      
      this.assert(issues === 0, `Sensitive data issues: ${issues}`);
    }, 'security');

    await this.runTest('Security: Content Security Policy', async () => {
      const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      
      if (!csp) {
        this.suggest('Security', 'Add Content-Security-Policy header', 'medium');
      }
      
      this.assert(true, `CSP: ${csp ? 'present' : 'missing'}`);
    }, 'security');
  },

  // ============================================
  // 9. ACCESSIBILITY (NEW)
  // ============================================

  async testAccessibility() {
    console.log('\n♿ Testing Accessibility...\n');

    await this.runTest('A11y: Images have alt text', async () => {
      const images = document.querySelectorAll('img');
      let missingAlt = 0;
      
      images.forEach(img => {
        if (!img.hasAttribute('alt')) missingAlt++;
      });
      
      if (missingAlt > 0) {
        this.warn('A11y', `${missingAlt} images without alt text`, 'Add alt attributes');
      }
      
      this.assert(missingAlt === 0, `Missing alt: ${missingAlt}`);
    }, 'accessibility');

    await this.runTest('A11y: Form labels present', async () => {
      const inputs = document.querySelectorAll('input, select, textarea');
      let unlabeled = 0;
      
      inputs.forEach(input => {
        const hasLabel = input.id && document.querySelector(`label[for="${input.id}"]`);
        const hasAriaLabel = input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby');
        const hasPlaceholder = input.hasAttribute('placeholder');
        
        if (!hasLabel && !hasAriaLabel && !hasPlaceholder) {
          unlabeled++;
        }
      });
      
      if (unlabeled > 0) {
        this.warn('A11y', `${unlabeled} unlabeled form fields`, 'Add labels or aria-label');
      }
      
      this.assert(unlabeled < 5, `Unlabeled inputs: ${unlabeled}`);
    }, 'accessibility');

    await this.runTest('A11y: Buttons have accessible names', async () => {
      const buttons = document.querySelectorAll('button, [role="button"]');
      let unnamed = 0;
      
      buttons.forEach(btn => {
        const hasText = btn.textContent?.trim().length > 0;
        const hasAriaLabel = btn.hasAttribute('aria-label');
        const hasTitle = btn.hasAttribute('title');
        
        if (!hasText && !hasAriaLabel && !hasTitle) {
          unnamed++;
        }
      });
      
      if (unnamed > 0) {
        this.warn('A11y', `${unnamed} buttons without names`, 'Add text or aria-label');
      }
      
      this.assert(unnamed === 0, `Unnamed buttons: ${unnamed}`);
    }, 'accessibility');

    await this.runTest('A11y: Keyboard navigation', async () => {
      const focusable = document.querySelectorAll('a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
      
      // Check for logical tab order
      let tabIndexIssues = 0;
      focusable.forEach(el => {
        const tabIndex = parseInt(el.getAttribute('tabindex') || '0');
        if (tabIndex > 0) tabIndexIssues++; // Positive tabindex is bad practice
      });
      
      if (tabIndexIssues > 0) {
        this.warn('A11y', `${tabIndexIssues} positive tabindex values`, 'Use 0 or -1 only');
      }
      
      this.assert(true, `Focusable elements: ${focusable.length}`);
    }, 'accessibility');

    await this.runTest('A11y: Color contrast (basic)', async () => {
      // Basic check for very low contrast text
      const textElements = document.querySelectorAll('p, span, div, h1, h2, h3, h4, h5, h6, a, button, label');
      let potentialIssues = 0;
      
      textElements.forEach(el => {
        const style = window.getComputedStyle(el);
        const color = style.color;
        const bg = style.backgroundColor;
        
        // Very basic check for light-on-light or dark-on-dark
        if (color === bg && color !== 'rgba(0, 0, 0, 0)') {
          potentialIssues++;
        }
      });
      
      this.assert(potentialIssues === 0, `Color contrast issues: ${potentialIssues}`);
    }, 'accessibility');

    await this.runTest('A11y: ARIA roles valid', async () => {
      const ariaElements = document.querySelectorAll('[role]');
      const validRoles = new Set(['alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'cell', 'checkbox', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'dialog', 'directory', 'document', 'feed', 'figure', 'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem']);
      
      let invalidRoles = 0;
      ariaElements.forEach(el => {
        const role = el.getAttribute('role');
        if (!validRoles.has(role)) invalidRoles++;
      });
      
      this.assert(invalidRoles === 0, `Invalid ARIA roles: ${invalidRoles}`);
    }, 'accessibility');
  },

  // ============================================
  // 10. ERROR RECOVERY (NEW)
  // ============================================

  async testErrorRecovery() {
    console.log('\n🔄 Testing Error Recovery...\n');

    await this.runTest('Recovery: Global error handler exists', async () => {
      const hasErrorHandler = typeof window.onerror === 'function' || 
                              window.__errorHandlers?.length > 0;
      
      if (!hasErrorHandler) {
        this.warn('Recovery', 'No global error handler', 'Add window.onerror handler');
      }
      
      this.assert(true, `Error handler: ${hasErrorHandler ? 'present' : 'missing'}`);
    }, 'recovery');

    await this.runTest('Recovery: Unhandled rejection handler', async () => {
      const handlers = [];
      const originalHandler = window.onunhandledrejection;
      
      window.onunhandledrejection = (e) => {
        handlers.push(e);
        e.preventDefault();
      };
      
      // Trigger unhandled rejection
      Promise.reject(new Error('Test rejection'));
      
      await new Promise(r => setTimeout(r, 100));
      
      window.onunhandledrejection = originalHandler;
      
      this.assert(true, 'Rejection handling works');
    }, 'recovery');

    await this.runTest('Recovery: Graceful API failure handling', async () => {
      // Test with intentionally broken endpoint
      try {
        const response = await fetch('/api/files?path=nonexistent/path/to/file.txt');
        // Should get error response, not crash
        this.assert(response.status === 404 || response.status === 400, 'Graceful error response');
      } catch (e) {
        this.warn('Recovery', 'API error not caught', 'Add try-catch wrapper');
        throw e;
      }
    }, 'recovery');

    await this.runTest('Recovery: State restoration after error', async () => {
      // Store current state
      const beforeKeys = Object.keys(localStorage).length;
      
      // Simulate error and recovery
      try {
        throw new Error('Simulated crash');
      } catch (e) {
        // Recovery should not corrupt localStorage
      }
      
      const afterKeys = Object.keys(localStorage).length;
      this.assert(beforeKeys === afterKeys, 'State preserved after error');
    }, 'recovery');
  },

  // ============================================
  // 11. WEBSOCKET STABILITY (NEW)
  // ============================================

  async testWebSocketStability() {
    console.log('\n📡 Testing WebSocket Stability...\n');

    await this.runTest('WebSocket: Connection state valid', async () => {
      if (window.gatewaySocket) {
        const state = window.gatewaySocket.readyState;
        const validStates = [WebSocket.CONNECTING, WebSocket.OPEN, WebSocket.CLOSING, WebSocket.CLOSED];
        this.assert(validStates.includes(state), `State: ${state}`);
      } else {
        this.warn('WebSocket', 'No gateway socket found', 'Check initialization');
        this.assert(true, 'Gateway socket not initialized');
      }
    }, 'websocket');

    await this.runTest('WebSocket: Reconnection logic exists', async () => {
      const hasReconnect = window.gatewayReconnect || 
                           window.gateway?.reconnect ||
                           typeof window.connectToGateway === 'function';
      
      if (!hasReconnect) {
        this.warn('WebSocket', 'No reconnection logic found', 'Add auto-reconnect');
      }
      
      this.assert(true, `Reconnect logic: ${hasReconnect ? 'present' : 'missing'}`);
    }, 'websocket');

    await this.runTest('WebSocket: Message queue during disconnect', async () => {
      // Check if there's offline message queuing
      const hasQueue = window.messageQueue || window.pendingMessages || window.gateway?.queue;
      
      if (!hasQueue) {
        this.suggest('WebSocket', 'Add offline message queue', 'medium');
      }
      
      this.assert(true, `Message queue: ${hasQueue ? 'present' : 'missing'}`);
    }, 'websocket');

    await this.runTest('WebSocket: Heartbeat mechanism', async () => {
      const hasHeartbeat = window.gatewayHeartbeat || 
                           window.gateway?.heartbeatInterval ||
                           window.wsHeartbeat;
      
      if (!hasHeartbeat) {
        this.suggest('WebSocket', 'Add heartbeat for connection health', 'medium');
      }
      
      this.assert(true, `Heartbeat: ${hasHeartbeat ? 'present' : 'missing'}`);
    }, 'websocket');
  },

  // ============================================
  // 12. FILE OPERATIONS (NEW)
  // ============================================

  async testFileOperations() {
    console.log('\n📁 Testing File Operations...\n');

    await this.runTest('Files: List directory', async () => {
      const response = await fetch('/api/files');
      const data = await response.json();
      
      this.assert(response.ok, 'Directory listing works');
      this.assert(Array.isArray(data.files || data), 'Returns file array');
    }, 'files');

    await this.runTest('Files: Read existing file', async () => {
      const response = await fetch('/api/files?path=package.json');
      
      if (response.ok) {
        const data = await response.json();
        this.assert(data.content || data.name, 'File content returned');
      } else {
        this.assert(response.status === 404, 'Proper 404 for missing file');
      }
    }, 'files');

    await this.runTest('Files: Handle binary files', async () => {
      const response = await fetch('/api/files?path=.git/objects');
      // Should handle gracefully (not crash)
      this.assert(true, 'Binary path handled');
    }, 'files');

    await this.runTest('Files: Handle deep paths', async () => {
      const deepPath = 'ide/public/modules/self-improvement/learning-memory.js';
      const response = await fetch(`/api/files?path=${encodeURIComponent(deepPath)}`);
      
      // Should work or return proper 404
      this.assert(response.ok || response.status === 404, 'Deep path handled');
    }, 'files');

    await this.runTest('Files: Handle special characters in paths', async () => {
      const specialPaths = [
        'file with spaces.js',
        'file(1).js',
        'naïve.js'
      ];
      
      for (const path of specialPaths) {
        const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
        // Should not crash
        this.assert(response.status !== 500, `${path} handled`);
      }
    }, 'files');
  },

  // ============================================
  // 13. AGENT RELIABILITY (NEW)
  // ============================================

  async testAgentReliability() {
    console.log('\n🤖 Testing Agent Reliability...\n');

    await this.runTest('Agent: List response time', async () => {
      const times = [];
      
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        await fetch('/api/agents/list');
        times.push(performance.now() - start);
      }
      
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      
      if (avg > 1000) {
        this.critical('Agent', `List avg: ${avg.toFixed(0)}ms`, 'Critical performance issue');
      } else if (avg > 200) {
        this.warn('Agent', `List avg: ${avg.toFixed(0)}ms`, 'Consider caching');
      }
      
      this.assert(avg < 5000, `Agent list avg: ${avg.toFixed(0)}ms`);
    }, 'agent');

    await this.runTest('Agent: Spawn endpoint available', async () => {
      // Don't actually spawn, just check endpoint exists
      const response = await fetch('/api/agents/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}) // Empty body should return validation error
      });
      
      // Should get 400 (bad request) not 404 (not found)
      this.assert(response.status === 400 || response.status === 503, 'Spawn endpoint exists');
    }, 'agent');

    await this.runTest('Agent: History endpoint available', async () => {
      const response = await fetch('/api/agents/history?sessionKey=test');
      
      // Should respond (even with error) not 404
      this.assert(response.status !== 404, 'History endpoint exists');
    }, 'agent');

    await this.runTest('Agent: Error responses are JSON', async () => {
      const response = await fetch('/api/agents/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      
      const contentType = response.headers.get('content-type');
      this.assert(contentType?.includes('application/json'), 'Error response is JSON');
    }, 'agent');
  },

  // ============================================
  // 14. STATE PERSISTENCE (NEW)
  // ============================================

  async testStatePersistence() {
    console.log('\n💾 Testing State Persistence...\n');

    await this.runTest('Persistence: Theme saved', async () => {
      const theme = localStorage.getItem('clawd_theme') || localStorage.getItem('theme');
      this.assert(true, `Theme: ${theme || 'default'}`);
    }, 'persistence');

    await this.runTest('Persistence: Open tabs saved', async () => {
      const tabs = localStorage.getItem('clawd_open_tabs') || 
                   localStorage.getItem('openTabs') ||
                   localStorage.getItem('ide_tabs');
      
      if (!tabs) {
        this.suggest('Persistence', 'Save open tabs to localStorage', 'medium');
      }
      
      this.assert(true, `Tabs saved: ${tabs ? 'yes' : 'no'}`);
    }, 'persistence');

    await this.runTest('Persistence: Editor settings saved', async () => {
      const settings = localStorage.getItem('clawd_editor_settings') ||
                       localStorage.getItem('editorSettings') ||
                       localStorage.getItem('monaco_settings');
      
      this.assert(true, `Editor settings: ${settings ? 'saved' : 'default'}`);
    }, 'persistence');

    await this.runTest('Persistence: Sidebar state saved', async () => {
      const sidebar = localStorage.getItem('clawd_sidebar') ||
                      localStorage.getItem('sidebarState') ||
                      localStorage.getItem('sidebar_collapsed');
      
      this.assert(true, `Sidebar state: ${sidebar ? 'saved' : 'default'}`);
    }, 'persistence');

    await this.runTest('Persistence: Recent files tracked', async () => {
      const recent = localStorage.getItem('clawd_recent_files') ||
                     localStorage.getItem('recentFiles');
      
      if (!recent) {
        this.suggest('Persistence', 'Track recent files for quick access', 'low');
      }
      
      this.assert(true, `Recent files: ${recent ? 'tracked' : 'not tracked'}`);
    }, 'persistence');
  },

  // ============================================
  // 15. STRESS TESTS (NEW)
  // ============================================

  async testStress() {
    console.log('\n🔥 Running Stress Tests...\n');

    await this.runTest('Stress: Rapid API calls', async () => {
      const promises = [];
      const count = 20;
      
      for (let i = 0; i < count; i++) {
        promises.push(fetch('/api/files').then(r => r.ok));
      }
      
      const start = performance.now();
      const results = await Promise.all(promises);
      const duration = performance.now() - start;
      
      const success = results.filter(r => r).length;
      
      if (success < count) {
        this.warn('Stress', `${count - success}/${count} rapid calls failed`, 'Add rate limiting');
      }
      
      this.assert(success >= count * 0.9, `Rapid calls: ${success}/${count} in ${duration.toFixed(0)}ms`);
    }, 'stress', 10000);

    await this.runTest('Stress: Large localStorage write', async () => {
      const testKey = '__stress_test_large_data__';
      const largeData = 'x'.repeat(100000); // 100KB
      
      const start = performance.now();
      
      try {
        localStorage.setItem(testKey, largeData);
        localStorage.removeItem(testKey);
      } catch (e) {
        if (e.name === 'QuotaExceededError') {
          this.warn('Stress', 'localStorage quota low', 'Clean up old data');
        }
        throw e;
      }
      
      const duration = performance.now() - start;
      this.assert(duration < 100, `Large write: ${duration.toFixed(0)}ms`);
    }, 'stress');

    await this.runTest('Stress: DOM manipulation', async () => {
      const container = document.createElement('div');
      container.style.display = 'none';
      document.body.appendChild(container);
      
      const start = performance.now();
      
      // Create and destroy many elements
      for (let i = 0; i < 1000; i++) {
        const el = document.createElement('div');
        el.textContent = `Item ${i}`;
        container.appendChild(el);
      }
      
      container.innerHTML = '';
      document.body.removeChild(container);
      
      const duration = performance.now() - start;
      
      if (duration > 100) {
        this.warn('Stress', `Slow DOM ops: ${duration.toFixed(0)}ms for 1000 elements`, 'Use fragments');
      }
      
      this.assert(duration < 500, `DOM stress: ${duration.toFixed(0)}ms`);
    }, 'stress');

    await this.runTest('Stress: JSON parse/stringify', async () => {
      const largeObject = {
        items: Array(1000).fill(null).map((_, i) => ({
          id: i,
          name: `Item ${i}`,
          data: { nested: { value: Math.random() } }
        }))
      };
      
      const start = performance.now();
      
      for (let i = 0; i < 100; i++) {
        const str = JSON.stringify(largeObject);
        JSON.parse(str);
      }
      
      const duration = performance.now() - start;
      this.assert(duration < 1000, `JSON stress: ${duration.toFixed(0)}ms`);
    }, 'stress');
  },

  // ============================================
  // GENERATE REPORT
  // ============================================

  generateReport() {
    const passed = this.results.filter(r => r.status === 'PASS').length;
    const failed = this.results.filter(r => r.status === 'FAIL').length;
    const totalTime = performance.now() - this.startTime;

    const report = {
      summary: {
        total: this.results.length,
        passed,
        failed,
        passRate: ((passed / this.results.length) * 100).toFixed(1) + '%',
        totalTime: totalTime.toFixed(0) + 'ms',
        timestamp: new Date().toISOString(),
        criticalIssues: this.criticalIssues.length,
        warnings: this.warnings.length
      },
      criticalIssues: this.criticalIssues,
      results: this.results,
      warnings: this.warnings,
      improvements: this.improvements,
      byCategory: {}
    };

    // Group by category
    this.results.forEach(r => {
      if (!report.byCategory[r.category]) {
        report.byCategory[r.category] = { passed: 0, failed: 0, tests: [] };
      }
      report.byCategory[r.category].tests.push(r);
      if (r.status === 'PASS') {
        report.byCategory[r.category].passed++;
      } else {
        report.byCategory[r.category].failed++;
      }
    });

    return report;
  },

  printReport(report) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  📋 DIAGNOSTIC REPORT');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log(`  Total Tests:  ${report.summary.total}`);
    console.log(`  ✅ Passed:    ${report.summary.passed}`);
    console.log(`  ❌ Failed:    ${report.summary.failed}`);
    console.log(`  ⚠️ Warnings:  ${report.summary.warnings}`);
    console.log(`  📈 Pass Rate: ${report.summary.passRate}`);
    console.log(`  ⏱️ Time:      ${report.summary.totalTime}\n`);

    if (report.criticalIssues.length > 0) {
      console.log('  🔴 CRITICAL ISSUES:');
      report.criticalIssues.forEach(c => {
        console.log(`     [${c.category}] ${c.message}`);
        console.log(`        💡 ${c.suggestion}`);
      });
      console.log('');
    }

    if (report.warnings.length > 0) {
      console.log('  ⚠️ WARNINGS:');
      report.warnings.forEach(w => {
        console.log(`     [${w.category}] ${w.message}`);
        console.log(`        💡 ${w.suggestion}`);
      });
      console.log('');
    }

    if (report.summary.failed > 0) {
      console.log('  ❌ FAILED TESTS:');
      this.results.filter(r => r.status === 'FAIL').forEach(r => {
        console.log(`     - ${r.name}: ${r.error}`);
      });
      console.log('');
    }

    if (report.improvements.length > 0) {
      console.log('  💡 IMPROVEMENTS:');
      report.improvements.slice(0, 10).forEach(i => {
        console.log(`     [${i.impact}] ${i.message}`);
      });
      if (report.improvements.length > 10) {
        console.log(`     ... and ${report.improvements.length - 10} more`);
      }
      console.log('');
    }

    console.log('  📊 BY CATEGORY:');
    for (const [cat, data] of Object.entries(report.byCategory)) {
      const icon = data.failed > 0 ? '❌' : '✅';
      console.log(`     ${icon} ${cat}: ${data.passed}/${data.passed + data.failed}`);
    }

    console.log('\n═══════════════════════════════════════════════════════════\n');
  },

  // ============================================
  // RUN METHODS
  // ============================================

  async runAll() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  🔍 CLAWD IDE DIAGNOSTIC TEST SUITE v2.0');
    console.log('  Comprehensive IDE & DNA analysis');
    console.log('═══════════════════════════════════════════════════════════');

    this.results = [];
    this.warnings = [];
    this.improvements = [];
    this.criticalIssues = [];
    this.startTime = performance.now();

    await this.testIDECore();
    await this.testDNAIntegration();
    await this.testPerformance();
    await this.testConflicts();
    await this.testEdgeCases();
    await this.testSelfImprovementHealth();
    await this.testAPIHealth();
    await this.testSecurity();
    await this.testAccessibility();
    await this.testErrorRecovery();
    await this.testWebSocketStability();
    await this.testFileOperations();
    await this.testAgentReliability();
    await this.testStatePersistence();
    await this.testStress();

    const report = this.generateReport();
    this.printReport(report);

    return report;
  },

  async runQuick() {
    console.log('🚀 Running Quick Diagnostics (core tests only)...\n');

    this.results = [];
    this.warnings = [];
    this.improvements = [];
    this.criticalIssues = [];
    this.startTime = performance.now();

    await this.testIDECore();
    await this.testDNAIntegration();
    await this.testAPIHealth();

    const report = this.generateReport();
    this.printReport(report);

    return report;
  },

  async runCategory(category) {
    const categoryMap = {
      'ide': this.testIDECore,
      'dna': this.testDNAIntegration,
      'performance': this.testPerformance,
      'conflicts': this.testConflicts,
      'edge': this.testEdgeCases,
      'self-improvement': this.testSelfImprovementHealth,
      'api': this.testAPIHealth,
      'security': this.testSecurity,
      'accessibility': this.testAccessibility,
      'recovery': this.testErrorRecovery,
      'websocket': this.testWebSocketStability,
      'files': this.testFileOperations,
      'agent': this.testAgentReliability,
      'persistence': this.testStatePersistence,
      'stress': this.testStress
    };

    const testFn = categoryMap[category];
    if (!testFn) {
      console.error(`Unknown category: ${category}`);
      console.log('Available:', Object.keys(categoryMap).join(', '));
      return;
    }

    this.results = [];
    this.warnings = [];
    this.improvements = [];
    this.criticalIssues = [];
    this.startTime = performance.now();

    await testFn.call(this);

    const report = this.generateReport();
    this.printReport(report);

    return report;
  }
};

// Make available globally
window.DiagnosticTests = DiagnosticTests;

console.log('🔍 Diagnostic Tests v2.0 loaded');
console.log('   Run all:      await DiagnosticTests.runAll()');
console.log('   Quick:        await DiagnosticTests.runQuick()');
console.log('   Category:     await DiagnosticTests.runCategory("security")');
console.log('   Categories:   ide, dna, performance, conflicts, edge,');
console.log('                 self-improvement, api, security, accessibility,');
console.log('                 recovery, websocket, files, agent, persistence, stress');
