/**
 * STYLE ANALYZER MODULE
 * Phase 2: Learn user's coding style
 * 
 * Analyzes:
 * - Naming conventions
 * - Formatting preferences
 * - Import organization
 * - Comment style
 * - Error handling patterns
 */

class StyleAnalyzer {
  constructor() {
    this.storageKey = 'clawd_user_style';
    this.style = this.load();
    this.samplesAnalyzed = 0;
    
    console.log('[StyleAnalyzer] Initialized with style profile');
  }

  /**
   * Load style preferences
   */
  load() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) return JSON.parse(stored);
    } catch {}

    return {
      version: 1,
      lastUpdated: null,
      
      // Naming conventions
      naming: {
        variables: { camelCase: 0, snake_case: 0, PascalCase: 0 },
        functions: { camelCase: 0, snake_case: 0, PascalCase: 0 },
        constants: { UPPER_SNAKE: 0, camelCase: 0, PascalCase: 0 },
        classes: { PascalCase: 0, camelCase: 0 },
        preferred: {}
      },

      // Formatting
      formatting: {
        indentation: { spaces2: 0, spaces4: 0, tabs: 0 },
        quotes: { single: 0, double: 0, backtick: 0 },
        semicolons: { always: 0, never: 0, asi: 0 },
        trailingComma: { always: 0, never: 0, es5: 0 },
        bracketSpacing: { spaced: 0, compact: 0 },
        preferred: {}
      },

      // Imports
      imports: {
        style: { named: 0, default: 0, namespace: 0 },
        grouping: { grouped: 0, ungrouped: 0 },
        sorting: { alphabetical: 0, byType: 0, random: 0 },
        preferred: {}
      },

      // Comments
      comments: {
        style: { jsdoc: 0, inline: 0, block: 0 },
        frequency: { heavy: 0, moderate: 0, minimal: 0 },
        preferred: {}
      },

      // Error handling
      errorHandling: {
        style: { tryCatch: 0, promise: 0, callback: 0 },
        logging: { console: 0, custom: 0, none: 0 },
        preferred: {}
      },

      // Code patterns
      patterns: {
        async: { asyncAwait: 0, promises: 0, callbacks: 0 },
        loops: { forOf: 0, forEach: 0, forLoop: 0, map: 0 },
        conditionals: { ternary: 0, ifElse: 0, switch: 0 },
        preferred: {}
      },

      // Sample code snippets
      samples: []
    };
  }

  /**
   * Save style preferences
   */
  save() {
    this.style.lastUpdated = Date.now();
    localStorage.setItem(this.storageKey, JSON.stringify(this.style));
  }

  /**
   * Analyze a code sample
   */
  analyze(code, language = 'javascript') {
    if (!code || code.length < 50) return;

    this.samplesAnalyzed++;

    // Analyze naming
    this.analyzeNaming(code);

    // Analyze formatting
    this.analyzeFormatting(code);

    // Analyze imports
    this.analyzeImports(code);

    // Analyze comments
    this.analyzeComments(code);

    // Analyze error handling
    this.analyzeErrorHandling(code);

    // Analyze patterns
    this.analyzePatterns(code);

    // Store sample (limited)
    if (this.style.samples.length < 20 && code.length < 2000) {
      this.style.samples.push({
        code: code.slice(0, 500),
        timestamp: Date.now(),
        language
      });
    }

    // Update preferred styles
    this.updatePreferences();

    this.save();
  }

  /**
   * Analyze naming conventions
   */
  analyzeNaming(code) {
    // Variable declarations
    const varMatches = code.matchAll(/(?:const|let|var)\s+(\w+)/g);
    for (const match of varMatches) {
      const name = match[1];
      this.style.naming.variables[this.detectNamingStyle(name)]++;
    }

    // Function names
    const funcMatches = code.matchAll(/(?:function|const|let)\s+(\w+)\s*(?:=\s*(?:async\s*)?\(|\()/g);
    for (const match of funcMatches) {
      const name = match[1];
      this.style.naming.functions[this.detectNamingStyle(name)]++;
    }

    // Class names
    const classMatches = code.matchAll(/class\s+(\w+)/g);
    for (const match of classMatches) {
      const name = match[1];
      this.style.naming.classes[this.detectNamingStyle(name)]++;
    }
  }

  /**
   * Detect naming style
   */
  detectNamingStyle(name) {
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) return 'UPPER_SNAKE';
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return 'PascalCase';
    if (/^[a-z][a-zA-Z0-9]*$/.test(name)) return 'camelCase';
    if (/^[a-z][a-z0-9_]*$/.test(name)) return 'snake_case';
    return 'camelCase'; // default
  }

  /**
   * Analyze formatting preferences
   */
  analyzeFormatting(code) {
    const lines = code.split('\n');

    // Indentation
    for (const line of lines) {
      const indent = line.match(/^(\s+)/);
      if (indent) {
        if (indent[1].includes('\t')) {
          this.style.formatting.indentation.tabs++;
        } else if (indent[1].length % 4 === 0) {
          this.style.formatting.indentation.spaces4++;
        } else if (indent[1].length % 2 === 0) {
          this.style.formatting.indentation.spaces2++;
        }
      }
    }

    // Quotes
    const singleQuotes = (code.match(/'/g) || []).length;
    const doubleQuotes = (code.match(/"/g) || []).length;
    const backticks = (code.match(/`/g) || []).length;
    
    this.style.formatting.quotes.single += singleQuotes;
    this.style.formatting.quotes.double += doubleQuotes;
    this.style.formatting.quotes.backtick += backticks;

    // Semicolons
    const withSemi = (code.match(/;\s*$/gm) || []).length;
    const withoutSemi = lines.filter(l => l.trim() && !l.trim().endsWith(';') && !l.trim().endsWith('{') && !l.trim().endsWith(',')).length;
    
    if (withSemi > withoutSemi * 2) {
      this.style.formatting.semicolons.always++;
    } else if (withoutSemi > withSemi * 2) {
      this.style.formatting.semicolons.never++;
    } else {
      this.style.formatting.semicolons.asi++;
    }

    // Trailing commas
    const trailingComma = (code.match(/,\s*[\]\}]/g) || []).length;
    const noTrailingComma = (code.match(/[^\s,]\s*[\]\}]/g) || []).length;
    
    if (trailingComma > noTrailingComma) {
      this.style.formatting.trailingComma.always++;
    } else {
      this.style.formatting.trailingComma.never++;
    }

    // Bracket spacing
    const spacedBrackets = (code.match(/\{\s+\w|\w\s+\}/g) || []).length;
    const compactBrackets = (code.match(/\{\w|\w\}/g) || []).length;
    
    if (spacedBrackets > compactBrackets) {
      this.style.formatting.bracketSpacing.spaced++;
    } else {
      this.style.formatting.bracketSpacing.compact++;
    }
  }

  /**
   * Analyze import style
   */
  analyzeImports(code) {
    const imports = code.match(/^import\s+.+$/gm) || [];
    
    for (const imp of imports) {
      if (/import\s+\{/.test(imp)) {
        this.style.imports.style.named++;
      } else if (/import\s+\*/.test(imp)) {
        this.style.imports.style.namespace++;
      } else {
        this.style.imports.style.default++;
      }
    }

    // Check if imports are grouped (by blank lines or comments)
    const importBlock = code.match(/^(import\s+.+\n)+/m);
    if (importBlock) {
      const hasGroups = /\n\n|\n\/\//m.test(importBlock[0]);
      if (hasGroups) {
        this.style.imports.grouping.grouped++;
      } else {
        this.style.imports.grouping.ungrouped++;
      }
    }
  }

  /**
   * Analyze comment style
   */
  analyzeComments(code) {
    const jsdoc = (code.match(/\/\*\*[\s\S]*?\*\//g) || []).length;
    const blockComments = (code.match(/\/\*[^*][\s\S]*?\*\//g) || []).length;
    const inlineComments = (code.match(/\/\/.*/g) || []).length;
    
    this.style.comments.style.jsdoc += jsdoc;
    this.style.comments.style.block += blockComments;
    this.style.comments.style.inline += inlineComments;

    // Comment frequency
    const lines = code.split('\n').length;
    const totalComments = jsdoc + blockComments + inlineComments;
    const ratio = totalComments / lines;
    
    if (ratio > 0.2) {
      this.style.comments.frequency.heavy++;
    } else if (ratio > 0.05) {
      this.style.comments.frequency.moderate++;
    } else {
      this.style.comments.frequency.minimal++;
    }
  }

  /**
   * Analyze error handling style
   */
  analyzeErrorHandling(code) {
    const tryCatch = (code.match(/try\s*{/g) || []).length;
    const promiseCatch = (code.match(/\.catch\(/g) || []).length;
    const callbacks = (code.match(/\(err|error,/g) || []).length;
    
    this.style.errorHandling.style.tryCatch += tryCatch;
    this.style.errorHandling.style.promise += promiseCatch;
    this.style.errorHandling.style.callback += callbacks;

    // Logging style
    const consoleLog = (code.match(/console\.(log|error|warn)/g) || []).length;
    const customLog = (code.match(/logger\.|log\(/g) || []).length;
    
    this.style.errorHandling.logging.console += consoleLog;
    this.style.errorHandling.logging.custom += customLog;
  }

  /**
   * Analyze code patterns
   */
  analyzePatterns(code) {
    // Async patterns
    const asyncAwait = (code.match(/async|await/g) || []).length;
    const promises = (code.match(/\.then\(|new Promise/g) || []).length;
    
    this.style.patterns.async.asyncAwait += asyncAwait;
    this.style.patterns.async.promises += promises;

    // Loop patterns
    this.style.patterns.loops.forOf += (code.match(/for\s*\([^)]+of/g) || []).length;
    this.style.patterns.loops.forEach += (code.match(/\.forEach\(/g) || []).length;
    this.style.patterns.loops.forLoop += (code.match(/for\s*\([^)]+;/g) || []).length;
    this.style.patterns.loops.map += (code.match(/\.map\(/g) || []).length;

    // Conditional patterns
    this.style.patterns.conditionals.ternary += (code.match(/\?[^:]+:/g) || []).length;
    this.style.patterns.conditionals.ifElse += (code.match(/if\s*\(/g) || []).length;
    this.style.patterns.conditionals.switch += (code.match(/switch\s*\(/g) || []).length;
  }

  /**
   * Update preferred styles based on counts
   */
  updatePreferences() {
    // Helper to get max key
    const getMax = (obj) => {
      let maxKey = null;
      let maxVal = 0;
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === 'number' && val > maxVal) {
          maxKey = key;
          maxVal = val;
        }
      }
      return maxKey;
    };

    // Naming
    this.style.naming.preferred = {
      variables: getMax(this.style.naming.variables),
      functions: getMax(this.style.naming.functions),
      classes: getMax(this.style.naming.classes)
    };

    // Formatting
    this.style.formatting.preferred = {
      indentation: getMax(this.style.formatting.indentation),
      quotes: getMax(this.style.formatting.quotes),
      semicolons: getMax(this.style.formatting.semicolons),
      trailingComma: getMax(this.style.formatting.trailingComma)
    };

    // Imports
    const importStyle = getMax(this.style.imports.style);
    this.style.imports.preferred = {
      style: importStyle || 'named', // Default to 'named' if no data
      grouping: getMax(this.style.imports.grouping) || 'ungrouped'
    };

    // Comments
    this.style.comments.preferred = {
      style: getMax(this.style.comments.style),
      frequency: getMax(this.style.comments.frequency)
    };

    // Patterns
    this.style.patterns.preferred = {
      async: getMax(this.style.patterns.async),
      loops: getMax(this.style.patterns.loops),
      conditionals: getMax(this.style.patterns.conditionals)
    };
  }

  /**
   * Get style recommendations for code generation
   */
  getRecommendations() {
    return {
      naming: this.style.naming.preferred,
      formatting: this.style.formatting.preferred,
      imports: this.style.imports.preferred,
      comments: this.style.comments.preferred,
      patterns: this.style.patterns.preferred
    };
  }

  /**
   * Format code according to user style
   */
  formatToStyle(code) {
    let formatted = code;
    const prefs = this.style.formatting.preferred;

    // Apply quote preference
    if (prefs.quotes === 'single') {
      formatted = formatted.replace(/"/g, "'");
    } else if (prefs.quotes === 'double') {
      formatted = formatted.replace(/'/g, '"');
    }

    // Apply semicolon preference
    if (prefs.semicolons === 'always') {
      formatted = formatted.replace(/([^;{])\s*\n/g, '$1;\n');
    }

    return formatted;
  }

  /**
   * Get style summary for display
   */
  getSummary() {
    return {
      samplesAnalyzed: this.samplesAnalyzed,
      naming: this.style.naming.preferred,
      formatting: this.style.formatting.preferred,
      async: this.style.patterns.preferred.async,
      loops: this.style.patterns.preferred.loops,
      errorHandling: this.getPreferredErrorStyle()
    };
  }

  getPreferredErrorStyle() {
    const styles = this.style.errorHandling.style;
    if (styles.tryCatch > styles.promise && styles.tryCatch > styles.callback) {
      return 'try-catch';
    }
    if (styles.promise > styles.callback) {
      return 'promise-catch';
    }
    return 'callbacks';
  }

  /**
   * Export style profile
   */
  export() {
    return JSON.stringify(this.style, null, 2);
  }

  /**
   * Clear style data
   */
  clear() {
    localStorage.removeItem(this.storageKey);
    this.style = this.load();
  }
}

// Global instance
window.styleAnalyzer = new StyleAnalyzer();

// Export
if (typeof module !== 'undefined') {
  module.exports = { StyleAnalyzer };
}
