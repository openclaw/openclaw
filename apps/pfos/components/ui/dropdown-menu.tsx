import * as React from "react";
import { cn } from "@/lib/utils";

type CtxType = { open: boolean; setOpen: (v: boolean) => void };
const Ctx = React.createContext<CtxType | null>(null);

export function DropdownMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return <Ctx.Provider value={{ open, setOpen }}>{children}</Ctx.Provider>;
}

export function DropdownMenuTrigger({ asChild, children }: { asChild?: boolean; children: React.ReactElement }) {
  const ctx = React.useContext(Ctx);
  if (!ctx) return children;
  const onClick = () => ctx.setOpen(!ctx.open);
  if (asChild) return React.cloneElement(children, { onClick } as { onClick: () => void });
  return <button onClick={onClick}>{children}</button>;
}

export function DropdownMenuContent({
  children,
  align,
  className,
}: {
  children: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const ctx = React.useContext(Ctx);
  if (!ctx?.open) return null;
  return (
    <div
      className={cn(
        "absolute z-50 mt-2 min-w-[180px] rounded-xl border border-white/10 bg-slate-950/95 p-1 shadow-xl",
        align === "end" ? "right-0" : "left-0",
        className
      )}
    >
      {children}
    </div>
  );
}

export function DropdownMenuItem({
  children,
  className,
  onClick,
}: React.HTMLAttributes<HTMLButtonElement> & { onClick?: () => void }) {
  const ctx = React.useContext(Ctx);
  return (
    <button
      className={cn("block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/10", className)}
      onClick={() => {
        onClick?.();
        ctx?.setOpen(false);
      }}
    >
      {children}
    </button>
  );
}

export function DropdownMenuSeparator() {
  return <div className="my-1 h-px bg-white/10" />;
}
