import { useEffect, useRef } from "react";
import type { ChatMessage } from "@/hooks/use-gateway";
import { StreamingDots } from "./streaming-dots";

type Props = {
  messages: ChatMessage[];
  stream: string | null;
  busy: boolean;
};

export function ChatMessages({ messages, stream, busy }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, stream]);

  return (
    <div className="flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_48px,black_calc(100%-24px),transparent)]">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-0 px-6">
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end pt-6">
              <div className="max-w-[80%] rounded-3xl rounded-br-[4px] bg-card px-4 py-3 shadow-[var(--shadow-soft)] overflow-hidden">
                <p className="whitespace-pre-wrap break-words overflow-hidden leading-relaxed">
                  {m.text}
                </p>
              </div>
            </div>
          ) : (
            <div key={i} className="pt-6">
              <div className="whitespace-pre-wrap leading-relaxed text-foreground">
                {m.text}
              </div>
            </div>
          ),
        )}
        {stream !== null && (
          <div className="pt-6">
            <div className="whitespace-pre-wrap leading-relaxed text-foreground">
              {stream}
            </div>
          </div>
        )}
        {busy && stream === null && (
          <div className="pt-6">
            <StreamingDots />
          </div>
        )}
        <div ref={bottomRef} className="pb-6" />
      </div>
    </div>
  );
}
