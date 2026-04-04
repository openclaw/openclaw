// ── Luthier (聲學架構師) ──────────────────────────────────────

const Luthier = {
  ctx: null as AudioContext | null,

  init() {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();

    // 250Hz lowpass rain
    const bufferSize = this.ctx!.sampleRate * 2;
    const rainBuffer = this.ctx!.createBuffer(1, bufferSize, this.ctx!.sampleRate);
    const rData = rainBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) rData[i] = (Math.random() * 2 - 1) * 0.25;

    const rainSource = this.ctx!.createBufferSource();
    rainSource.buffer = rainBuffer;
    rainSource.loop = true;
    const rainFilter = this.ctx!.createBiquadFilter();
    rainFilter.type = 'lowpass';
    rainFilter.frequency.value = 250;
    rainFilter.Q.value = 0.5;
    const rainGain = this.ctx!.createGain();
    rainGain.gain.value = 0;
    rainSource.connect(rainFilter).connect(rainGain).connect(this.ctx!.destination);
    rainSource.start();
    rainGain.gain.linearRampToValueAtTime(0.18, this.ctx!.currentTime + 5);

    // 65Hz gravity hum
    const hum = this.ctx!.createOscillator();
    hum.type = 'sine';
    hum.frequency.value = 65;
    const humGain = this.ctx!.createGain();
    humGain.gain.value = 0;
    hum.connect(humGain).connect(this.ctx!.destination);
    hum.start();
    humGain.gain.linearRampToValueAtTime(0.02, this.ctx!.currentTime + 5);
  },

  playTyping() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(400 + Math.random() * 200, this.ctx.currentTime);
    gain.gain.setValueAtTime(0, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.015, this.ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.05);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.06);
  },

  playClick() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(200, this.ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.05, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.1);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.1);
  },
};

export default Luthier;
