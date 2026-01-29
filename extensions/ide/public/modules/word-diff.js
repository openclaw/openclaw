// ============================================
// WORD-LEVEL DIFF MODULE - Precise Change Highlighting
// ============================================
// Shows word-level changes instead of just line-level

const wordDiffState = {
  enabled: true,
};

/**
 * Initialize word diff module
 */
function initWordDiff() {
  const saved = localStorage.getItem('wordDiffEnabled');
  if (saved !== null) {
    wordDiffState.enabled = saved === 'true';
  }
  console.log('📝 Word diff initialized');
}

/**
 * Toggle word-level diffs
 */
function toggleWordDiff(enabled = null) {
  if (enabled === null) {
    wordDiffState.enabled = !wordDiffState.enabled;
  } else {
    wordDiffState.enabled = enabled;
  }
  
  localStorage.setItem('wordDiffEnabled', wordDiffState.enabled.toString());
  showNotification(
    wordDiffState.enabled ? '📝 Word-level diffs enabled' : '📝 Line-level diffs only',
    'info'
  );
  
  return wordDiffState.enabled;
}

/**
 * Compute word-level diff between two strings
 * @param {string} oldText - Original text
 * @param {string} newText - New text
 * @returns {Array} Array of diff operations
 */
function computeWordDiff(oldText, newText) {
  if (!oldText && !newText) return [];
  if (!oldText) return [{ type: 'add', value: newText }];
  if (!newText) return [{ type: 'remove', value: oldText }];
  
  // Tokenize into words (preserving whitespace)
  const oldWords = tokenize(oldText);
  const newWords = tokenize(newText);
  
  // Use Myers diff algorithm (simplified LCS-based)
  const diff = myersDiff(oldWords, newWords);
  
  return diff;
}

/**
 * Tokenize text into words, preserving whitespace as separate tokens
 * @param {string} text - Text to tokenize
 */
