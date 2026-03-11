import { useRef, useEffect, useCallback } from "react";

export type AgentPulse = {
  id: string;
  name: string;
  color: string;
  intensity: number; // 0–1
};

type HeartbeatMonitorProps = {
  activityLevel: number; // 0–1
  agentPulses: AgentPulse[];
  isActive: boolean;
};

// Classic ECG waveform shape: baseline → P-wave → QRS complex → T-wave → baseline
// Returns y-offset (0 = baseline, negative = upward spike) for a given phase position (0–1)
function ecgWaveform(phase: number, amplitude: number): number {
  // P-wave: small bump at 0.1–0.2
  if (phase >= 0.1 && phase < 0.2) {
    const t = (phase - 0.1) / 0.1;
    return -Math.sin(t * Math.PI) * amplitude * 0.15;
  }
  // Q dip: small downward at 0.25
  if (phase >= 0.24 && phase < 0.28) {
    const t = (phase - 0.24) / 0.04;
    return Math.sin(t * Math.PI) * amplitude * 0.1;
  }
  // R peak: tall sharp spike at 0.3
  if (phase >= 0.28 && phase < 0.35) {
    const t = (phase - 0.28) / 0.07;
    return -Math.sin(t * Math.PI) * amplitude;
  }
  // S dip: small downward at 0.37
  if (phase >= 0.35 && phase < 0.4) {
    const t = (phase - 0.35) / 0.05;
    return Math.sin(t * Math.PI) * amplitude * 0.15;
  }
  // T-wave: medium bump at 0.5–0.65
  if (phase >= 0.5 && phase < 0.65) {
    const t = (phase - 0.5) / 0.15;
    return -Math.sin(t * Math.PI) * amplitude * 0.25;
  }
  return 0;
}

const WIDTH = 300;
const HEIGHT = 80;
const BASELINE_Y = HEIGHT / 2;
const GRID_SPACING = 20;

