/**
 * CafeLofiBridge — Integration bridge between Emotion Arc Extractor and Lofi Synth
 * Connects session emotional arcs to real-time lofi music generation,
 * coordinated with the existing CafeAudio system.
 *
 * Dependencies (loaded before this script):
 *   - window.CafeAudio        (audio.js)
 *   - window.CafeLofiSynth    (lofi-synth.js)     — optional, degrades silently
 *   - window.CafeEmotionExtractor (emotion-extractor.js) — optional, uses static arc
 *
 * ── Integration into page.tsx ──────────────────────────────────────────────
 * 1. Add to GAME_SCRIPTS array (after 'audio.js', before 'engine-pixi.js'):
 *
 *    '/api/cafe-game/emotion-extractor.js',
 *    '/api/cafe-game/lofi-synth.js',
 *    '/api/cafe-game/lofi-bridge.js',
 *
 * 2. In the boot() function, after the CafeAudio resume block (~line 323),
 *    add the bridge initialization:
 *
 *    // Initialize Lofi Bridge (degrades silently if synth not loaded)
 *    if (w.CafeLofiBridge) {
 *      w.CafeLofiBridge.init(w.CafeAudio);
 *      const startLofi = () => {
 *        w.CafeLofiBridge.start();
 *        document.removeEventListener('click', startLofi);
 *        document.removeEventListener('keydown', startLofi);
 *      };
 *      document.addEventListener('click', startLofi, { once: true });
 *      document.addEventListener('keydown', startLofi, { once: true });
 *    }
 *
 * 3. Optionally wire user activity in CafeInteractions or CafeTouch:
 *
 *    if (w.CafeLofiBridge) w.CafeLofiBridge.onUserActivity();
 *
 * ──────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  // ── Guard: require CafeLofiSynth ──────────────────────────────
  if (!window.CafeLofiSynth) {
    window.CafeLofiBridge = null;
    return;
  }

  // ── Constants ─────────────────────────────────────────────────
  var ARC_URL = '/api/cafe-game/session-arc.json';
  var LERP_INTERVAL_MS = 1000;          // mood update tick (1 second)
  var KEYFRAME_DURATION_MS = 45000;     // default lerp between keyframes (45s)
  var CROSSFADE_DURATION_S = 6;         // 4-8 range, we use 6
  var IDLE_THRESHOLD_MS = 300000;       // 5 minutes
  var ACTIVITY_BUMP_DECAY_MS = 15000;   // intensity bump decays over 15s
  var DUCK_VOLUME = 0.15;              // lofi volume during piano events
  var NORMAL_VOLUME = 0.55;            // lofi volume at rest
  var VOLUME_RAMP_S = 2;              // ducking ramp time

  // ── Default mood: calm cafe afternoon ─────────────────────────
  var DEFAULT_MOOD = {
    intensity: 0.3,
    valence: 0.6,
    flow: 0.7,
    tension: 0.1,
    creativity: 0.4
  };

  // ── State ─────────────────────────────────────────────────────
  var cafeAudio = null;                // reference to CafeAudio
  var synth = window.CafeLofiSynth;
  var extractor = window.CafeEmotionExtractor || null;

  var arcData = null;                  // loaded session arc
  var arcKeyframes = [];               // [{time: ms, mood: {...}}, ...]
  var arcStartTime = 0;                // when playback of arc started

  var currentMood = cloneMood(DEFAULT_MOOD);
  var targetMood = cloneMood(DEFAULT_MOOD);
  var previousMood = cloneMood(DEFAULT_MOOD);  // for crossfade detection

  var lerpProgress = 0;                // 0..1 between keyframes
  var currentKeyframeIndex = 0;

  var lastActivityTime = Date.now();
  var activityBumpTime = 0;            // when last activity bump happened
  var isIdle = false;

  var lofiGainNode = null;             // gain node for ducking control
  var isDucked = false;
  var isRunning = false;
  var isPaused = false;
  var moodTickTimer = null;
  var initialized = false;

  var visitTier = 'first';             // set from CafeBehavior

  // ── Utility ───────────────────────────────────────────────────

  function cloneMood(m) {
    return {
      intensity: m.intensity,
      valence: m.valence,
      flow: m.flow,
      tension: m.tension,
      creativity: m.creativity
    };
  }

  function lerpMood(a, b, t) {
    t = Math.max(0, Math.min(1, t));
    return {
      intensity: a.intensity + (b.intensity - a.intensity) * t,
      valence: a.valence + (b.valence - a.valence) * t,
      flow: a.flow + (b.flow - a.flow) * t,
      tension: a.tension + (b.tension - a.tension) * t,
      creativity: a.creativity + (b.creativity - a.creativity) * t
    };
  }

  function moodDistance(a, b) {
    var di = a.intensity - b.intensity;
    var dv = a.valence - b.valence;
    var df = a.flow - b.flow;
    var dt = a.tension - b.tension;
    var dc = a.creativity - b.creativity;
    return Math.sqrt(di * di + dv * dv + df * df + dt * dt + dc * dc);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ── Time-of-Day Modifier ──────────────────────────────────────
  // Returns a modifier object that adjusts mood based on current hour
  function getTimeOfDayModifier() {
    var hour = new Date().getHours();
    var mod = { intensity: 0, valence: 0, flow: 0, tension: 0, creativity: 0 };

    if (hour >= 22 || hour < 6) {
      // Late night: lower intensity, higher flow (contemplative)
      mod.intensity = -0.15;
      mod.tension = -0.05;
      mod.flow = 0.1;
      mod.creativity = 0.05;
    } else if (hour >= 6 && hour < 10) {
      // Morning: rising energy, gentle positivity
      mod.intensity = 0.05;
      mod.valence = 0.1;
      mod.flow = 0.05;
    } else if (hour >= 10 && hour < 14) {
      // Midday: peak energy
      mod.intensity = 0.1;
      mod.creativity = 0.1;
    } else if (hour >= 14 && hour < 18) {
      // Afternoon: steady, warm
      mod.valence = 0.05;
      mod.flow = 0.05;
    } else {
      // Evening (18-22): winding down
      mod.intensity = -0.05;
      mod.valence = 0.05;
      mod.tension = -0.05;
    }

    return mod;
  }

  // ── User Behavior Modifier ────────────────────────────────────
  function getBehaviorModifier() {
    var mod = { intensity: 0, valence: 0, flow: 0, tension: 0, creativity: 0 };
    var now = Date.now();

    // Idle detection: 5+ minutes without activity
    var idleDuration = now - lastActivityTime;
    if (idleDuration > IDLE_THRESHOLD_MS) {
      isIdle = true;
      // Progressive relaxation: more idle = more calm
      var idleMinutes = idleDuration / 60000;
      var idleFactor = Math.min(idleMinutes / 15, 1); // caps at 15 min
      mod.tension = -0.1 * idleFactor;
      mod.intensity = -0.1 * idleFactor;
      mod.flow = 0.05 * idleFactor;
    } else {
      isIdle = false;
    }

    // Recent activity bump: decays over ACTIVITY_BUMP_DECAY_MS
    if (activityBumpTime > 0) {
      var bumpAge = now - activityBumpTime;
      if (bumpAge < ACTIVITY_BUMP_DECAY_MS) {
        var bumpStrength = 1 - (bumpAge / ACTIVITY_BUMP_DECAY_MS);
        mod.intensity += 0.08 * bumpStrength;
        mod.creativity += 0.05 * bumpStrength;
      }
    }

    return mod;
  }

  // ── Apply modifiers to base mood ──────────────────────────────
  function applyModifiers(baseMood) {
    var timeMod = getTimeOfDayModifier();
    var behaviorMod = getBehaviorModifier();

    return {
      intensity: clamp(baseMood.intensity + timeMod.intensity + behaviorMod.intensity, 0, 1),
      valence: clamp(baseMood.valence + timeMod.valence + behaviorMod.valence, 0, 1),
      flow: clamp(baseMood.flow + timeMod.flow + behaviorMod.flow, 0, 1),
      tension: clamp(baseMood.tension + timeMod.tension + behaviorMod.tension, 0, 1),
      creativity: clamp(baseMood.creativity + timeMod.creativity + behaviorMod.creativity, 0, 1)
    };
  }

  // ── Arc Data Loading ──────────────────────────────────────────

  function loadArcData(callback) {
    // Try emotion extractor first (live extraction)
    if (extractor && typeof extractor.getArc === 'function') {
      try {
        var liveArc = extractor.getArc();
        if (liveArc && liveArc.keyframes && liveArc.keyframes.length > 0) {
          console.log('☕ LofiBridge: using live emotion arc (' + liveArc.keyframes.length + ' keyframes)');
          callback(liveArc);
          return;
        }
      } catch (e) { /* fall through */ }
    }

    // Try static arc file
    fetch(ARC_URL)
      .then(function (r) {
        if (!r.ok) throw new Error('no arc');
        return r.json();
      })
      .then(function (data) {
        if (data && data.keyframes && data.keyframes.length > 0) {
          console.log('☕ LofiBridge: loaded static arc (' + data.keyframes.length + ' keyframes)');
          callback(data);
        } else {
          throw new Error('empty arc');
        }
      })
      .catch(function () {
        // Fallback: generate a gentle default arc
        console.log('☕ LofiBridge: no arc data, using default calm cafe afternoon');
        callback(generateDefaultArc());
      });
  }

  function generateDefaultArc() {
    // A gentle 30-minute arc with subtle variation
    var base = cloneMood(DEFAULT_MOOD);
    var keyframes = [
      { time: 0, mood: cloneMood(base) },
      { time: 300000, mood: { intensity: 0.25, valence: 0.65, flow: 0.75, tension: 0.08, creativity: 0.35 } },
      { time: 600000, mood: { intensity: 0.35, valence: 0.7, flow: 0.8, tension: 0.05, creativity: 0.5 } },
      { time: 900000, mood: { intensity: 0.3, valence: 0.6, flow: 0.7, tension: 0.1, creativity: 0.45 } },
      { time: 1200000, mood: { intensity: 0.2, valence: 0.55, flow: 0.65, tension: 0.05, creativity: 0.3 } },
      { time: 1500000, mood: { intensity: 0.25, valence: 0.6, flow: 0.7, tension: 0.08, creativity: 0.4 } },
      { time: 1800000, mood: cloneMood(base) }
    ];
    return { keyframes: keyframes, loop: true };
  }

  // ── Arc Playback ──────────────────────────────────────────────

  function getArcMoodAtTime(elapsedMs) {
    if (!arcKeyframes || arcKeyframes.length === 0) return cloneMood(DEFAULT_MOOD);

    var totalDuration = arcKeyframes[arcKeyframes.length - 1].time;

    // Handle looping
    if (arcData && arcData.loop && totalDuration > 0) {
      elapsedMs = elapsedMs % totalDuration;
    } else if (elapsedMs >= totalDuration) {
      // Past the end: hold last keyframe
      return cloneMood(arcKeyframes[arcKeyframes.length - 1].mood);
    }

    // Find surrounding keyframes
    var prevKf = arcKeyframes[0];
    var nextKf = arcKeyframes[arcKeyframes.length - 1];

    for (var i = 0; i < arcKeyframes.length - 1; i++) {
      if (elapsedMs >= arcKeyframes[i].time && elapsedMs < arcKeyframes[i + 1].time) {
        prevKf = arcKeyframes[i];
        nextKf = arcKeyframes[i + 1];
        break;
      }
    }

    // Lerp between keyframes
    var segmentDuration = nextKf.time - prevKf.time;
    if (segmentDuration <= 0) return cloneMood(prevKf.mood);

    var segmentProgress = (elapsedMs - prevKf.time) / segmentDuration;

    // Smooth step for more organic transitions (ease in-out)
    var t = segmentProgress * segmentProgress * (3 - 2 * segmentProgress);

    return lerpMood(prevKf.mood, nextKf.mood, t);
  }

  // ── Crossfade Detection ───────────────────────────────────────
  // When mood changes significantly, tell the synth to crossfade

  var CROSSFADE_THRESHOLD = 0.3; // mood distance that triggers crossfade

  function checkCrossfade(newMood) {
    var dist = moodDistance(previousMood, newMood);
    if (dist > CROSSFADE_THRESHOLD) {
      // Significant mood shift: trigger crossfade in synth
      if (synth && typeof synth.crossfade === 'function') {
        synth.crossfade(newMood, CROSSFADE_DURATION_S);
      }
      previousMood = cloneMood(newMood);
      return true;
    }
    return false;
  }

  // ── Piano Event Ducking ───────────────────────────────────────
  // Monkey-patches CafeAudio.playPianoEvent to duck lofi during piano

  var _originalPlayPianoEvent = null;

  function installPianoDuck() {
    if (!cafeAudio || !cafeAudio.playPianoEvent) return;
    _originalPlayPianoEvent = cafeAudio.playPianoEvent;

    cafeAudio.playPianoEvent = function (onStart, onEnd) {
      _originalPlayPianoEvent(
        function () {
          // Duck lofi volume
          duckVolume();
          if (onStart) onStart();
        },
        function () {
          // Restore lofi volume
          restoreVolume();
          if (onEnd) onEnd();
        }
      );
    };
  }

  function duckVolume() {
    if (isDucked) return;
    isDucked = true;
    if (synth && typeof synth.setVolume === 'function') {
      synth.setVolume(DUCK_VOLUME, VOLUME_RAMP_S);
    }
  }

  function restoreVolume() {
    if (!isDucked) return;
    isDucked = false;
    if (synth && typeof synth.setVolume === 'function') {
      synth.setVolume(NORMAL_VOLUME, VOLUME_RAMP_S);
    }
  }

  // ── Mood Evolution Tick ───────────────────────────────────────

  function moodTick() {
    if (!isRunning || isPaused) return;

    var elapsed = Date.now() - arcStartTime;

    // Get base mood from arc
    var arcMood = getArcMoodAtTime(elapsed);

    // Apply time-of-day and behavior modifiers
    var finalMood = applyModifiers(arcMood);

    // Check if mood shift is large enough for crossfade
    var didCrossfade = checkCrossfade(finalMood);

    // Update synth mood (smooth update if no crossfade needed)
    if (!didCrossfade && synth && typeof synth.setMood === 'function') {
      synth.setMood(finalMood);
    }

    currentMood = finalMood;
  }

  function startMoodLoop() {
    if (moodTickTimer) return;
    moodTickTimer = setInterval(moodTick, LERP_INTERVAL_MS);
  }

  function stopMoodLoop() {
    if (moodTickTimer) {
      clearInterval(moodTickTimer);
      moodTickTimer = null;
    }
  }

  // ── Visit Tier Coordination ───────────────────────────────────

  function getStartDelay() {
    // First visit: let ambience breathe for a few seconds
    // Returning visitors: start sooner
    switch (visitTier) {
      case 'first':     return 8000;  // 8s delay — let vinyl + drone settle
      case 'returning': return 2000;  // 2s — brief grace period
      case 'regular':   return 500;   // near-immediate
      case 'family':    return 0;     // instant
      default:          return 4000;
    }
  }

  // ── Public API ────────────────────────────────────────────────

  window.CafeLofiBridge = {

    /**
     * Wire up to the existing CafeAudio system.
     * Call once during boot, before start().
     */
    init: function (audio) {
      if (initialized) return;
      initialized = true;
      cafeAudio = audio || window.CafeAudio;

      // Detect visit tier
      if (window.CafeBehavior && window.CafeBehavior.getVisitTier) {
        visitTier = window.CafeBehavior.getVisitTier();
      }

      // Install piano ducking
      installPianoDuck();

      // Initialize the synth if it has an init method
      if (synth && typeof synth.init === 'function') {
        synth.init();
      }

      console.log('☕ LofiBridge: initialized (tier=' + visitTier + ')');
    },

    /**
     * Begin the lofi experience.
     * Loads arc data, waits appropriate delay based on visit tier,
     * then starts the synth and mood evolution loop.
     */
    start: function () {
      if (isRunning) return;

      loadArcData(function (data) {
        arcData = data;
        arcKeyframes = data.keyframes || [];
        arcStartTime = Date.now();

        // Set initial mood
        var initialMood = applyModifiers(
          arcKeyframes.length > 0 ? cloneMood(arcKeyframes[0].mood) : cloneMood(DEFAULT_MOOD)
        );
        currentMood = initialMood;
        previousMood = cloneMood(initialMood);
        targetMood = cloneMood(initialMood);

        var delay = getStartDelay();
        console.log('☕ LofiBridge: starting in ' + delay + 'ms');

        setTimeout(function () {
          isRunning = true;

          // Start the synth with initial mood
          if (synth && typeof synth.start === 'function') {
            synth.start(initialMood);
          } else if (synth && typeof synth.setMood === 'function') {
            synth.setMood(initialMood);
          }

          // Set initial volume
          if (synth && typeof synth.setVolume === 'function') {
            synth.setVolume(NORMAL_VOLUME, 3); // gentle 3s fade-in
          }

          // Begin mood evolution
          startMoodLoop();

          console.log('☕ LofiBridge: lofi playing. mood=' +
            JSON.stringify({
              i: currentMood.intensity.toFixed(2),
              v: currentMood.valence.toFixed(2),
              f: currentMood.flow.toFixed(2)
            })
          );
        }, delay);
      });
    },

    /**
     * Call when user interacts (click, keypress, touch, etc.)
     * Creates a subtle intensity bump that decays naturally.
     */
    onUserActivity: function () {
      lastActivityTime = Date.now();
      activityBumpTime = Date.now();
    },

    /**
     * Pause lofi playback (e.g., when tab hidden or user toggles off).
     * Does NOT stop the mood loop — mood continues evolving so
     * resume picks up at the right emotional position.
     */
    pause: function () {
      if (!isRunning || isPaused) return;
      isPaused = true;
      if (synth && typeof synth.pause === 'function') {
        synth.pause();
      } else if (synth && typeof synth.setVolume === 'function') {
        synth.setVolume(0, 2);
      }
      console.log('☕ LofiBridge: paused');
    },

    /**
     * Resume lofi playback after pause.
     * Smoothly fades back in at current mood state.
     */
    resume: function () {
      if (!isRunning || !isPaused) return;
      isPaused = false;

      if (synth && typeof synth.resume === 'function') {
        synth.resume();
      }

      // Restore volume (respect ducking state)
      if (synth && typeof synth.setVolume === 'function') {
        synth.setVolume(isDucked ? DUCK_VOLUME : NORMAL_VOLUME, 2);
      }

      // Push current mood to synth
      if (synth && typeof synth.setMood === 'function') {
        synth.setMood(currentMood);
      }

      console.log('☕ LofiBridge: resumed');
    },

    /**
     * Get current bridge state for debugging / dashboard.
     */
    getStatus: function () {
      var elapsed = isRunning ? Date.now() - arcStartTime : 0;
      return {
        initialized: initialized,
        running: isRunning,
        paused: isPaused,
        ducked: isDucked,
        idle: isIdle,
        visitTier: visitTier,
        elapsedMs: elapsed,
        arcKeyframes: arcKeyframes.length,
        arcLooping: arcData ? !!arcData.loop : false,
        currentMood: currentMood,
        timeOfDay: getTimeOfDayModifier(),
        synthAvailable: !!synth
      };
    }
  };

  // ── Visibility API: auto-pause when tab hidden ────────────────
  document.addEventListener('visibilitychange', function () {
    if (!isRunning) return;
    if (document.hidden) {
      window.CafeLofiBridge.pause();
    } else {
      window.CafeLofiBridge.resume();
    }
  });

})();
