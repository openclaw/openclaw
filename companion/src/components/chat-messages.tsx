import { useEffect, useRef, useMemo } from "react";
import type { ChatMessage, MessagePart, ToolCallPart, ToolResultPart } from "@/hooks/use-gateway";
import { StreamingDots } from "./streaming-dots";
import { ToolCallCard } from "./tool-call-card";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

type Props = {
  messages: ChatMessage[];
  stream: string | null;
  streamParts: MessagePart[];
  busy: boolean;
};

function buildToolResultMap(parts: MessagePart[]): Map<string, ToolResultPart> {
  const map = new Map<string, ToolResultPart>();
  for (const p of parts) {
    if (p.type === "toolResult") map.set(p.toolCallId, p);
  }
  return map;
}

function AssistantMessage({
  parts,
  isAnimating,
  resultMap,
}: {
  parts: MessagePart[];
  isAnimating: boolean;
  resultMap: Map<string, ToolResultPart>;
}) {
  return (
    <>
      {parts.map((part, i) => {
        if (part.type === "text" && part.text) {
          return (
            <Streamdown key={i} plugins={{ code }} isAnimating={isAnimating} linkSafety={{ enabled: false }}>
              {part.text}
            </Streamdown>
          );
        }
        if (part.type === "toolCall") {
          return (
            <ToolCallCard
              key={part.toolCallId || i}
              toolCall={part as ToolCallPart}
              toolResult={resultMap.get(part.toolCallId)}
            />
          );
        }
        return null;
      })}
    </>
  );
}

export function ChatMessages({ messages, stream, streamParts, busy }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  const globalResultMap = useMemo(() => {
    const allParts = messages.flatMap((m) => m.parts).concat(streamParts);
    return buildToolResultMap(allParts);
  }, [messages, streamParts]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: mounted.current ? "smooth" : "instant" });
    mounted.current = true;
  }, [messages, stream]);

  return (
    <div className="flex-1 overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%-16px),transparent)]">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-0 px-6">
        {messages.filter((m) => m.role === "user" || m.text || m.parts.some((p) => p.type === "text" || p.type === "toolCall")).map((m, i, arr) => {
          const prevRole = i > 0 ? arr[i - 1].role : null;
          return (m.role === "user" ? (
            <div key={i} className={`flex justify-end ${prevRole === "user" ? "py-1" : "py-3"}`}>
              <div className="max-w-[80%] rounded-3xl rounded-br-[4px] bg-card px-4 py-3 shadow-[var(--shadow-soft)] overflow-hidden">
                <p className="whitespace-pre-wrap break-words overflow-hidden leading-relaxed">
                  {m.text}
                </p>
              </div>
            </div>
          ) : (
            <div key={i} className={m.parts.some((p) => p.type === "text" && p.text) ? "py-3" : "pt-1"}>
              {m.parts.length > 0 && m.parts.some((p) => p.type !== "text" || p.text) ? (
                <AssistantMessage parts={m.parts} isAnimating={false} resultMap={globalResultMap} />
              ) : (
                <Streamdown plugins={{ code }} isAnimating={false} linkSafety={{ enabled: false }}>
                  {m.text}
                </Streamdown>
              )}
            </div>
          ));
        })}
        {stream !== null && (stream || streamParts.length > 0) && (
          <div className="pt-6">
            {streamParts.length > 0 && streamParts.some((p) => p.type !== "text") ? (
              <AssistantMessage parts={streamParts} isAnimating={true} resultMap={globalResultMap} />
            ) : (
              <Streamdown plugins={{ code }} isAnimating={true} linkSafety={{ enabled: false }}>
                {stream}
              </Streamdown>
            )}
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
