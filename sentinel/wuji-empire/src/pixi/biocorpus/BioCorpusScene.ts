import { Container, Graphics, Text, TextStyle } from "pixi.js";
import type { DashboardState } from "../../state/types";

const CHAKRA_CONFIG = [
  { key: "hormone", chakra: "muladhara", sanskrit: "Muladhara", zh: "根", color: 0xEF4444, hex: "#EF4444" },
  { key: "nerve", chakra: "svadhisthana", sanskrit: "Svadhisthana", zh: "流", color: 0xF97316, hex: "#F97316" },
  { key: "threads", chakra: "manipura", sanskrit: "Manipura", zh: "煉", color: 0xFBBF24, hex: "#FBBF24" },
  { key: "shadow_clone", chakra: "vishuddhi", sanskrit: "Vishuddhi", zh: "言", color: 0x3B82F6, hex: "#3B82F6" },
  { key: "memory", chakra: "sahasrara", sanskrit: "Sahasrara", zh: "空", color: 0xA855F7, hex: "#A855F7" },
] as const;

const MATURITY_LABEL_STYLE = new TextStyle({
  fontFamily: "Courier New, monospace",
  fontSize: 14,
  fontWeight: "bold",
  fill: "#22C55E",
  align: "center",
});

const MATURITY_SUB_STYLE = new TextStyle({
  fontFamily: "Courier New, monospace",
  fontSize: 10,
  fill: "#64748B",
  align: "center",
});

const NODE_LABEL_STYLE = new TextStyle({
  fontFamily: "Courier New, monospace",
  fontSize: 9,
  fill: "#94A3B8",
  align: "center",
});

const NODE_SCORE_STYLE = new TextStyle({
  fontFamily: "Courier New, monospace",
  fontSize: 11,
  fontWeight: "bold",
  fill: "#FFFFFF",
  align: "center",
});

interface ChakraNode {
  config: (typeof CHAKRA_CONFIG)[number];
  score: number;
  status: string;
  gfx: Graphics;
  scoreText: Text;
  labelText: Text;
  x: number;
  y: number;
}

export class BioCorpusScene extends Container {
  private bgGfx = new Graphics();
  private spineGfx = new Graphics();
  private pulseParticles: Array<{
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    color: number;
  }> = [];
  private pulseGfx = new Graphics();
  private nodes: ChakraNode[] = [];
  private maturityText: Text;
  private maturitySubText: Text;
  private titleText: Text;

  private _w = 0;
  private _h = 0;
  private _phase = 0;
  private _nervePulses = 0;
  private _dormant = true;

  constructor() {
    super();

    this.addChild(this.bgGfx);
    this.addChild(this.spineGfx);
    this.addChild(this.pulseGfx);

    for (const cfg of CHAKRA_CONFIG) {
      const gfx = new Graphics();
      const scoreText = new Text({ text: "0", style: NODE_SCORE_STYLE.clone() });
      scoreText.anchor.set(0.5);
      const labelText = new Text({ text: cfg.zh, style: NODE_LABEL_STYLE.clone() });
      labelText.anchor.set(0.5);

      this.addChild(gfx);
      this.addChild(scoreText);
      this.addChild(labelText);

      this.nodes.push({
        config: cfg,
        score: 0,
        status: "unknown",
        gfx,
        scoreText,
        labelText,
        x: 0,
        y: 0,
      });
    }

    this.maturityText = new Text({ text: "", style: MATURITY_LABEL_STYLE });
    this.maturityText.anchor.set(0.5);
    this.addChild(this.maturityText);

    this.maturitySubText = new Text({ text: "", style: MATURITY_SUB_STYLE });
    this.maturitySubText.anchor.set(0.5);
    this.addChild(this.maturitySubText);

    this.titleText = new Text({
      text: "BIOCORPUS",
      style: new TextStyle({
        fontFamily: "Courier New, monospace",
        fontSize: 12,
        fontWeight: "bold",
        fill: "#475569",
        letterSpacing: 3,
      }),
    });
    this.titleText.anchor.set(0.5);
    this.addChild(this.titleText);
  }

  resize(w: number, h: number) {
    this._w = w;
    this._h = h;
    this.drawBackground();
  }

