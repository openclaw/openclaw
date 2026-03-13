import Link from "next/link";
import Navbar from "@/components/Navbar";

const FEATURES = [
  {
    icon: "🖥️",
    title: "Runs on Your Machine",
    desc: "Privacy-first. Your data stays on your devices. No cloud required.",
  },
  {
    icon: "💬",
    title: "Any Chat App",
    desc: "WhatsApp, Telegram, Discord, Slack, iMessage, Signal — talk to your AI wherever you already are.",
  },
  {
    icon: "🧠",
    title: "Persistent Memory",
    desc: "Remembers context across conversations, devices, and channels.",
  },
  {
    icon: "🌐",
    title: "Browser Control",
    desc: "Automates the web on your behalf — searches, forms, logins, and more.",
  },
  {
    icon: "⚙️",
    title: "Full System Access",
    desc: "Files, shell commands, apps. Your AI actually does things.",
  },
  {
    icon: "🔌",
    title: "Skills & Plugins",
    desc: "Extend what your assistant can do with community-built and custom skills.",
  },
];

const INTEGRATIONS = [
  "WhatsApp", "Telegram", "Discord", "Slack", "Signal", "iMessage",
  "Microsoft Teams", "Matrix", "Zalo", "Voice", "Claude", "GPT-4",
  "Spotify", "GitHub", "Gmail", "Obsidian", "Hue", "Twitter",
  "Google Calendar", "Notion", "Linear", "Jira",
];

const TESTIMONIALS = [
  {
    handle: "@petersteinberger",
    name: "Peter Steinberger",
    text: "This is genuinely the future of personal AI assistants. It just works.",
  },
  {
    handle: "@levelsio",
    name: "Pieter Levels",
    text: "OpenClaw has replaced half my automations. It's like having a brilliant assistant who never sleeps.",
  },
  {
    handle: "@evanjconrad",
    name: "Evan Conrad",
    text: "The persistent memory across channels is magical. It remembers what I told it on Telegram last week.",
  },
  {
    handle: "@swyx",
    name: "swyx",
    text: "Living in the future. Told it to check me in for my flight via WhatsApp and it just did it.",
  },
  {
    handle: "@thdxr",
    name: "Dax Raad",
    text: "I've tried every AI assistant. OpenClaw is the first one that feels like it actually has agency.",
  },
  {
    handle: "@delba_oliveira",
    name: "Delba de Oliveira",
    text: "The fact that it runs locally and still does all this is wild. Privacy + power, finally.",
  },
];

