import { useState, useEffect } from "react";

export function LiveClock() {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(new Date());
      id = setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    id = setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => clearTimeout(id);
  }, []);

  return (
    <time className="text-sm tabular-nums text-muted-foreground whitespace-nowrap">
      {now
        .toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
        .replace(",", "")}{" "}
      {now.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      })}
    </time>
  );
}