export function HeartbeatMonitor({ activityLevel, agentPulses, isActive }: HeartbeatMonitorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const traceRef = useRef<number[]>(new Array(WIDTH).fill(0));
  const scanXRef = useRef(0);
  const phaseRef = useRef(0);
  const prevTimeRef = useRef(0);
  // Store current props in refs for animation loop access
  const activityRef = useRef(activityLevel);
  const isActiveRef = useRef(isActive);
  const agentPulsesRef = useRef(agentPulses);

  useEffect(() => {
    activityRef.current = activityLevel;
  }, [activityLevel]);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);
  useEffect(() => {
    agentPulsesRef.current = agentPulses;
  }, [agentPulses]);

  const draw = useCallback((timestamp: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dt = prevTimeRef.current ? (timestamp - prevTimeRef.current) / 1000 : 0.016;
    prevTimeRef.current = timestamp;

    const activity = activityRef.current;
    const active = isActiveRef.current;
    const pulses = agentPulsesRef.current;

    // Compute derived animation params from activity level
    // Tuned for a calm baseline that ramps up with real load
    const speed = active ? 30 + activity * 70 : 12; // pixels/sec (30-100 active, 12 stopped)
    const amplitude = active ? 12 + activity * 20 : 2; // peak height (12-32 active, 2 stopped)
    const beatFrequency = active ? 0.4 + activity * 0.8 : 0.15; // beats/sec (0.4-1.2 active)

    // Read CSS custom properties from the canvas element
    const styles = getComputedStyle(canvas);
    const accentGreen = styles.getPropertyValue("--accent-green").trim() || "#00d084";
    const bgCard = styles.getPropertyValue("--bg-card").trim() || "#161618";
    const textMuted = styles.getPropertyValue("--text-muted").trim() || "#666666";
    const borderColor = styles.getPropertyValue("--border-mabos").trim() || "#2a2a2d";

    // Advance scan position and phase
    const pxAdvance = speed * dt;
    scanXRef.current = (scanXRef.current + pxAdvance) % WIDTH;
    phaseRef.current = (phaseRef.current + beatFrequency * dt) % 1;

    // Generate waveform data for the pixels we're advancing over
    const trace = traceRef.current;
    const startX = Math.floor(scanXRef.current - pxAdvance + WIDTH) % WIDTH;
    const endX = Math.floor(scanXRef.current);
    const steps = Math.max(1, Math.ceil(pxAdvance));
    for (let i = 0; i < steps; i++) {
      const x = (startX + i) % WIDTH;
      const localPhase = (phaseRef.current - ((steps - i) / steps) * beatFrequency * dt + 10) % 1;
      trace[x] = active ? ecgWaveform(localPhase, amplitude) : (Math.random() - 0.5) * 0.5; // tiny flatline noise
    }

    // Clear canvas
    ctx.fillStyle = bgCard;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Draw subtle grid
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.3;
    for (let x = 0; x < WIDTH; x += GRID_SPACING) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, HEIGHT);
      ctx.stroke();
    }
    for (let y = 0; y < HEIGHT; y += GRID_SPACING) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(WIDTH, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Draw trace with glow
    const scanX = Math.floor(scanXRef.current);
    // Glow layer
    ctx.save();
    ctx.shadowColor = accentGreen;
    ctx.shadowBlur = active ? 6 + activity * 6 : 2;
    ctx.strokeStyle = accentGreen;
    ctx.lineWidth = active ? 1.5 : 0.8;
    ctx.globalAlpha = active ? 0.9 : 0.3;
    ctx.beginPath();
    for (let i = 0; i < WIDTH; i++) {
      // Draw from scan position backward (old data fades)
      const x = (scanX - WIDTH + i + WIDTH) % WIDTH;
      const y = BASELINE_Y + trace[x];
      // Fade older data
      const age = i / WIDTH;
      if (i === 0) {
        ctx.moveTo(i, y);
      } else {
        ctx.lineTo(i, y);
      }
      // Erase area ahead of scan line
      if (i > WIDTH - 8) {
        ctx.globalAlpha = 0;
      }
    }
    ctx.stroke();
    ctx.restore();

    // Draw trace (solid layer on top)
    ctx.save();
    ctx.strokeStyle = accentGreen;
    ctx.lineWidth = active ? 1.5 : 0.8;
    ctx.beginPath();
    for (let i = 0; i < WIDTH; i++) {
      const x = (scanX - WIDTH + i + WIDTH) % WIDTH;
      const y = BASELINE_Y + trace[x];
      const age = i / WIDTH;
      ctx.globalAlpha = active ? 0.2 + age * 0.8 : 0.1 + age * 0.2;
      if (i === 0) {
        ctx.moveTo(i, y);
      } else {
        ctx.lineTo(i, y);
      }
    }
    ctx.stroke();
    ctx.restore();

    // Draw scan line
    ctx.save();
    const scanDrawX = scanX % WIDTH;
    ctx.strokeStyle = accentGreen;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(scanDrawX, 0);
    ctx.lineTo(scanDrawX, HEIGHT);
    ctx.stroke();
    // Erase strip ahead
    ctx.globalAlpha = 1;
    ctx.fillStyle = bgCard;
    for (let w = 1; w <= 6; w++) {
      ctx.globalAlpha = 1 - w / 7;
      ctx.fillRect((scanDrawX + w) % WIDTH, 0, 1, HEIGHT);
    }
    ctx.restore();

    // Draw agent pulse dots along the baseline
    if (active && pulses.length > 0) {
      const spacing = WIDTH / (pulses.length + 1);
      pulses.forEach((pulse, idx) => {
        const dotX = spacing * (idx + 1);
        const dotSize = 2 + pulse.intensity * 2;
        ctx.save();
        ctx.fillStyle = pulse.color;
        ctx.globalAlpha = 0.5 + pulse.intensity * 0.5;
        ctx.shadowColor = pulse.color;
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(dotX, HEIGHT - 8, dotSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    }

    // "No Signal" text when stopped
    if (!active) {
      ctx.save();
      ctx.fillStyle = textMuted;
      ctx.globalAlpha = 0.5;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("NO SIGNAL", WIDTH / 2, HEIGHT / 2 + 3);
      ctx.restore();
    }

    animRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  return (
    <div className="relative w-full overflow-hidden rounded-md">
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        className="w-full"
        style={{
          height: "80px",
          imageRendering: "auto",
          // Inherit CSS custom properties from parent
          color: "var(--accent-green)",
        }}
      />
      {/* Agent pulse tooltips */}
      {isActive && agentPulses.length > 0 && (
        <div
          className="absolute bottom-0 left-0 right-0 flex justify-around px-4"
          style={{ height: "16px", pointerEvents: "none" }}
        >
          {agentPulses.map((pulse) => (
            <div
              key={pulse.id}
              className="text-[8px] text-center"
              style={{
                color: pulse.color,
                opacity: 0.7,
                pointerEvents: "auto",
              }}
              title={`${pulse.name} (${Math.round(pulse.intensity * 100)}%)`}
            >
              {pulse.name.slice(0, 3)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
