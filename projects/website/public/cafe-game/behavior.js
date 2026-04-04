/**
 * CafeBehavior — Digital Phenotyping & Narrative State Engine
 * "The bartender never asks what you're drinking. He already knows." — Omotenashi
 *
 * Tracks visitor behavior via localStorage (Matomo-ready for future enhancement).
 * Classifies into 9 narrative nodes across 3 research dimensions.
 * All detection is implicit — the visitor never knows they're being read.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'cafe_behavior';
  var CRUZ_STATE_KEY = 'cafe_cruz_state';
  var MATOMO_URL = '/api/m';
  var MATOMO_SITE_ID = 2;

  // ── Persistence ──────────────────────────────────────────────
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : defaults();
    } catch (e) { return defaults(); }
  }

  function defaults() {
    return {
      visits: [],           // [{ts, duration, hour, referrer}]
      lastVisit: null,      // ISO timestamp
      totalVisits: 0,
      totalMinutes: 0,
      notesWritten: 0,
      coffeesSent: 0,
      canvasesDrawn: 0,
      forceCloses: 0,
      peakCanvasFreq: 0,   // max clicks per second on canvas
      longestSilence: 0,   // minutes without any interaction
      lastForceClose: null  // ISO timestamp
    };
  }

  function save(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function currentHour() { return new Date().getHours(); }
  function currentReferrer() {
    try {
      var r = document.referrer || '';
      if (!r) return 'direct';
      var host = new URL(r).hostname.replace('www.', '');
      return host;
    } catch (e) { return 'direct'; }
  }

  // ── Matomo Integration ────────────────────────────────────────
  function initMatomo() {
    var _paq = window._paq = window._paq || [];
    _paq.push(['setTrackerUrl', MATOMO_URL + '/matomo.php']);
    _paq.push(['setSiteId', MATOMO_SITE_ID]);
    _paq.push(['trackPageView']);
    _paq.push(['enableLinkTracking']);
    // Load tracker async
    var d = document, g = d.createElement('script'), s = d.getElementsByTagName('script')[0];
    g.async = true;
    g.src = MATOMO_URL + '/matomo.js';
    if (s && s.parentNode) s.parentNode.insertBefore(g, s);
  }

  function matomoTrack(category, action, name, value) {
    var _paq = window._paq = window._paq || [];
    var args = ['trackEvent', category, action];
    if (name !== undefined) args.push(name);
    if (value !== undefined) args.push(value);
    _paq.push(args);
  }

  // ── Session Tracking ─────────────────────────────────────────
  var sessionStart = Date.now();
  var lastInteraction = Date.now();
  var sessionData = load();
  var lastDeparture = null;

  function recordVisit() {
    var ref = currentReferrer();
    sessionData.lastVisit = new Date().toISOString();
    sessionData.totalVisits++;
    sessionData.visits.push({
      ts: sessionData.lastVisit,
      hour: currentHour(),
      referrer: ref
    });
    // Keep only last 50 visits
    if (sessionData.visits.length > 50) {
      sessionData.visits = sessionData.visits.slice(-50);
    }
    save(sessionData);
    return sessionData;
  }

  function recordDuration() {
    var minutes = (Date.now() - sessionStart) / 60000;
    sessionData.totalMinutes += minutes;
    // Track longest silence
    if (minutes > sessionData.longestSilence) {
      sessionData.longestSilence = minutes;
    }
    save(sessionData);
  }

  function recordNote() { sessionData.notesWritten++; save(sessionData); matomoTrack('interaction', 'note', undefined, sessionData.notesWritten); }
  function recordCoffee() { sessionData.coffeesSent++; save(sessionData); matomoTrack('interaction', 'coffee', undefined, sessionData.coffeesSent); }
  function recordCanvas(freq) {
    sessionData.canvasesDrawn++;
    if (freq > sessionData.peakCanvasFreq) sessionData.peakCanvasFreq = freq;
    save(sessionData);
  }
  function recordForceClose() {
    sessionData.forceCloses++;
    sessionData.lastForceClose = new Date().toISOString();
    save(sessionData);
    matomoTrack('interaction', 'force_close');
  }

  // ── State Classification (The Bartender Filter) ──────────────
  // Returns an array of matched tags: [STATE_TAG, ...]
  // Priority: most specific first

  function classify(data) {
    if (!data) data = sessionData;
    var tags = [];
    var h = currentHour();
    var now = Date.now();

    // Check departure context for return visitors
    if (lastDeparture && data.totalVisits > 1) {
      var hoursSinceDeparture = (now - new Date(lastDeparture.departedAt).getTime()) / 3600000;
      if (hoursSinceDeparture < 1) {
        tags.push('QUICK_RETURN');
      }
    }

    // ═══ Research 1: Chronobiological Resonance ═══

    // Node 1-A: The Night Owl (深夜徘徊者)
    // 2+ consecutive visits between 01:00-04:00
    var nightVisits = 0;
    var recentVisits = data.visits.slice(-5);
    for (var i = 0; i < recentVisits.length; i++) {
      if (recentVisits[i].hour >= 1 && recentVisits[i].hour < 4) nightVisits++;
    }
    if (nightVisits >= 2 || (h >= 1 && h < 4 && data.totalVisits > 1)) {
      tags.push('NIGHT_OWL');
    }

    // Node 1-B: The Commuter (清晨逃避者)
    // 07:30-09:00 + historical avg stay < 2 min
    var avgMinutes = data.totalVisits > 0 ? data.totalMinutes / data.totalVisits : 0;
    if (h >= 7 && h < 9 && avgMinutes < 2) {
      tags.push('COMMUTER');
    }

    // Node 1-C: The Kintsugi Returnee (金繼回歸者)
    // Absent > 21 days
    if (data.lastVisit) {
      var daysSince = (now - new Date(data.lastVisit).getTime()) / 86400000;
      if (daysSince > 21) {
        tags.push('KINTSUGI_RETURN');
      }
    }

    // ═══ Research 2: Digital Footprint Psychology ═══

    var ref = currentReferrer();

    // Node 2-B: The Doomscroller (末日滑屏逃難者)
    var socialHosts = ['facebook.com', 'instagram.com', 'threads.net', 'x.com', 'twitter.com', 'tiktok.com', 'reddit.com'];
    for (var s = 0; s < socialHosts.length; s++) {
      if (ref === socialHosts[s]) { tags.push('DOOMSCROLLER'); break; }
    }

    // Node 2-C: The Intentional Wanderer (歸巢直達者)
    if (ref === 'direct' && data.totalVisits > 10) {
      tags.push('INTENTIONAL_WANDERER');
    }

    // Node 2-A: The Hesitator (權衡猶豫者)
    // Referrer from thinker.cafe internal pages (courses, pricing)
    var internalPaths = ['courses', 'pricing', 'products', 'enroll', 'checkout'];
    if (ref.indexOf('thinker.cafe') !== -1 || ref.indexOf('localhost') !== -1) {
      tags.push('HESITATOR');
    }

    // ═══ Research 3: Asynchronous Interaction Spectrum ═══

    // Node 3-A: The Silent Watcher (無聲旁觀者)
    // > 30 min total, never wrote note or sent coffee
    if (data.totalMinutes > 30 && data.notesWritten === 0 && data.coffeesSent === 0) {
      tags.push('SILENT_WATCHER');
    }

    // Node 3-B: The Anonymous Giver (匿名贈予者)
    // Frequent coffee sender or note writer
    if (data.coffeesSent >= 3 || data.notesWritten >= 3) {
      tags.push('ANONYMOUS_GIVER');
    }

    // Node 3-C: The Boundary Tester (邊界測試者)
    // Was force-closed yesterday, returned today
    if (data.lastForceClose) {
      var hoursSinceForce = (now - new Date(data.lastForceClose).getTime()) / 3600000;
      if (hoursSinceForce > 12 && hoursSinceForce < 48) {
        tags.push('BOUNDARY_TESTER');
      }
    }

    return tags;
  }

  // ── Cruz Opening Line (The Bartender's First Words) ──────────
  // Maps state tags to Cruz's contextual dialogue.
  // Priority: most acute emotional state first.

  var OPENING_LINES = {
    'QUICK_RETURN': {
      line1: '',
      line2: '剛才走太急了？咖啡還是溫的。',
      audioRate: 1.0,
      brightness: 1.0,
      caffeine: true,
      skipIntro: true  // Don't re-do the ceremony
    },
    'NIGHT_OWL': {
      line1: '\u9019\u500B\u6642\u9593\u7684\u4E16\u754C\u662F\u6700\u5B89\u975C\u7684\u3002',
      line2: '\u6211\u4E0D\u7D66\u4F60\u624B\u6C96\u4E86\uFF0C\u559D\u676F\u6EAB\u6C34\u5427\u3002\u4E0D\u7528\u6025\u8457\u7761\uFF0C\u5750\u5728\u9019\u88E1\u5C31\u597D\u3002',
      audioRate: 0.7,      // slow lofi by 30%
      brightness: 0.85,    // dim slightly
      caffeine: false
    },
    'COMMUTER': {
      line1: '\u5916\u9762\u7684\u8ECA\u8072\u807D\u8D77\u4F86\u5F88\u6025\u3002',
      line2: '\u5E36\u4E0A\u9019\u676F\uFF0C\u6DF1\u547C\u5438\uFF0C\u53BB\u6230\u9B25\u5427\u3002',
      audioRate: 1.0,
      brightness: 1.0,
      caffeine: true,
      speed: 'fast'
    },
    'KINTSUGI_RETURN': {
      line1: '\u96E8\u5B63\u6709\u6642\u5019\u5C31\u662F\u6703\u62D6\u5F97\u5F88\u9577\u3002',
      line2: '\u4F60\u7684\u676F\u5B50\u6211\u7559\u8457\uFF0C\u525B\u525B\u597D\u5920\u71B1\uFF0C\u559D\u5427\u3002',
      audioRate: 0.85,
      brightness: 0.9,
      caffeine: true,
      kintsugi: true
    },
    'DOOMSCROLLER': {
      line1: '\u5916\u9762\u7684\u8072\u97F3\u592A\u5435\u4E86\uFF0C\u5C0D\u5427\uFF1F',
      line2: '\u6211\u628A\u7A97\u6236\u95DC\u7DCA\u4E86\u4E00\u9EDE\u3002\u5728\u9019\u88E1\uFF0C\u6C92\u6709\u4EBA\u6703\u8981\u6C42\u4F60\u8868\u614B\u3002',
      audioRate: 0.8,
      brightness: 0.8,     // darker cocoon
      caffeine: false
    },
    'HESITATOR': {
      line1: '\u6709\u6642\u5019\u76EF\u8457\u6578\u5B57\u770B\u592A\u4E45\uFF0C\u773C\u7740\u6703\u82B1\u3002',
      line2: '\u90A3\u4E9B\u6C89\u91CD\u7684\u6C7A\u5B9A\u5148\u653E\u5728\u9580\u5916\u5427\uFF0C\u9019\u88E1\u53EA\u6709\u5496\u5561\u7684\u9999\u6C23\u3002',
      audioRate: 0.9,
      brightness: 0.95,
      caffeine: true
    },
    'INTENTIONAL_WANDERER': {
      line1: '',  // No extra words — just the coffee
      line2: '\u8001\u6A23\u5B50\u3002\u4F60\u4ECA\u5929\u770B\u8D77\u4F86\u597D\u591A\u4E86\u3002',
      audioRate: 1.0,
      brightness: 1.0,
      caffeine: true,
      skipIntro: true  // Skip the 5s silence
    },
    'SILENT_WATCHER': {
      line1: '',
      line2: '\u4E0D\u7528\u8AAA\u8A71\u4E5F\u6C92\u95DC\u4FC2\u3002\u5B89\u975C\u5730\u5750\u8457\uFF0C\u4E5F\u662F\u4E00\u7A2E\u5F88\u68D2\u7684\u966A\u4F34\u3002',
      audioRate: 0.85,
      brightness: 0.95,
      caffeine: false,
      delay: 30000  // Only show after 30 min
    },
    'ANONYMOUS_GIVER': {
      line1: '\u6628\u5929\u6709\u500B\u964C\u751F\u4EBA\u5750\u5728\u90A3\u88E1\uFF0C',
      line2: '\u56E0\u70BA\u4F60\u7559\u4E0B\u7684\u6771\u897F\uFF0C\u4ED6\u96E2\u958B\u7684\u6642\u5019\u6C92\u6709\u99DD\u80CC\u4E86\u3002\u8B1D\u8B1D\u4F60\u3002',
      audioRate: 1.0,
      brightness: 1.0,
      caffeine: true
    },
    'BOUNDARY_TESTER': {
      line1: '\u6628\u5929\u6709\u95DC\u6389\u87A2\u5E55\u53BB\u5439\u5439\u98A8\u55CE\uFF1F',
      line2: '\u4F60\u770B\u8D77\u4F86\u6709\u807D\u8A71\u3002\u4ECA\u5929\u6211\u5011\u6162\u6162\u4F86\uFF0C\u4E00\u5929\u4E00\u676F\u5C31\u597D\u3002',
      audioRate: 0.85,
      brightness: 0.95,
      caffeine: true
    }
  };

  // Default opening (no matched states)
  var DEFAULT_OPENING = {
    line1: '\u5916\u9762\u96E8\u5F88\u5927\u5427\uFF1F',
    line2: '\u5148\u904E\u4F86\u5750\uFF0C\u5496\u5561\u6B63\u5728\u716E\u4E86\u3002',
    audioRate: 1.0,
    brightness: 1.0,
    caffeine: true
  };

  function getOpening(tags) {
    if (!tags || tags.length === 0) return DEFAULT_OPENING;
    // Priority order: most acute emotional state first
    var priority = [
      'QUICK_RETURN',
      'KINTSUGI_RETURN', 'NIGHT_OWL', 'DOOMSCROLLER', 'BOUNDARY_TESTER',
      'COMMUTER', 'HESITATOR', 'SILENT_WATCHER', 'ANONYMOUS_GIVER',
      'INTENTIONAL_WANDERER'
    ];
    for (var p = 0; p < priority.length; p++) {
      for (var t = 0; t < tags.length; t++) {
        if (tags[t] === priority[p]) {
          return OPENING_LINES[tags[t]];
        }
      }
    }
    return DEFAULT_OPENING;
  }

  // ── Canvas Behavior Profiling (The Second Shadow) ────────────
  var canvasClicks = [];
  var canvasTimer = null;

  function startCanvasTracking() {
    var container = document.getElementById('game-container');
    if (!container) return;
    container.addEventListener('mousedown', function () {
      lastInteraction = Date.now();
      canvasClicks.push(Date.now());
      // Keep only last 100 clicks
      if (canvasClicks.length > 100) canvasClicks = canvasClicks.slice(-100);
    });
    container.addEventListener('touchstart', function () {
      lastInteraction = Date.now();
      canvasClicks.push(Date.now());
      if (canvasClicks.length > 100) canvasClicks = canvasClicks.slice(-100);
    });
    // Sample canvas frequency every 5 seconds
    canvasTimer = setInterval(function () {
      var now = Date.now();
      var recentClicks = 0;
      for (var i = canvasClicks.length - 1; i >= 0; i--) {
        if (now - canvasClicks[i] < 5000) recentClicks++;
        else break;
      }
      var freq = recentClicks / 5; // clicks per second
      if (freq > 0) recordCanvas(freq);
    }, 5000);
  }

  function getIdleMinutes() {
    return (Date.now() - lastInteraction) / 60000;
  }

  function getCanvasMood() {
    var freq = sessionData.peakCanvasFreq;
    if (freq > 3) return 'intense';    // Bold, heavy strokes — anger/energy
    if (freq < 0.5 && sessionData.canvasesDrawn > 2) return 'gentle'; // Soft, contemplative
    if (freq >= 0.5 && freq <= 3 && sessionData.canvasesDrawn > 5) return 'geometric'; // Repetitive, seeking order
    return 'neutral';
  }

  // ── Public API ───────────────────────────────────────────────
  window.CafeBehavior = {
    init: function () {
      initMatomo();
      recordVisit();
      startCanvasTracking();

      // Read departure state from last visit (RETURN node)
      try {
        var raw = localStorage.getItem('cafe_departure');
        if (raw) lastDeparture = JSON.parse(raw);
      } catch(e) {}

      // Track classified behavior state in Matomo
      var tags = classify(sessionData);
      for (var i = 0; i < tags.length; i++) {
        matomoTrack('behavior', 'classify', tags[i]);
      }
      // Auto-save duration on page hide (DEPART node)
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          recordDuration();
          // Save departure state for next visit
          var departureState = {
            tier: window.CafeBehavior.getVisitTier(),
            lastTags: classify(sessionData),
            sessionMinutes: (Date.now() - sessionStart) / 60000,
            idleMinutes: getIdleMinutes(),
            departedAt: new Date().toISOString()
          };
          try { localStorage.setItem('cafe_departure', JSON.stringify(departureState)); } catch(e) {}
          // Fade out audio gracefully
          if (window.CafeAudio && window.CafeAudio.fadeOut) window.CafeAudio.fadeOut();
          // Matomo: track session end with duration
          matomoTrack('session', 'depart', undefined, Math.round((Date.now() - sessionStart) / 1000));
        }
      });
      window.addEventListener('beforeunload', function () {
        recordDuration();
      });
    },
    classify: function () { return classify(sessionData); },
    getOpening: function () {
      var tags = classify(sessionData);
      var opening = getOpening(tags);
      opening.tags = tags;
      return opening;
    },
    recordNote: recordNote,
    recordCoffee: recordCoffee,
    recordForceClose: recordForceClose,
    recordDuration: recordDuration,
    getVisitTier: function () {
      if (sessionData.totalVisits <= 1) return 'first';
      if (sessionData.totalVisits <= 3) return 'returning';
      if (sessionData.totalVisits <= 10) return 'regular';
      return 'family';
    },
    getData: function () { return sessionData; },
    getIdleMinutes: function () { return getIdleMinutes(); },
    getLastDeparture: function () { return lastDeparture; },
    getCanvasMood: getCanvasMood,
    // Save current state for Cruz to read
    saveState: function () {
      var tags = classify(sessionData);
      var opening = getOpening(tags);
      try {
        localStorage.setItem(CRUZ_STATE_KEY, JSON.stringify({
          tags: tags,
          opening: opening,
          canvasMood: getCanvasMood(),
          visitCount: sessionData.totalVisits,
          lastVisit: sessionData.lastVisit
        }));
      } catch (e) {}
    }
  };
})();
