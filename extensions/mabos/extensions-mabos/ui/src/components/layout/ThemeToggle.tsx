import { Sun, Moon } from "lucide-react";
import { useState, useEffect } from "react";

export function ThemeToggle({ iconOnly }: { iconOnly?: boolean }) {
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("mabos-theme");
    if (stored) return stored === "dark";
    return document.documentElement.classList.contains("dark");
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("mabos-theme", dark ? "dark" : "light");
  }, [dark]);

  if (iconOnly) {
    return (
      <button
        onClick={() => setDark((d) => !d)}
        className="flex items-center justify-center w-10 h-10 mx-auto rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors"
        aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      >
        {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
      </button>
    );
  }

  return (
    <button
      onClick={() => setDark((d) => !d)}
      className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm transition-colors text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? (
        <Sun className="w-4 h-4 flex-shrink-0" />
      ) : (
        <Moon className="w-4 h-4 flex-shrink-0" />
      )}
      <span>{dark ? "Light Mode" : "Dark Mode"}</span>
    </button>
  );
}