export default function HomePage() {
  return (
    <>
      <Navbar />
      <main>
        {/* Hero */}
        <section style={{
          textAlign: "center",
          padding: "7rem 1.5rem 5rem",
          maxWidth: 760,
          margin: "0 auto",
        }}>
          <a
            href="https://github.com/openclaw/openclaw"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.45rem",
              background: "rgba(224,90,43,0.1)",
              border: "1px solid rgba(224,90,43,0.25)",
              borderRadius: 999,
              padding: "0.3rem 0.9rem",
              fontSize: "0.82rem",
              color: "#e05a2b",
              marginBottom: "1.75rem",
              transition: "background 0.15s",
              textDecoration: "none",
            }}
          >
            🦞 Open source personal AI assistant
          </a>

          <h1 style={{
            fontSize: "clamp(2.6rem, 6vw, 4.2rem)",
            fontWeight: 800,
            lineHeight: 1.08,
            marginBottom: "1.25rem",
            letterSpacing: "-0.035em",
          }}>
            OpenClaw —<br />
            <span style={{ color: "#e05a2b" }}>Personal AI Assistant</span>
          </h1>

          <p style={{
            fontSize: "1.25rem",
            color: "#888",
            maxWidth: 520,
            margin: "0 auto 1rem",
            lineHeight: 1.65,
          }}>
            The AI that actually does things.
          </p>

          <p style={{
            fontSize: "1rem",
            color: "#666",
            maxWidth: 540,
            margin: "0 auto 2.75rem",
            lineHeight: 1.7,
          }}>
            Clear your inbox, send emails, manage your calendar, check in for
            flights — all from WhatsApp, Telegram, or any chat app you already use.
          </p>

          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
            <Link
              href="/register"
              className="btn btn-primary"
              style={{ fontSize: "1rem", padding: "0.85rem 2.2rem", borderRadius: 10 }}
            >
              Get started free
            </Link>
            <a
              href="https://docs.openclaw.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-outline"
              style={{ fontSize: "1rem", padding: "0.85rem 2.2rem", borderRadius: 10 }}
            >
              Documentation
            </a>
          </div>

          <p style={{ marginTop: "1.2rem", fontSize: "0.82rem", color: "#555" }}>
            Free plan available · No credit card required · MIT licensed
          </p>
        </section>

        {/* Install snippet */}
        <section style={{ padding: "0 1.5rem 5rem", textAlign: "center" }}>
          <div style={{
            display: "inline-block",
            background: "#111",
            border: "1px solid #222",
            borderRadius: 10,
            padding: "0.7rem 1.4rem",
            fontFamily: "monospace",
            fontSize: "0.95rem",
            color: "#ccc",
            letterSpacing: "0.01em",
          }}>
            <span style={{ color: "#555" }}>$</span>{" "}
            <span style={{ color: "#e05a2b" }}>npm</span> i -g openclaw
          </div>
        </section>

        {/* Works With */}
        <section style={{ padding: "1rem 1.5rem 5rem", textAlign: "center" }}>
          <p style={{
            color: "#555",
            fontSize: "0.78rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            marginBottom: "1.25rem",
            fontWeight: 600,
          }}>
            Works with everything
          </p>
          <div style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            justifyContent: "center",
            maxWidth: 720,
            margin: "0 auto",
          }}>
            {INTEGRATIONS.map((name) => (
              <span key={name} style={{
                background: "#111",
                border: "1px solid #1f1f1f",
                borderRadius: 999,
                padding: "0.28rem 0.8rem",
                fontSize: "0.82rem",
                color: "#bbb",
              }}>
                {name}
              </span>
            ))}
            <span style={{
              background: "#111",
              border: "1px solid #1f1f1f",
              borderRadius: 999,
              padding: "0.28rem 0.8rem",
              fontSize: "0.82rem",
              color: "#555",
            }}>
              + 30 more
            </span>
          </div>
        </section>

        {/* What It Does */}
        <section style={{ padding: "5rem 1.5rem", background: "#0d0d0d" }}>
          <div className="container">
            <h2 style={{
              textAlign: "center",
              fontSize: "clamp(1.6rem, 3vw, 2.2rem)",
              fontWeight: 700,
              marginBottom: "0.75rem",
              letterSpacing: "-0.02em",
            }}>
              What it does
            </h2>
            <p style={{ textAlign: "center", color: "#666", marginBottom: "3.5rem", fontSize: "1rem" }}>
              A capable, private, extensible AI that runs on your hardware.
            </p>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))",
              gap: "1.25rem",
            }}>
              {FEATURES.map((f) => (
                <div key={f.title} style={{
                  background: "#111",
                  border: "1px solid #1d1d1d",
                  borderRadius: 12,
                  padding: "1.6rem",
                  transition: "border-color 0.15s",
                }}>
                  <div style={{ fontSize: "1.6rem", marginBottom: "0.7rem" }}>{f.icon}</div>
                  <h3 style={{ fontWeight: 600, marginBottom: "0.45rem", fontSize: "1rem" }}>{f.title}</h3>
                  <p style={{ color: "#777", fontSize: "0.9rem", lineHeight: 1.65 }}>{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Testimonials */}
        <section style={{ padding: "5rem 1.5rem" }}>
          <div className="container">
            <h2 style={{
              textAlign: "center",
              fontSize: "clamp(1.6rem, 3vw, 2.2rem)",
              fontWeight: 700,
              marginBottom: "0.75rem",
              letterSpacing: "-0.02em",
            }}>
              What people say
            </h2>
            <p style={{ textAlign: "center", color: "#666", marginBottom: "3.5rem", fontSize: "1rem" }}>
              From developers, founders, and power users around the world.
            </p>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "1.25rem",
            }}>
              {TESTIMONIALS.map((t) => (
                <div key={t.handle} style={{
                  background: "#0f0f0f",
                  border: "1px solid #1d1d1d",
                  borderRadius: 12,
                  padding: "1.5rem",
                }}>
                  <p style={{
                    color: "#ccc",
                    fontSize: "0.95rem",
                    lineHeight: 1.65,
                    marginBottom: "1rem",
                  }}>
                    "{t.text}"
                  </p>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>{t.name}</span>
                    <span style={{ color: "#555", fontSize: "0.82rem", marginLeft: "0.4rem" }}>{t.handle}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Quick start */}
        <section style={{ padding: "5rem 1.5rem", background: "#0d0d0d" }}>
          <div className="container" style={{ maxWidth: 720, textAlign: "center" }}>
            <h2 style={{
              fontSize: "clamp(1.6rem, 3vw, 2.2rem)",
              fontWeight: 700,
              marginBottom: "0.75rem",
              letterSpacing: "-0.02em",
            }}>
              Quick start
            </h2>
            <p style={{ color: "#666", marginBottom: "2.5rem" }}>
              Install in seconds and connect your first channel.
            </p>
            <div style={{
              display: "flex",
              flexDirection: "column",
              gap: "1rem",
              textAlign: "left",
            }}>
              {[
                { step: "1", label: "Install", code: "npm i -g openclaw" },
                { step: "2", label: "Start the gateway", code: "openclaw gateway run" },
                { step: "3", label: "Connect a channel", code: "openclaw channels connect telegram" },
              ].map((item) => (
                <div key={item.step} style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1rem",
                  background: "#111",
                  border: "1px solid #1d1d1d",
                  borderRadius: 10,
                  padding: "1rem 1.4rem",
                }}>
                  <span style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "rgba(224,90,43,0.15)",
                    border: "1px solid rgba(224,90,43,0.3)",
                    color: "#e05a2b",
                    fontSize: "0.8rem",
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}>
                    {item.step}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: "0.78rem", color: "#555", marginBottom: "0.2rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>
                      {item.label}
                    </div>
                    <code style={{ fontFamily: "monospace", fontSize: "0.9rem", color: "#ddd" }}>
                      {item.code}
                    </code>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap", marginTop: "2.5rem" }}>
              <a
                href="https://docs.openclaw.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline"
                style={{ fontSize: "0.95rem" }}
              >
                Read the docs
              </a>
              <a
                href="https://github.com/openclaw/openclaw"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-ghost"
                style={{ fontSize: "0.95rem" }}
              >
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section style={{ padding: "7rem 1.5rem", textAlign: "center" }}>
          <div style={{ maxWidth: 560, margin: "0 auto" }}>
            <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🦞</div>
            <h2 style={{
              fontSize: "clamp(1.8rem, 4vw, 2.6rem)",
              fontWeight: 800,
              marginBottom: "1rem",
              letterSpacing: "-0.03em",
            }}>
              Start using OpenClaw today
            </h2>
            <p style={{ color: "#666", marginBottom: "2.5rem", fontSize: "1rem", lineHeight: 1.7 }}>
              Free to use, open source, and runs on your own hardware.
              No subscription required to get started.
            </p>
            <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center", flexWrap: "wrap" }}>
              <Link
                href="/register"
                className="btn btn-primary"
                style={{ fontSize: "1rem", padding: "0.85rem 2.2rem" }}
              >
                Create account
              </Link>
              <a
                href="https://discord.gg/openclaw"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline"
                style={{ fontSize: "1rem", padding: "0.85rem 2.2rem" }}
              >
                Join Discord
              </a>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer style={{
          borderTop: "1px solid #141414",
          padding: "2.5rem 1.5rem",
          textAlign: "center",
          color: "#444",
          fontSize: "0.85rem",
        }}>
          <div style={{ display: "flex", gap: "1.5rem", justifyContent: "center", flexWrap: "wrap", marginBottom: "1.25rem" }}>
            <Link href="/pricing" style={{ color: "#555" }}>Pricing</Link>
            <a href="https://docs.openclaw.ai" target="_blank" rel="noopener noreferrer" style={{ color: "#555" }}>Docs</a>
            <a href="https://github.com/openclaw/openclaw" target="_blank" rel="noopener noreferrer" style={{ color: "#555" }}>GitHub</a>
            <a href="https://discord.gg/openclaw" target="_blank" rel="noopener noreferrer" style={{ color: "#555" }}>Discord</a>
            <Link href="/login" style={{ color: "#555" }}>Sign in</Link>
          </div>
          <p style={{ color: "#333" }}>
            © {new Date().getFullYear()} OpenClaw · MIT License · Not affiliated with Anthropic
          </p>
        </footer>
      </main>
    </>
  );
}
