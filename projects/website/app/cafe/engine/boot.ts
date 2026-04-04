// ── Boot (Engine Coordinator) ─────────────────────────────────
import CafeAPI from './api';
import Luthier from './luthier';
import Cinematographer from './cinematographer';
import Narrative from './narrative';
import Soulprint from './soulprint';
import Napkin from './napkin';
import Notebook from './notebook';
import type { SPData } from './types';

// ── Engine (總指揮中心) ──────────────────────────────────────
const Engine = {
  isBooted: false,
  _spData: null as SPData | null,
  _timeInterval: null as ReturnType<typeof setInterval> | null,

  // sub-system references (wired at boot)
  luthier: Luthier,
  cinematographer: Cinematographer,
  narrative: Narrative,
  napkin: Napkin,
  notebook: Notebook,

  boot() {
    if (this.isBooted) return;
    this.isBooted = true;

    const intro = document.getElementById('intro-screen');
    if (intro) {
      intro.style.opacity = '0';
      setTimeout(() => intro.remove(), 2000);
    }

    // Boot soulprint: update streak/count, get data
    this._spData = Soulprint.boot();

    // 30s time accumulator
    this._timeInterval = setInterval(() => {
      if (this._spData) Soulprint.addTime(30, this._spData);
    }, 30000);

    // Flush on unload
    window.addEventListener('beforeunload', () => {
      if (this._spData) Soulprint.addTime(0, this._spData);
      if (this._timeInterval) clearInterval(this._timeInterval);
    });

    this.luthier.init();

    // Wire narrative audio
    this.narrative.init({
      playTyping: () => this.luthier.playTyping(),
      playClick: () => this.luthier.playClick(),
    });

    this.cinematographer.init(() => this.isBooted);

    // Soulprint-aware init: inject trust-ladder line before API resolves
    const _sp = this._spData;
    const returnLine = Soulprint.getReturnGreeting(_sp);
    if (returnLine) {
      this.narrative.scripts['init'] = { name: 'Cruz', text: returnLine };
    }

    // 並行拉取後端狀態，靜默失敗
    Promise.all([CafeAPI.recordVisit(), CafeAPI.fetchState()])
      .then(([visit, state]) => {
        const farewell =
          visit?.farewell ??
          (state?.forceClose
            ? '今天的營業時間結束了。外面的風很舒服，去走走吧。我們明天見。'
            : null);
        if (farewell) {
          const base = document.getElementById('base-layer');
          if (base) base.classList.add('awake');
          setTimeout(() => {
            this.narrative.scripts['forceclose'] = { name: 'Cruz', text: farewell };
            this.narrative.trigger('forceclose');
          }, 5000);
          return;
        }

        // 用後端數據動態組 init 台詞（只在首訪覆蓋）
        if (!returnLine) {
          const todayCount = state?.visitors_today ?? 0;
          const streak = visit?.streak ?? 0;
          const recognized = visit?.recognized ?? false;

          let initText = '指紋比對完成。';
          if (todayCount > 1) initText += `今天已有 ${todayCount} 人來過這裡。`;
          else initText += '你是今天第一個推開門的人。';
          if (recognized && streak > 1) initText += `\n連續 ${streak} 天。你還記得回來的路。`;

          this.narrative.scripts['init'] = { name: 'System', text: initText };
        }
      })
      .catch(() => {});

    // 5s 入店留白儀式
    setTimeout(() => {
      const base = document.getElementById('base-layer');
      if (base) base.classList.add('awake');
      setTimeout(() => this.narrative.trigger('init'), 2000);
      // Start ambient state polling after cafe wakes up
      setTimeout(() => this.cinematographer.startAmbientPoll(), 3000);
    }, 3000);

    // 8s — napkin oracle + notebook init
    setTimeout(() => {
      this.napkin.show();
      this.notebook.init();
    }, 8000);
  },
};

// ── Public boot function ─────────────────────────────────────
export default function bootCafe() {
  // Expose globals for JSX onClick handlers
  (window as unknown as Record<string, unknown>).__cafe = Engine;
  (window as unknown as Record<string, unknown>).__cafeAPI = CafeAPI;
  (window as unknown as Record<string, unknown>).__cafeSP = Soulprint;
}