  update(data: DashboardState | null, dt: number) {
    this._phase += dt * 0.0008;

    const bio = data?.bioCorpus;
    if (!bio) {
      this._dormant = true;
      this.updateNodes([], 0, dt);
      return;
    }

    this._dormant = false;
    this._nervePulses = bio.nerve?.recent_pulses_5m ?? 0;

    const entries: ChakraNode[] = [];
    for (const cfg of CHAKRA_CONFIG) {
      const metric = (bio as Record<string, any>)[cfg.key];
      entries.push({
        config: cfg,
        score: metric?.score ?? 0,
        status: metric?.status ?? "unknown",
        gfx: new Graphics(),
        scoreText: new Text({ text: "", style: NODE_SCORE_STYLE }),
        labelText: new Text({ text: "", style: NODE_LABEL_STYLE }),
        x: 0,
        y: 0,
      });
    }

    const maturity = bio.maturity ?? { level: "M0", overall: 0 };
    this.updateNodes(entries, this._nervePulses, dt);

    for (let i = 0; i < CHAKRA_CONFIG.length; i++) {
      const metric = (bio as Record<string, any>)[CHAKRA_CONFIG[i].key];
      if (metric) {
        this.nodes[i].score = metric.score ?? 0;
        this.nodes[i].status = metric.status ?? "unknown";
      }
    }

    this.maturityText.text = maturity.level;
    this.maturityText.style.fill =
      maturity.overall >= 70 ? "#22C55E" :
      maturity.overall >= 50 ? "#FBBF24" :
      maturity.overall >= 30 ? "#F97316" : "#EF4444";

    this.maturitySubText.text = `${maturity.overall?.toFixed(0) ?? 0}%`;
  }

  private updateNodes(entries: ChakraNode[], nervePulses: number, dt: number) {
    const w = this._w;
    const h = this._h;
    if (w === 0 || h === 0) return;

    const isMobile = w < 600;
    const centerX = w * 0.5;
    const topY = h * 0.08;
    const bottomY = h * 0.85;
    const spacing = (bottomY - topY) / 4;
    const nodeX = isMobile ? centerX : w * 0.35;

    const spineX = nodeX;

    // Spine — vertical line connecting nodes
    this.spineGfx.clear();
    const spineAlpha = this._dormant ? 0.08 : 0.2;
    this.spineGfx.moveTo(spineX, topY - 20);
    this.spineGfx.lineTo(spineX, bottomY + 20);
    this.spineGfx.stroke({ color: 0x334155, width: 1, alpha: spineAlpha });

    // Update each node
    for (let i = 0; i < 5; i++) {
      const node = this.nodes[i];
      const cfg = node.config;
      const score = node.score;
      const status = node.status;

      const y = topY + spacing * (4 - i);
      node.x = nodeX;
      node.y = y;

      const healthFactor = score / 100;
      const dormantAlpha = this._dormant ? 0.15 : 1.0;
      const baseAlpha = (0.25 + healthFactor * 0.75) * dormantAlpha;
      const baseRadius = isMobile ? 14 + healthFactor * 10 : 18 + healthFactor * 16;

      // Breathing animation
      const breathe = Math.sin(this._phase + i * 0.8) * 0.12;
      const radius = baseRadius * (1 + breathe);

      // Nerve heartbeat — faster pulsing when pulses > 0
      let heartBeat = 0;
      if (i === 1 && nervePulses > 0) {
        heartBeat = Math.abs(Math.sin(this._phase * 3)) * 0.25;
      }

      const finalAlpha = Math.min(1, baseAlpha + heartBeat);
      const finalRadius = radius * (1 + heartBeat * 0.3);

      const gfx = node.gfx;
      gfx.clear();

      // Outer glow — large dim circle
      gfx.circle(nodeX, y, finalRadius * 2.8);
      gfx.fill({ color: cfg.color, alpha: finalAlpha * 0.04 });

      // Mid glow
      gfx.circle(nodeX, y, finalRadius * 1.8);
      gfx.fill({ color: cfg.color, alpha: finalAlpha * 0.08 });

      // Inner glow
      gfx.circle(nodeX, y, finalRadius * 1.3);
      gfx.fill({ color: cfg.color, alpha: finalAlpha * 0.15 });

      // Core
      gfx.circle(nodeX, y, finalRadius);
      gfx.fill({ color: cfg.color, alpha: finalAlpha * 0.5 });

      // Bright center
      const centerR = finalRadius * 0.4;
      gfx.circle(nodeX, y, centerR);
      gfx.fill({ color: 0xFFFFFF, alpha: finalAlpha * 0.15 * healthFactor });

      // Status indicator — ring
      if (!this._dormant && status === "excellent" || status === "rich" || status === "active") {
        gfx.circle(nodeX, y, finalRadius + 3);
        gfx.stroke({ color: cfg.color, width: 1.5, alpha: finalAlpha * 0.6 });
      } else if (!this._dormant && (status === "low" || status === "empty" || status === "dormant" || status === "error")) {
        gfx.circle(nodeX, y, finalRadius + 3);
        gfx.stroke({ color: 0xEF4444, width: 1, alpha: finalAlpha * 0.4 });
      }

      // Score text inside node
      node.scoreText.text = this._dormant ? "—" : `${score}`;
      node.scoreText.x = nodeX;
      node.scoreText.y = y - (isMobile ? 3 : 4);
      node.scoreText.style.fill = cfg.hex;
      node.scoreText.alpha = dormantAlpha;

      // Label below node
      const labelY = y + finalRadius + (isMobile ? 10 : 14);
      node.labelText.text = this._dormant ? "—" : `${cfg.zh} ${cfg.sanskrit}`;
      node.labelText.x = nodeX;
      node.labelText.y = labelY;
      node.labelText.alpha = dormantAlpha * 0.8;

      // Spine connection dots
      this.spineGfx.circle(spineX, y, 2);
      this.spineGfx.fill({ color: cfg.color, alpha: spineAlpha * healthFactor * 2 });
    }

    // Maturity badge — top center
    this.maturityText.x = centerX;
    this.maturityText.y = topY - 30;
    this.maturitySubText.x = centerX;
    this.maturitySubText.y = topY - 14;

    // Title
    this.titleText.x = centerX;
    this.titleText.y = h - 20;

    // Nerve pulse particles
    if (nervePulses > 0 && !this._dormant) {
      this.spawnPulseParticles();
    }
    this.tickPulseParticles(dt);
  }

