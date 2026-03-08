"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Settings2,
  Bot,
  MessageSquare,
  FileText,
  Radio,
  Brain,
  Code2,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/ops", label: "Ops", icon: Settings2 },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/content", label: "Content", icon: FileText },
  { href: "/comms", label: "Comms", icon: Radio },
  { href: "/knowledge", label: "Knowledge", icon: Brain },
  { href: "/code", label: "Code", icon: Code2 },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 h-12 border-b border-white/[0.06] bg-background/80 backdrop-blur-xl">
      <div className="flex h-full items-center px-2">
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-1.5 px-2 shrink-0"
        >
          <div className="w-5 h-5 rounded-md bg-primary/20 flex items-center justify-center">
            <span className="text-primary text-[10px] font-bold">OC</span>
          </div>
          <span className="hidden md:inline text-xs font-semibold text-foreground/80">
            OpenClaw
          </span>
        </Link>

        {/* Nav items */}
        <div className="flex flex-1 items-center gap-0.5 ml-1">
          {navItems.map((item) => {
            const isActive =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-lg transition-colors",
                  "nav-text font-medium",
                  isActive
                    ? "text-primary bg-primary/[0.06]"
                    : "text-muted-foreground hover:text-foreground hover:bg-white/[0.03]"
                )}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </div>

        {/* Live indicator */}
        <div className="flex items-center gap-1.5 px-2.5 shrink-0">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
          <span className="text-[9px] font-mono text-muted-foreground tracking-wider hidden sm:inline">
            AUTO 15S
          </span>
        </div>
      </div>
    </nav>
  );
}
