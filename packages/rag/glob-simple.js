'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Simple glob implementation supporting * and ** patterns.
 * Returns relative paths matching the pattern within rootDir.
 */
function glob(pattern, rootDir) {
  const parts = pattern.split('/');
  const results = [];
  _match(rootDir, parts, 0, '', results);
  return results;
}

function _match(baseDir, parts, partIdx, relPrefix, results) {
  if (partIdx >= parts.length) {
    const fullPath = path.join(baseDir, relPrefix);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        results.push(relPrefix);
      }
    } catch {}
    return;
  }

  const part = parts[partIdx];
  const currentDir = path.join(baseDir, relPrefix);

  if (part === '**') {
    // Match zero or more directories
    _match(baseDir, parts, partIdx + 1, relPrefix, results);

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          _match(baseDir, parts, partIdx, nextRel, results);
        }
      }
    } catch {}
  } else if (part.includes('*')) {
    // Wildcard match
    const regex = new RegExp('^' + part.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '$');
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (regex.test(entry.name)) {
          const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          if (partIdx === parts.length - 1) {
            if (entry.isFile()) {
              results.push(nextRel);
            }
          } else {
            if (entry.isDirectory()) {
              _match(baseDir, parts, partIdx + 1, nextRel, results);
            }
          }
        }
      }
    } catch {}
  } else {
    // Literal match
    const nextRel = relPrefix ? `${relPrefix}/${part}` : part;
    const nextPath = path.join(baseDir, nextRel);
    try {
      const stat = fs.statSync(nextPath);
      if (partIdx === parts.length - 1) {
        if (stat.isFile()) results.push(nextRel);
      } else {
        if (stat.isDirectory()) {
          _match(baseDir, parts, partIdx + 1, nextRel, results);
        }
      }
    } catch {}
  }
}

module.exports = { glob };