  private spawnPulseParticles() {
    const nerveNode = this.nodes[1];
    if (this.pulseParticles.length > 30) return;

    for (let i = 0; i < 2; i++) {
      this.pulseParticles.push({
        x: nerveNode.x + (Math.random() - 0.5) * 10,
        y: nerveNode.y,
        vx: (Math.random() - 0.5) * 0.8,
        vy: (Math.random() - 0.5) * 0.8,
        life: 0,
        maxLife: 80 + Math.random() * 120,
        color: 0xF97316,
      });
    }
  }

  private tickPulseParticles(dt: number) {
    const gfx = this.pulseGfx;
    gfx.clear();

    for (let i = this.pulseParticles.length - 1; i >= 0; i--) {
      const p = this.pulseParticles[i];
      p.life += dt * 0.06;
      p.x += p.vx * dt * 0.06;
      p.y += p.vy * dt * 0.06;

      const lifeRatio = p.life / p.maxLife;
      if (lifeRatio > 1) {
        this.pulseParticles.splice(i, 1);
        continue;
      }

      const alpha = lifeRatio < 0.15 ? lifeRatio / 0.15 : (1 - lifeRatio) / 0.85;
      const r = 2 * alpha;

      gfx.circle(p.x, p.y, r * 2.5);
      gfx.fill({ color: p.color, alpha: alpha * 0.06 });
      gfx.circle(p.x, p.y, r);
      gfx.fill({ color: p.color, alpha: alpha * 0.4 });
    }
  }

  private drawBackground() {
    const bg = this.bgGfx;
    const w = this._w;
    const h = this._h;
    bg.clear();

    bg.rect(0, 0, w, h);
    bg.fill({ color: 0x020617 });

    // Subtle radial gradient rings
    const cx = w * 0.5;
    const cy = h * 0.45;
    const rings = 6;
    for (let i = rings; i > 0; i--) {
      const r = (h * 0.5 * i) / rings;
      bg.circle(cx, cy, r);
      bg.fill({ color: 0x0F172A, alpha: 0.1 + (i / rings) * 0.05 });
    }
  }
}
