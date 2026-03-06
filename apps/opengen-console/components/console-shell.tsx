interface ConsoleShellProps {
  title: string;
  children: React.ReactNode;
}

const navItems = [
  { name: "总览", href: "/" },
  { name: "生成", href: "/generate" },
  { name: "任务", href: "/tasks" },
  { name: "设置", href: "/settings" },
] as const;

export function ConsoleShell({ title, children }: ConsoleShellProps) {
  return (
    <div className="console-shell">
      <header className="console-header">
        <div className="console-brand">OpenGen 控制台</div>
      </header>
      <div className="console-body">
        <aside className="console-sidebar" aria-label="主导航">
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
