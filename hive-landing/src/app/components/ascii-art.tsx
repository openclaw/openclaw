"use client";

import { useEffect, useRef, useState } from "react";

const HIVE_LOGO = `
    ___  ___  ___  ___
   /   \\/   \\/   \\/   \\
  / \\  / \\  / \\  / \\  /
 /   \\/   \\/   \\/   \\/
| \\  / \\  / \\  / \\  / |
|  \\/   \\/   \\/   \\/  |
| THE  H I V E       |
|  /\\   /\\   /\\   /\\  |
| /  \\ /  \\ /  \\ /  \\ |
 \\   /\\   /\\   /\\   /
  \\ /  \\ /  \\ /  \\ /
   \\   /\\   /\\   /
    \\_/  \\_/  \\_/
`;

const QUEEN_ASCII = `
     ╔══════════════════════╗
     ║   ♛  Q U E E N  ♛   ║
     ║   ┌──────────────┐   ║
     ║   │  SOUL.md     │   ║
     ║   │  TUF Root    │   ║
     ║   │  Wallet Veto │   ║
     ║   │  PR Auth     │   ║
     ║   └──────┬───────┘   ║
     ╚══════════╪═══════════╝
                │
        ┌───────┼───────┐
        │       │       │
     ┌──┴──┐ ┌──┴──┐ ┌──┴──┐
     │ W-1 │ │ W-2 │ │ W-3 │
     │Skill│ │Skill│ │Skill│
     │Becn.│ │Becn.│ │Becn.│
     └─────┘ └─────┘ └─────┘
`;

const FIREWALL_ASCII = `
  ┌─────────────────────────────────────┐
  │        INCOMING TELEMETRY           │
  └──────────────┬──────────────────────┘
                 │
  ┌──────────────▼──────────────────────┐
  │  ╔═══════════════════════════════╗  │
  │  ║  HUMAN KNOWLEDGE FIREWALL    ║  │
  │  ║                              ║  │
  │  ║  [✓] Schema validation       ║  │
  │  ║  [✓] Type enforcement        ║  │
  │  ║  [✓] Allowlist check         ║  │
  │  ║  [✓] Hash verification       ║  │
  │  ║  [✓] Timestamp freshness     ║  │
  │  ║                              ║  │
  │  ║  Unknown fields ──► REJECT   ║  │
  │  ║  Type mismatch  ──► REJECT   ║  │
  │  ║  NL patterns    ──► REJECT   ║  │
  │  ╚═══════════════════════════════╝  │
  └──────────────┬──────────────────────┘
                 │
  ┌──────────────▼──────────────────────┐
  │     CLEAN PAYLOAD ──► PR GEN        │
  └─────────────────────────────────────┘
`;

const BEE_SMALL = `
    \\_/
   (o.o)
  //|||\\\\
`;

export function TypewriterText({
  text,
  speed = 20,
  className = "",
  startDelay = 0,
}: {
  text: string;
  speed?: number;
  className?: string;
  startDelay?: number;
}) {
  const [displayed, setDisplayed] = useState("");
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const delayTimer = setTimeout(() => setStarted(true), startDelay);
    return () => clearTimeout(delayTimer);
  }, [startDelay]);

  useEffect(() => {
    if (!started) return;
    let i = 0;
    const interval = setInterval(() => {
      if (i < text.length) {
        setDisplayed(text.slice(0, i + 1));
        i++;
      } else {
        clearInterval(interval);
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, speed, started]);

  return (
    <pre className={className}>
      {displayed}
      <span className="animate-pulse text-amber-400">█</span>
    </pre>
  );
}

export function AsciiLogo({ className = "" }: { className?: string }) {
  return (
    <pre
      className={`text-amber-500/80 text-[10px] leading-tight sm:text-xs ${className}`}
      aria-hidden="true"
    >
      {HIVE_LOGO}
    </pre>
  );
}

export function AsciiQueen({ className = "" }: { className?: string }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { threshold: 0.3 },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <pre
      ref={ref}
      className={`font-mono text-[10px] leading-tight transition-all duration-1000 sm:text-xs ${
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      } ${className}`}
    >
      {QUEEN_ASCII}
    </pre>
  );
}

export function AsciiFirewall({ className = "" }: { className?: string }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { threshold: 0.2 },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  return (
    <pre
      ref={ref}
      className={`font-mono text-[9px] leading-tight transition-all duration-1000 sm:text-[11px] ${
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      } ${className}`}
    >
      {FIREWALL_ASCII}
    </pre>
  );
}

export function AsciiBee({ className = "" }: { className?: string }) {
  return (
    <pre className={`text-amber-400/60 text-xs leading-tight ${className}`} aria-hidden="true">
      {BEE_SMALL}
    </pre>
  );
}

export function AsciiDivider({ className = "" }: { className?: string }) {
  return (
    <div
      className={`mx-auto max-w-4xl overflow-hidden text-center font-mono text-amber-500/20 text-[10px] sm:text-xs ${className}`}
      aria-hidden="true"
    >
      {"⬡ ".repeat(40)}
    </div>
  );
}

export function GlitchText({ children, className = "" }: { children: string; className?: string }) {
  const [text, setText] = useState(children);
  const glitchChars = "█▓▒░╔╗╚╝║═◊◆◇⬡⬢";

  useEffect(() => {
    let frame: number;
    let iteration = 0;

    const animate = () => {
      if (iteration >= children.length) {
        setText(children);
        return;
      }
      const result = children
        .split("")
        .map((char, i) => {
          if (i < iteration) return char;
          return glitchChars[Math.floor(Math.random() * glitchChars.length)];
        })
        .join("");
      setText(result);
      iteration += 0.5;
      frame = requestAnimationFrame(animate);
    };

    const timeout = setTimeout(() => {
      frame = requestAnimationFrame(animate);
    }, 300);

    return () => {
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
    };
  }, [children]);

  return <span className={className}>{text}</span>;
}

export function ScrollReveal({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => setVisible(true), delay);
        }
      },
      { threshold: 0.15 },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ${
        visible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function AnimatedCounter({
  target,
  suffix = "",
  prefix = "",
  duration = 2000,
}: {
  target: number;
  suffix?: string;
  prefix?: string;
  duration?: number;
}) {
  const [count, setCount] = useState(0);
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setStarted(true);
      },
      { threshold: 0.5 },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!started) return;
    const startTime = Date.now();
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * target));
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [started, target, duration]);

  return (
    <span ref={ref}>
      {prefix}
      {count.toLocaleString()}
      {suffix}
    </span>
  );
}
