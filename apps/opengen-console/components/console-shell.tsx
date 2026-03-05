interface ConsoleShellProps {
  title: string;
  children: React.ReactNode;
}

const navItems = [
  { name: "Overview", href: "/" },
  { name: "Generate", href: "/generate" },
  { name: "Tasks", href: "/tasks" },
  { name: "Settings", href: "/settings" },
] as const;

export function ConsoleShell({ title, children }: ConsoleShellProps) {
  return (
    <div className="console-shell">
      <header className="console-header">
        <div className="console-brand">OpenGen Console</div>
      </header>
      <div className="console-body">
        <aside className="console-sidebar" aria-label="Primary">
          <nav>
            {navItems.map((item) => (
              <a key={item.href} href={item.href} className="console-nav-link">
                {item.name}
              </a>
            ))}
          </nav>
        </aside>
        <main className="console-main">
          <h1 className="console-title">{title}</h1>
          <section className="console-content">{children}</section>
        </main>
      </div>
    </div>
  );
}
