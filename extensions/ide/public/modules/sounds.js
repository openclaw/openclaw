// ============================================
// SOUNDS MODULE - Audio Feedback
// ============================================
// Subtle sound effects for IDE actions

const SoundManager = {
  enabled: false,
  volume: 0.3,
  audioContext: null,
  sounds: {},
  
  /**
   * Initialize sound manager
   */
  init() {
    this.enabled = localStorage.getItem('clawd-ide-sounds') === 'true';
    this.volume = parseFloat(localStorage.getItem('clawd-ide-sounds-volume') || '0.3');
    console.log('[Sounds] Initialized, enabled:', this.enabled);
  },
  
  /**
   * Get or create AudioContext (lazy init due to browser autoplay policies)
   */
  getContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.audioContext;
  },
  
  /**
   * Enable/disable sounds
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    localStorage.setItem('clawd-ide-sounds', enabled ? 'true' : 'false');
    
    if (enabled) {
      this.play('toggle');
    }
  },
  
  /**
   * Set volume (0-1)
   */
  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    localStorage.setItem('clawd-ide-sounds-volume', this.volume.toString());
  },
  
  /**
   * Play a sound effect
   */
  play(soundName) {
    if (!this.enabled) return;
    
    const soundDef = soundDefinitions[soundName];
    if (!soundDef) {
      console.warn('[Sounds] Unknown sound:', soundName);
      return;
    }
    
    try {
      const ctx = this.getContext();
      
      // Resume context if suspended (browser autoplay policy)
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      
      // Create oscillator-based sound
      const now = ctx.currentTime;
      
      if (soundDef.type === 'tone') {
        this.playTone(ctx, now, soundDef);
      } else if (soundDef.type === 'chord') {
        this.playChord(ctx, now, soundDef);
      } else if (soundDef.type === 'noise') {
        this.playNoise(ctx, now, soundDef);
      }
    } catch (err) {
      console.warn('[Sounds] Playback failed:', err);
    }
  },
  
  /**
   * Play a simple tone
   */
  playTone(ctx, now, def) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = def.wave || 'sine';
    osc.frequency.setValueAtTime(def.freq, now);
    
    if (def.freqEnd) {
      osc.frequency.exponentialRampToValueAtTime(def.freqEnd, now + def.duration);
    }
    
    gain.gain.setValueAtTime(this.volume * (def.volume || 1), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + def.duration);
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.start(now);
    osc.stop(now + def.duration);
  },
  
  /**
   * Play a chord (multiple tones)
   */
  playChord(ctx, now, def) {
    def.frequencies.forEach((freq, i) => {
      setTimeout(() => {
        this.playTone(ctx, ctx.currentTime, {
          freq: freq,
          duration: def.duration,
          wave: def.wave || 'sine',
          volume: (def.volume || 1) / def.frequencies.length
        });
      }, i * (def.stagger || 0));
    });
  },
  
  /**
   * Play noise burst (for errors, etc)
   */
  playNoise(ctx, now, def) {
    const bufferSize = ctx.sampleRate * def.duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(this.volume * (def.volume || 0.3), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + def.duration);
    
    // Optional filter for different noise colors
    if (def.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = def.filter.type || 'lowpass';
      filter.frequency.value = def.filter.freq || 1000;
      noise.connect(filter);
      filter.connect(gain);
    } else {
      noise.connect(gain);
    }
    
    gain.connect(ctx.destination);
    noise.start(now);
    noise.stop(now + def.duration);
  }
};

// Sound definitions using Web Audio synthesis
const soundDefinitions = {
  // Save file - gentle chime
  save: {
    type: 'chord',
    frequencies: [523, 659, 784], // C5, E5, G5 (C major)
    duration: 0.15,
    wave: 'sine',
    stagger: 30,
    volume: 0.6
  },
  
  // Toggle/click - soft tick
  toggle: {
    type: 'tone',
    freq: 1200,
    freqEnd: 800,
    duration: 0.05,
    wave: 'sine',
    volume: 0.4
  },
  
  // Success - ascending chime
  success: {
    type: 'chord',
    frequencies: [440, 554, 659], // A4, C#5, E5 (A major)
    duration: 0.2,
    wave: 'sine',
    stagger: 50,
    volume: 0.5
  },
  
  // Error - descending buzz
  error: {
    type: 'chord',
    frequencies: [300, 250],
    duration: 0.15,
    wave: 'sawtooth',
    stagger: 50,
    volume: 0.4
  },
  
  // Warning - attention tone
  warning: {
    type: 'tone',
    freq: 800,
    duration: 0.1,
    wave: 'triangle',
    volume: 0.4
  },
  
  // Notification - gentle ping
  notification: {
    type: 'tone',
    freq: 880,
    freqEnd: 1100,
    duration: 0.12,
    wave: 'sine',
    volume: 0.4
  },
  
  // Tab close - soft pop
  close: {
    type: 'tone',
    freq: 600,
    freqEnd: 300,
    duration: 0.08,
    wave: 'sine',
    volume: 0.3
  },
  
  // Tab open - soft click
  open: {
    type: 'tone',
    freq: 800,
    freqEnd: 1000,
    duration: 0.06,
    wave: 'sine',
    volume: 0.3
  },
  
  // AI thinking start - whoosh
  aiStart: {
    type: 'tone',
    freq: 200,
    freqEnd: 600,
    duration: 0.2,
    wave: 'sine',
    volume: 0.3
  },
  
  // AI response complete - completion ding
  aiComplete: {
    type: 'chord',
    frequencies: [659, 784, 988], // E5, G5, B5
    duration: 0.25,
    wave: 'sine',
    stagger: 40,
    volume: 0.5
  },
  
  // Breakpoint toggle
  breakpoint: {
    type: 'tone',
    freq: 500,
    duration: 0.08,
    wave: 'square',
    volume: 0.25
  },
  
  // Debug step
  step: {
    type: 'tone',
    freq: 1000,
    duration: 0.04,
    wave: 'sine',
    volume: 0.3
  },
  
  // Git commit
  commit: {
    type: 'chord',
    frequencies: [392, 494, 587], // G4, B4, D5 (G major)
    duration: 0.2,
    wave: 'sine',
    stagger: 30,
    volume: 0.5
  },
  
  // Keyboard typing (very subtle)
  keystroke: {
    type: 'noise',
    duration: 0.02,
    volume: 0.08,
    filter: { type: 'highpass', freq: 3000 }
  }
};

// ============================================
// SOUND INTEGRATION HOOKS
// ============================================

// Hook into showNotification to play sounds
const originalShowNotification = window.showNotification;
if (originalShowNotification) {
  window.showNotification = function(message, type = 'info') {
    // Play appropriate sound
    if (type === 'success') SoundManager.play('success');
    else if (type === 'error') SoundManager.play('error');
    else if (type === 'warning') SoundManager.play('warning');
    else SoundManager.play('notification');
    
    // Call original
    return originalShowNotification.apply(this, arguments);
  };
}

// ============================================
// EXPORTS
// ============================================

window.SoundManager = SoundManager;

// Helper to play sounds from other modules
window.playSound = (name) => SoundManager.play(name);
