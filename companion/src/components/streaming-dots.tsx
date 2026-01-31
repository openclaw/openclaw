export function StreamingDots() {
  return (
    <div className="flex items-center gap-1 h-[1.5rem]">
      <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:0ms]" />
      <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:150ms]" />
      <span className="size-1.5 rounded-full bg-muted-foreground/40 animate-pulse [animation-delay:300ms]" />
    </div>
  );
}
