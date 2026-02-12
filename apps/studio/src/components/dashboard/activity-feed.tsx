"use client";

import { useEffect, useState, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { motion, AnimatePresence } from "framer-motion";

interface LogEntry {
  id: string;
  action: "READ" | "GLOB" | "TASK" | "WRITE" | "BASH";
  content: string;
  meta?: string;
  timestamp: number;
}

interface ActivityFeedProps {
  agentId: string;
}

export function ActivityFeed({ agentId }: ActivityFeedProps) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", agentId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.event === "agent:event") {
          const evt = data.payload;
          let entry: Partial<LogEntry> | null = null;

          if (evt.stream === 'tool') {
            const toolCall = evt.data?.call;
            const toolResult = evt.data?.result;

            if (toolCall) {
              const name = toolCall.name;
              const args = typeof toolCall.arguments === 'string' ? JSON.parse(toolCall.arguments) : toolCall.arguments;

              if (name === 'read') {
                entry = { action: 'READ', content: args.path || args.file };
              } else if (name === 'exec') {
                const cmd = args.command || "";
                if (cmd.includes('ls') || cmd.includes('find') || cmd.includes('glob')) {
                  entry = { action: 'GLOB', content: cmd };
                } else {
                  entry = { action: 'BASH', content: cmd };
                }
              } else if (name === 'write' || name.includes('generate')) {
                entry = { action: 'WRITE', content: args.path || args.filename || args.file };
              }
            }

            if (toolResult && !entry) {
                // If it's a result of a tool we are tracking, we can add meta info
                // But simplified for now: we track by call.
            }
          } else if (evt.stream === 'lifecycle' && evt.data?.phase === 'status_update') {
              // Handle our custom report_step tool output if streamed as status_update
              // Or if we specifically handle the report_step tool call.
          }
        }

        // Handle specific 'log' events from our report_step script
        if (data.event === "log") {
            try {
                const logData = JSON.parse(data.payload);
                if (logData.type === 'status_update') {
                    setEntries(prev => [{
                        id: Math.random().toString(36).substr(2, 9),
                        action: logData.action,
                        content: logData.description,
                        meta: logData.details,
                        timestamp: logData.timestamp
                    }, ...prev]);
                }
            } catch (e) {
                // Not a JSON log, ignore
            }
        }

        if (entry) {
          setEntries(prev => [{
            id: Math.random().toString(36).substr(2, 9),
            action: entry!.action!,
            content: entry!.content!,
            meta: entry!.meta,
            timestamp: Date.now()
          }, ...prev]);
        }

      } catch (e) {
        console.error("Failed to parse activity event", e);
      }
    };

    return () => ws.close();
  }, [agentId]);

  return (
    <div className="flex flex-col h-full bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden shadow-2xl">
      <div className="px-4 py-2 border-b border-zinc-800 bg-zinc-900/50 flex justify-between items-center">
        <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500 font-mono">Activity Stream</h3>
        <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-red-500/20"></div>
            <div className="w-2 h-2 rounded-full bg-yellow-500/20"></div>
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.8)]"></div>
        </div>
      </div>
      
      <ScrollArea className="flex-1 p-4 font-mono text-sm">
        <div className="space-y-3">
          <AnimatePresence initial={false}>
            {entries.map((entry) => (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="group flex items-start gap-3"
              >
                <div className="mt-1.5 w-2 h-2 rounded-full bg-green-500 shadow-[0_0_5px_rgba(34,197,94,0.5)] shrink-0" />
                <div className="flex flex-col min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-bold text-zinc-100 min-w-[45px]">{entry.action}</span>
                    <span className="text-zinc-300 truncate">{entry.content}</span>
                  </div>
                  {entry.meta && (
                    <span className="text-xs text-zinc-500 truncate pl-0 mt-0.5">
                      {entry.meta}
                    </span>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {entries.length === 0 && (
            <div className="text-zinc-700 italic text-xs py-10 text-center">
              Awaiting transmission...
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