function tokenize(text) {
  // Split on word boundaries, keeping whitespace
  const tokens = [];
  let current = '';
  let inWord = false;
  
  for (const char of text) {
    const isWordChar = /\S/.test(char);
    
    if (isWordChar !== inWord) {
      if (current) tokens.push(current);
      current = char;
      inWord = isWordChar;
    } else {
      current += char;
    }
  }
  
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Myers diff algorithm (simplified)
 * @param {string[]} oldArr - Old tokens
 * @param {string[]} newArr - New tokens
 */
function myersDiff(oldArr, newArr) {
  const result = [];
  
  // Build LCS matrix
  const m = oldArr.length;
  const n = newArr.length;
  
  // Simple O(mn) LCS for correctness
  const lcs = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldArr[i - 1] === newArr[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }
  
  // Backtrack to find diff
  let i = m, j = n;
  const ops = [];
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldArr[i - 1] === newArr[j - 1]) {
      ops.unshift({ type: 'equal', value: oldArr[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      ops.unshift({ type: 'add', value: newArr[j - 1] });
      j--;
    } else {
      ops.unshift({ type: 'remove', value: oldArr[i - 1] });
      i--;
    }
  }
  
  // Merge consecutive operations of the same type
  for (const op of ops) {
    const last = result[result.length - 1];
    if (last && last.type === op.type) {
      last.value += op.value;
    } else {
      result.push({ ...op });
    }
  }
  
  return result;
}

/**
 * Render word diff as HTML
 * @param {string} oldText - Original text
 * @param {string} newText - New text
 * @returns {string} HTML with highlighted changes
 */
function renderWordDiffHTML(oldText, newText) {
  if (!wordDiffState.enabled) {
    // Fall back to line diff
    return renderLineDiffHTML(oldText, newText);
  }
  
  const diff = computeWordDiff(oldText, newText);
  let html = '';
  
  for (const op of diff) {
    const escaped = escapeHtml(op.value);
    switch (op.type) {
      case 'add':
        html += `<span class="word-diff-add">${escaped}</span>`;
        break;
      case 'remove':
        html += `<span class="word-diff-remove">${escaped}</span>`;
        break;
      default:
        html += escaped;
    }
  }
  
  return html;
}

/**
 * Render line diff as HTML (fallback)
 */
function renderLineDiffHTML(oldText, newText) {
  const oldLines = (oldText || '').split('\n');
  const newLines = (newText || '').split('\n');
  
  let html = '';
  const maxLines = Math.max(oldLines.length, newLines.length);
  
  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    
    if (oldLine === undefined) {
      html += `<div class="line-diff-add">+ ${escapeHtml(newLine)}</div>`;
    } else if (newLine === undefined) {
      html += `<div class="line-diff-remove">- ${escapeHtml(oldLine)}</div>`;
    } else if (oldLine !== newLine) {
      html += `<div class="line-diff-remove">- ${escapeHtml(oldLine)}</div>`;
      html += `<div class="line-diff-add">+ ${escapeHtml(newLine)}</div>`;
    } else {
      html += `<div class="line-diff-equal">  ${escapeHtml(oldLine)}</div>`;
    }
  }
  
  return html;
}

/**
 * Render inline word diff for a single line change
 * @param {string} oldLine - Original line
 * @param {string} newLine - New line
 */
function renderInlineWordDiff(oldLine, newLine) {
  if (!wordDiffState.enabled || oldLine === newLine) {
    return escapeHtml(newLine);
  }
  
  const diff = computeWordDiff(oldLine, newLine);
  let html = '';
  
  for (const op of diff) {
    const escaped = escapeHtml(op.value);
    switch (op.type) {
      case 'add':
        html += `<span class="inline-word-add">${escaped}</span>`;
        break;
      case 'remove':
        html += `<span class="inline-word-remove">${escaped}</span>`;
        break;
      default:
        html += escaped;
    }
  }
  
  return html;
}

/**
 * Create a side-by-side word diff view
 * @param {string} oldText - Original text
 * @param {string} newText - New text
 */
function createSideBySideWordDiff(oldText, newText) {
  const oldLines = (oldText || '').split('\n');
  const newLines = (newText || '').split('\n');
  
  // Align lines using LCS on line level first
  const lineOps = myersDiff(oldLines, newLines);
  
  let leftHTML = '';
  let rightHTML = '';
  let lineNum = { left: 1, right: 1 };
  
  for (const op of lineOps) {
    const lines = op.value.split('\n').filter(l => l !== '');
    
    for (const line of lines.length ? lines : ['']) {
      switch (op.type) {
        case 'remove':
          leftHTML += `<div class="diff-line removed"><span class="line-num">${lineNum.left++}</span>${escapeHtml(line)}</div>`;
          rightHTML += `<div class="diff-line empty"><span class="line-num"></span></div>`;
          break;
        case 'add':
          leftHTML += `<div class="diff-line empty"><span class="line-num"></span></div>`;
          rightHTML += `<div class="diff-line added"><span class="line-num">${lineNum.right++}</span>${escapeHtml(line)}</div>`;
          break;
        default:
          leftHTML += `<div class="diff-line"><span class="line-num">${lineNum.left++}</span>${escapeHtml(line)}</div>`;
          rightHTML += `<div class="diff-line"><span class="line-num">${lineNum.right++}</span>${escapeHtml(line)}</div>`;
      }
    }
  }
  
  return { left: leftHTML, right: rightHTML };
}

/**
 * Get diff statistics
 * @param {string} oldText - Original text
 * @param {string} newText - New text
 */
function getDiffStats(oldText, newText) {
  const diff = computeWordDiff(oldText, newText);
  
  let additions = 0;
  let deletions = 0;
  let unchanged = 0;
  
  for (const op of diff) {
    const words = op.value.split(/\s+/).filter(w => w).length;
    switch (op.type) {
      case 'add': additions += words; break;
      case 'remove': deletions += words; break;
      default: unchanged += words;
    }
  }
  
  return { additions, deletions, unchanged, total: additions + deletions + unchanged };
}

// Helper
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Export functions
window.initWordDiff = initWordDiff;
window.toggleWordDiff = toggleWordDiff;
window.computeWordDiff = computeWordDiff;
window.renderWordDiffHTML = renderWordDiffHTML;
window.renderInlineWordDiff = renderInlineWordDiff;
window.createSideBySideWordDiff = createSideBySideWordDiff;
window.getDiffStats = getDiffStats;

// Initialize on load
document.addEventListener('DOMContentLoaded', initWordDiff);
