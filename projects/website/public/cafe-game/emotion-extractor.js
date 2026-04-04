/**
 * Cafe Emotion Arc Extractor
 *
 * Converts Claude Code session JSONL data into emotional arcs
 * for driving lofi background music parameters.
 *
 * Works as:
 *   - Browser: window.CafeEmotionExtractor.extractArc(events)
 *   - Node.js: require('./emotion-extractor').extractArc(events)
 *   - CLI:     node emotion-extractor.js <path-to-session.jsonl>
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  var SAMPLE_INTERVAL_MS = 30000; // 30-second windows

  // Tool categories for creativity scoring
  var TOOL_CATEGORIES = {
    read:   ['Read', 'Glob', 'Grep'],
    write:  ['Edit', 'Write'],
    exec:   ['Bash'],
    search: ['ToolSearch', 'WebSearch', 'WebFetch'],
    skill:  ['Skill'],
    vcs:    ['NotebookEdit', 'EnterWorktree', 'ExitWorktree']
  };

  // Build reverse lookup: tool name -> category
  var toolToCategory = {};
  Object.keys(TOOL_CATEGORIES).forEach(function (cat) {
    TOOL_CATEGORIES[cat].forEach(function (name) {
      toolToCategory[name] = cat;
    });
  });

  function categorize(toolName) {
    if (toolToCategory[toolName]) return toolToCategory[toolName];
    if (/^mcp__/.test(toolName)) return 'mcp';
    return 'other';
  }

  // ---------------------------------------------------------------------------
  // Parsing helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse a single JSONL line into a normalized event.
   * Returns null for lines we don't care about.
   */
  function parseEvent(obj) {
    if (!obj || !obj.type) return null;

    var ts = obj.timestamp
      ? new Date(obj.timestamp).getTime()
      : null;

    var type = obj.type;        // 'user', 'assistant', 'system', 'queue-operation', etc.
    var role = (obj.message && obj.message.role) || '';
    var contentBlocks = [];

    if (obj.message && Array.isArray(obj.message.content)) {
      contentBlocks = obj.message.content;
    } else if (obj.message && typeof obj.message.content === 'string') {
      contentBlocks = [{ type: 'text', text: obj.message.content }];
    }

    // Extract structured info
    var toolUses = [];
    var toolResults = [];
    var textLength = 0;
    var hasThinking = false;

    contentBlocks.forEach(function (block) {
      if (block.type === 'tool_use') {
        toolUses.push({
          name: block.name || 'unknown',
          category: categorize(block.name || ''),
          inputKeys: block.input ? Object.keys(block.input) : []
        });
      } else if (block.type === 'tool_result') {
        var isErr = !!block.is_error;
        var contentStr = '';
        if (typeof block.content === 'string') {
          contentStr = block.content;
        } else if (Array.isArray(block.content)) {
          contentStr = block.content.map(function (c) { return c.text || ''; }).join('');
        }
        // Heuristic: detect errors in content even when is_error is false
        var looksLikeError = isErr ||
          /^Error:/i.test(contentStr) ||
          /command failed|ENOENT|permission denied|not found/i.test(contentStr.slice(0, 200));

        toolResults.push({
          isError: looksLikeError,
          contentLength: contentStr.length
        });
      } else if (block.type === 'text') {
        textLength += (block.text || '').length;
      } else if (block.type === 'thinking') {
        hasThinking = true;
        textLength += (block.thinking || '').length;
      }
    });

    // Skip events with no timestamp (file-history-snapshot, etc.)
    if (!ts) return null;

    return {
      ts: ts,
      type: type,
      role: role,
      toolUses: toolUses,
      toolResults: toolResults,
      textLength: textLength,
      hasThinking: hasThinking,
      toolCount: toolUses.length,
      errorCount: toolResults.filter(function (r) { return r.isError; }).length,
      successCount: toolResults.filter(function (r) { return !r.isError; }).length
    };
  }

  // ---------------------------------------------------------------------------
  // Window aggregation
  // ---------------------------------------------------------------------------

  /**
   * Group parsed events into time windows of SAMPLE_INTERVAL_MS.
   */
  function bucket(events, intervalMs) {
    if (!events.length) return [];

    var start = events[0].ts;
    var end = events[events.length - 1].ts;
    var buckets = [];
    var ei = 0;

    for (var wStart = start; wStart <= end; wStart += intervalMs) {
      var wEnd = wStart + intervalMs;
      var window = {
        tStart: wStart,
        tEnd: wEnd,
        events: []
      };
      while (ei < events.length && events[ei].ts < wEnd) {
        if (events[ei].ts >= wStart) {
          window.events.push(events[ei]);
        }
        ei++;
      }
      buckets.push(window);
    }

    return buckets;
  }

  // ---------------------------------------------------------------------------
  // Feature extraction per window
  // ---------------------------------------------------------------------------

  function computeWindowFeatures(win, prevWin) {
    var evts = win.events;
    if (!evts.length) {
      // Empty window — carry forward previous values with decay
      if (prevWin) {
        return {
          intensity: prevWin.intensity * 0.5,
          valence:   prevWin.valence,           // valence persists
          flow:      prevWin.flow * 0.7,        // flow decays slower
          tension:   prevWin.tension * 0.3,     // tension drops fast
          creativity: prevWin.creativity * 0.5
        };
      }
      return { intensity: 0, valence: 0.5, flow: 0, tension: 0, creativity: 0 };
    }

    // --- Intensity: token density + tool call frequency ---
    var totalText = 0;
    var totalToolCalls = 0;
    var totalEvents = evts.length;

    evts.forEach(function (e) {
      totalText += e.textLength;
      totalToolCalls += e.toolCount;
    });

    // Normalize: ~2000 chars/window and ~5 tools/window = intensity 0.5
    var textIntensity = Math.min(totalText / 4000, 1);
    var toolIntensity = Math.min(totalToolCalls / 10, 1);
    var eventDensity = Math.min(totalEvents / 20, 1);
    var intensity = textIntensity * 0.3 + toolIntensity * 0.4 + eventDensity * 0.3;

    // --- Valence: success/error ratio ---
    var successes = 0;
    var errors = 0;
    evts.forEach(function (e) {
      successes += e.successCount;
      errors += e.errorCount;
    });

    var valence;
    if (successes + errors === 0) {
      // No tool results — neutral, slight positive for thinking/text
      valence = 0.6;
    } else {
      valence = successes / (successes + errors);
    }

    // --- Flow: sustained code editing sequences without user interruption ---
    var assistantStreak = 0;
    var maxStreak = 0;
    var editToolCount = 0;
    var readToolCount = 0;

    evts.forEach(function (e) {
      if (e.role === 'assistant') {
        assistantStreak++;
        if (assistantStreak > maxStreak) maxStreak = assistantStreak;
        e.toolUses.forEach(function (tu) {
          if (tu.category === 'write') editToolCount++;
          if (tu.category === 'read') readToolCount++;
        });
      } else if (e.type === 'user' && e.role === 'user' && e.textLength > 10) {
        // Real user message (not tool_result) breaks flow
        assistantStreak = 0;
      }
    });

    // Flow is high when assistant is doing sustained work with edits
    var streakFlow = Math.min(maxStreak / 8, 1);
    var editFlow = Math.min(editToolCount / 3, 1);
    var flow = streakFlow * 0.5 + editFlow * 0.5;

    // Boost flow if previous window also had high flow (momentum)
    if (prevWin && prevWin.flow > 0.5) {
      flow = Math.min(flow * 1.2, 1);
    }

    // --- Tension: rapid back-and-forth, retries, error-fix cycles ---
    var roleFlips = 0;
    var lastRole = '';
    var retryPatterns = 0;

    evts.forEach(function (e, idx) {
      var currentRole = e.role || e.type;
      if (currentRole !== lastRole && lastRole !== '') {
        roleFlips++;
      }
      lastRole = currentRole;

      // Detect retry: error followed by same tool type
      if (e.errorCount > 0 && idx + 1 < evts.length) {
        retryPatterns++;
      }
    });

    var flipTension = Math.min(roleFlips / 10, 1);
    var errorTension = Math.min(errors / 3, 1);
    var retryTension = Math.min(retryPatterns / 2, 1);
    var tension = flipTension * 0.3 + errorTension * 0.4 + retryTension * 0.3;

    // --- Creativity: diversity of tool types, new file creation ---
    var categoriesSeen = {};
    var uniqueToolNames = {};

    evts.forEach(function (e) {
      e.toolUses.forEach(function (tu) {
        categoriesSeen[tu.category] = true;
        uniqueToolNames[tu.name] = true;
      });
    });

    var categoryCount = Object.keys(categoriesSeen).length;
    var uniqueToolCount = Object.keys(uniqueToolNames).length;

    // Check for Write/Edit tools (creating new things)
    var hasCreation = categoriesSeen.write ? 1 : 0;

    var diversityScore = Math.min(categoryCount / 5, 1);
    var toolBreadth = Math.min(uniqueToolCount / 6, 1);
    var creativity = diversityScore * 0.4 + toolBreadth * 0.3 + hasCreation * 0.3;

    return {
      intensity: clamp(intensity),
      valence:   clamp(valence),
      flow:      clamp(flow),
      tension:   clamp(tension),
      creativity: clamp(creativity)
    };
  }

  function clamp(v) {
    return Math.max(0, Math.min(1, v));
  }

  // ---------------------------------------------------------------------------
  // Smoothing
  // ---------------------------------------------------------------------------

  /**
   * Exponential moving average to smooth the arc.
   */
  function smoothArc(arc, alpha) {
    alpha = alpha || 0.3;
    var params = ['intensity', 'valence', 'flow', 'tension', 'creativity'];

    for (var i = 1; i < arc.length; i++) {
      params.forEach(function (p) {
        arc[i][p] = alpha * arc[i][p] + (1 - alpha) * arc[i - 1][p];
      });
    }
    return arc;
  }

  // ---------------------------------------------------------------------------
  // Main API
  // ---------------------------------------------------------------------------

  /**
   * Extract emotional arc from an array of raw JSONL-parsed objects.
   *
   * @param {Array<Object>} rawEvents - Array of parsed JSON objects from JSONL
   * @param {Object} [opts] - Options
   * @param {number} [opts.intervalMs=30000] - Sampling interval in ms
   * @param {number} [opts.smoothing=0.3] - EMA alpha (0 = max smooth, 1 = no smooth)
   * @returns {Array<{t: number, intensity: number, valence: number, flow: number, tension: number, creativity: number}>}
   */
  function extractArc(rawEvents, opts) {
    opts = opts || {};
    var intervalMs = opts.intervalMs || SAMPLE_INTERVAL_MS;
    var smoothingAlpha = opts.smoothing != null ? opts.smoothing : 0.3;

    // Parse and filter
    var parsed = [];
    rawEvents.forEach(function (raw) {
      var evt = parseEvent(raw);
      if (evt) parsed.push(evt);
    });

    // Sort by timestamp
    parsed.sort(function (a, b) { return a.ts - b.ts; });

    if (!parsed.length) return [];

    // Bucket into windows
    var windows = bucket(parsed, intervalMs);

    // Compute features per window
    var arc = [];
    var prevFeatures = null;

    windows.forEach(function (win, idx) {
      var features = computeWindowFeatures(win, prevFeatures);

      arc.push({
        t: (win.tStart - parsed[0].ts) / 1000, // seconds from session start
        intensity:  Math.round(features.intensity * 1000) / 1000,
        valence:    Math.round(features.valence * 1000) / 1000,
        flow:       Math.round(features.flow * 1000) / 1000,
        tension:    Math.round(features.tension * 1000) / 1000,
        creativity: Math.round(features.creativity * 1000) / 1000
      });

      prevFeatures = features;
    });

    // Smooth
    if (smoothingAlpha < 1 && arc.length > 1) {
      arc = smoothArc(arc, smoothingAlpha);
      // Re-round after smoothing
      arc.forEach(function (pt) {
        pt.intensity  = Math.round(pt.intensity * 1000) / 1000;
        pt.valence    = Math.round(pt.valence * 1000) / 1000;
        pt.flow       = Math.round(pt.flow * 1000) / 1000;
        pt.tension    = Math.round(pt.tension * 1000) / 1000;
        pt.creativity = Math.round(pt.creativity * 1000) / 1000;
      });
    }

    return arc;
  }

  /**
   * Summarize an arc into overall mood parameters for the lofi synth.
   *
   * Returns a single object describing the session's emotional signature:
   *   - tempo (60-120 BPM): derived from avg intensity
   *   - key: major if avg valence > 0.5, minor otherwise
   *   - reverb (0-1): inversely correlated with tension
   *   - filterCutoff (0-1): follows flow
   *   - chordComplexity (0-1): follows creativity
   *   - swingAmount (0-1): follows tension
   *   - peakMoment: timestamp of highest intensity
   *   - overallMood: string label
   *   - phases: array of {start, end, mood} segments
   */
  function summarizeArc(arc) {
    if (!arc || !arc.length) {
      return {
        tempo: 80,
        key: 'minor',
        reverb: 0.6,
        filterCutoff: 0.5,
        chordComplexity: 0.3,
        swingAmount: 0.1,
        peakMoment: 0,
        overallMood: 'idle',
        phases: []
      };
    }

    // Compute averages
    var sums = { intensity: 0, valence: 0, flow: 0, tension: 0, creativity: 0 };
    var peakIntensity = 0;
    var peakT = 0;

    arc.forEach(function (pt) {
      sums.intensity  += pt.intensity;
      sums.valence    += pt.valence;
      sums.flow       += pt.flow;
      sums.tension    += pt.tension;
      sums.creativity += pt.creativity;
      if (pt.intensity > peakIntensity) {
        peakIntensity = pt.intensity;
        peakT = pt.t;
      }
    });

    var n = arc.length;
    var avg = {
      intensity:  sums.intensity / n,
      valence:    sums.valence / n,
      flow:       sums.flow / n,
      tension:    sums.tension / n,
      creativity: sums.creativity / n
    };

    // Detect phases by dominant dimension
    var phases = [];
    var currentPhase = null;

    arc.forEach(function (pt) {
      var mood = classifyMood(pt);
      if (!currentPhase || currentPhase.mood !== mood) {
        if (currentPhase) {
          currentPhase.end = pt.t;
          phases.push(currentPhase);
        }
        currentPhase = { start: pt.t, end: pt.t, mood: mood };
      } else {
        currentPhase.end = pt.t;
      }
    });
    if (currentPhase) {
      phases.push(currentPhase);
    }

    // Merge tiny phases (< 60s) into neighbors
    phases = mergeShortPhases(phases, 60);

    return {
      tempo:           Math.round(60 + avg.intensity * 60),  // 60-120 BPM
      key:             avg.valence > 0.5 ? 'major' : 'minor',
      reverb:          Math.round((1 - avg.tension) * 1000) / 1000,
      filterCutoff:    Math.round(avg.flow * 1000) / 1000,
      chordComplexity: Math.round(avg.creativity * 1000) / 1000,
      swingAmount:     Math.round(avg.tension * 0.6 * 1000) / 1000,
      peakMoment:      peakT,
      overallMood:     classifyMood(avg),
      avgIntensity:    Math.round(avg.intensity * 1000) / 1000,
      avgValence:      Math.round(avg.valence * 1000) / 1000,
      avgFlow:         Math.round(avg.flow * 1000) / 1000,
      avgTension:      Math.round(avg.tension * 1000) / 1000,
      avgCreativity:   Math.round(avg.creativity * 1000) / 1000,
      durationSeconds: arc.length > 0 ? arc[arc.length - 1].t : 0,
      sampleCount:     arc.length,
      phases:          phases
    };
  }

  /**
   * Classify a single data point into a mood label.
   */
  function classifyMood(pt) {
    // Dominant dimension determines mood
    if (pt.tension > 0.6 && pt.tension > pt.flow)  return 'struggling';
    if (pt.flow > 0.5 && pt.valence > 0.5)         return 'deep-focus';
    if (pt.creativity > 0.5 && pt.intensity > 0.4)  return 'exploring';
    if (pt.intensity > 0.6)                         return 'intense';
    if (pt.valence > 0.7 && pt.intensity < 0.3)     return 'satisfied';
    if (pt.intensity < 0.15)                        return 'idle';
    if (pt.valence < 0.3)                           return 'frustrated';
    return 'steady';
  }

  /**
   * Merge phases shorter than minDuration into their neighbors.
   */
  function mergeShortPhases(phases, minDuration) {
    if (phases.length <= 1) return phases;
    var merged = [phases[0]];
    for (var i = 1; i < phases.length; i++) {
      var prev = merged[merged.length - 1];
      var curr = phases[i];
      if ((curr.end - curr.start) < minDuration) {
        // Absorb into previous
        prev.end = curr.end;
      } else {
        merged.push(curr);
      }
    }
    return merged;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  var api = {
    extractArc:   extractArc,
    summarizeArc: summarizeArc,
    parseEvent:   parseEvent,     // exposed for testing
    version:      '1.0.0'
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined' && root !== null) {
    root.CafeEmotionExtractor = api;
  }

  // ---------------------------------------------------------------------------
  // CLI mode
  // ---------------------------------------------------------------------------

  if (typeof require !== 'undefined' && require.main &&
      typeof module !== 'undefined' && require.main === module) {

    var fs = require('fs');
    var path = require('path');
    var filePath = process.argv[2];

    if (!filePath) {
      console.error('Usage: node emotion-extractor.js <session.jsonl> [--summary] [--interval=30000]');
      process.exit(1);
    }

    var showSummary = process.argv.indexOf('--summary') !== -1;
    var intervalArg = process.argv.find(function (a) { return a.startsWith('--interval='); });
    var interval = intervalArg ? parseInt(intervalArg.split('=')[1], 10) : SAMPLE_INTERVAL_MS;

    var data = fs.readFileSync(path.resolve(filePath), 'utf-8');
    var lines = data.split('\n').filter(function (l) { return l.trim(); });
    var events = [];

    lines.forEach(function (line) {
      try {
        events.push(JSON.parse(line));
      } catch (e) {
        // skip malformed lines
      }
    });

    console.error('Parsed ' + events.length + ' events from ' + lines.length + ' lines');

    var arc = extractArc(events, { intervalMs: interval });
    console.error('Extracted ' + arc.length + ' arc samples (' + interval / 1000 + 's intervals)');

    if (showSummary) {
      var summary = summarizeArc(arc);
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(JSON.stringify(arc, null, 2));
    }
  }

})(typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : this);
