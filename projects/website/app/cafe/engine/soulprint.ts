// ── Soulprint (靈魂指紋子系統) ────────────────────────────────
import type { SPData } from './types';

const SP_KEY = 'cafe_soulprint';

function todayStr(): string {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

function load(): SPData {
  try {
    const raw = localStorage.getItem(SP_KEY);
    if (raw) return JSON.parse(raw) as SPData;
  } catch {
    /* silent */
  }
  return {
    visit_count: 0,
    visit_streak: 0,
    last_visit: '',
    first_visit: '',
    total_time_sec: 0,
    interactions: { cup: 0, journal: 0, cruz: 0 },
    personality_signals: {
      action: 0,
      analysis: 0,
      empathy: 0,
      inspiration: 0,
      influence: 0,
      explorer: 0,
    },
  };
}

function persist(data: SPData): void {
  try {
    localStorage.setItem(SP_KEY, JSON.stringify(data));
  } catch {
    /* silent */
  }
}

const Soulprint = {
  boot(): SPData {
    const data = load();
    const t = todayStr();
    if (!data.first_visit) data.first_visit = t;

    if (!data.last_visit) {
      data.visit_count = 1;
      data.visit_streak = 1;
      data.last_visit = t;
    } else if (data.last_visit !== t) {
      const lastMs = new Date(data.last_visit).getTime();
      const todayMs = new Date(t).getTime();
      const diffDays = Math.round((todayMs - lastMs) / 86400000);
      data.visit_streak = diffDays === 1 ? data.visit_streak + 1 : 1;
      data.visit_count += 1;
      data.last_visit = t;
    }
    // same day: no mutation

    persist(data);
    return data;
  },

  addTime(seconds: number, data: SPData): void {
    data.total_time_sec += seconds;
    persist(data);
  },

  recordInteraction(key: 'cup' | 'journal' | 'cruz', data: SPData): void {
    data.interactions[key] = (data.interactions[key] || 0) + 1;
    if (key === 'cup') data.personality_signals.empathy += 1;
    if (key === 'journal') data.personality_signals.analysis += 1;
    if (key === 'cruz') data.personality_signals.explorer += 1;
    persist(data);
  },

  getReturnGreeting(data: SPData): string | null {
    const vc = data.visit_count;
    const streak = data.visit_streak;
    if (vc <= 1 && data.last_visit === todayStr() && !data.first_visit) return null;
    if (vc === 1) return null;
    if (vc <= 3) return '你回來了。';
    if (vc <= 7) return '老位子？';
    if (vc <= 14) return streak + ' 天了。習慣了嗎，這裡的雨聲？';
    return '你不用說。我知道你需要什麼。';
  },
};

export default Soulprint;
